/**
 * THE PARENT AND ITS FIRST LANE RESOLVED THE SAME CONTROL-PLANE PORT.
 *
 * run-agent-orchestration.sh is BOTH the parent orchestrator and, re-invoked with
 * JIRA_CODELINE_RUN=1, each lane. Every per-run resource it allocates is therefore allocated
 * twice, and anything derived only from the PRD resolves identically in both roles.
 *
 * The control-plane port is derived from the codeline whose `outputDirs[].path` matches
 * `project.outputDir`. synthesize-prd-from-jira.js sets `project.outputDir = outputDirs[0].path`
 * (line 336), so the PARENT resolves to codeline index 0 — the very same index the FIRST LANE
 * resolves to from its own filtered PRD, which sets outputDir to that lane's path.
 *
 * That collision is not benign, because start_control_plane does this before binding:
 *
 *     _stale_pid=$(lsof -ti "tcp:${CONTROL_PLANE_PORT}")
 *     kill "$_stale_pid"        # "stale process from a previous run"
 *
 * The first lane therefore KILLS THE PARENT'S CONTROL PLANE and takes the port; when that lane
 * finishes, its cleanup stops the control plane and the port is left dead while the parent
 * still holds a PID it believes is running. The control plane is what serves pause and resume
 * — the mechanism the roster pause depends on.
 *
 * The dashboard watcher next to it already carries the lane guard, added after three lanes
 * raced over one output directory. The control plane did not get one.
 *
 * These tests execute the REAL shell function against PRD fixtures shaped exactly as the
 * synthesizer writes them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real function, lifted out of the orchestrator — never a reimplementation of it. */
function resolverSrc(): string {
  const start = orchSrc.indexOf('_resolve_control_plane_port() {');
  expect(start, 'the port resolver is gone from the orchestrator').toBeGreaterThan(-1);
  return orchSrc.slice(start, orchSrc.indexOf('\n}', start) + 2);
}

const CODELINES = [
  { codeline: 'gotransit', path: '/estate/gotransit' },
  { codeline: 'upexpress', path: '/estate/upexpress' },
  { codeline: 'metrolinx', path: '/estate/metrolinx' },
];

/**
 * @param outputDir what project.outputDir holds. The synthesizer sets it to outputDirs[0].path
 *                  for the parent; _filtered_prd rewrites it to the lane's own path.
 */
function prdFile(outputDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-port-')); dirs.push(dir);
  const p = join(dir, 'prd.json');
  writeFileSync(p, JSON.stringify({
    project: { outputDir, outputDirs: CODELINES },
    stories: [],
  }, null, 2));
  return p;
}

/**
 * The role helpers, lifted from the orchestrator. Extracted code may call is_parent/is_lane —
 * the role is derived in one place at the top of the script, so a harness running a fragment
 * of it has to bring that place along.
 */
function roleHelpersSrc(src: string): string {
  const start = src.indexOf('orch_role() {');
  const endMark = "is_lane() { [ \"$(orch_role)\" = 'lane' ]; }";
  const end = src.indexOf(endMark);
  if (start < 0 || end < 0) throw new Error('role helpers not found in the orchestrator');
  return src.slice(start, end + endMark.length);
}

/** Runs the real resolver with the given environment and returns the port it prints. */
function resolvePort(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-run-')); dirs.push(dir);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\n${roleHelpersSrc(orchSrc)}\n${resolverSrc()}\n_resolve_control_plane_port\n`);
  return execFileSync('bash', [sh], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

describe('the fixture is real', () => {
  it('the resolver runs and returns a port', () => {
    const port = resolvePort({ PRD_FILE: prdFile('/estate/gotransit'), CODELINE_NAME: '' });
    expect(port).toMatch(/^\d+$/);
    expect(Number(port)).toBeGreaterThan(1024);
  });

  it('the synthesizer really does point outputDir at the first codeline', () => {
    // If this stops being true the collision below changes shape, and this test should say so
    // rather than quietly passing for a new reason.
    const syn = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js'), 'utf8');
    expect(syn).toMatch(/project\.outputDir\s*=\s*outputDirs\[0\]\.path/);
  });
});

/** A lane IS a lane by virtue of JIRA_CODELINE_RUN=1 — the flag the re-invocation exports. */
const lanePort = (c: { codeline: string; path: string }) => resolvePort({
  PRD_FILE: prdFile(c.path), CODELINE_NAME: '', JIRA_CODELINE_RUN: '1', EPAM_CODELINE: c.codeline,
});
const parentPort = () => resolvePort({ PRD_FILE: prdFile(CODELINES[0].path), CODELINE_NAME: '' });

describe('each lane gets its own port', () => {
  it('the three lanes resolve three distinct ports', () => {
    const ports = CODELINES.map(lanePort);
    expect(new Set(ports).size, `two lanes share a port: ${ports.join(', ')}`).toBe(3);
  });

  it('a lane identifies itself by EPAM_CODELINE, which is what the re-invocation exports', () => {
    // CODELINE_NAME is read as an override but nothing in the orchestrator ever set it, so
    // every lane used to fall through to the PRD lookup.
    const byEnv = resolvePort({
      PRD_FILE: prdFile(CODELINES[2].path), JIRA_CODELINE_RUN: '1', EPAM_CODELINE: CODELINES[2].codeline,
    });
    expect(byEnv).toBe(lanePort(CODELINES[2]));
  });
});

describe('THE DEFECT: the parent must not share a port with any lane', () => {
  it('the parent does not collide with the first lane', () => {
    // The parent's PRD: outputDir = outputDirs[0].path, exactly as synthesized.
    const parent = parentPort();
    // The first lane's filtered PRD: outputDir rewritten to its own path — the same value.
    const lane = lanePort(CODELINES[0]);

    expect(
      lane,
      'the first lane resolves the parent\'s port, and start_control_plane kills whatever holds ' +
      'it — so the lane kills the parent\'s control plane, which is what serves pause and resume',
    ).not.toBe(parent);
  });

  it('the parent collides with NO lane, not merely with the first', () => {
    const parent = parentPort();
    const lanePorts = CODELINES.map(lanePort);
    expect(lanePorts).not.toContain(parent);
  });

  it('an explicit operator override still wins in both roles', () => {
    // Pinning a port is a documented escape hatch and must not be broken by the fix.
    expect(resolvePort({ PRD_FILE: prdFile(CODELINES[0].path), CONTROL_PLANE_PORT: '9999' })).toBe('9999');
    expect(resolvePort({
      PRD_FILE: prdFile(CODELINES[0].path), CONTROL_PLANE_PORT: '9999', JIRA_CODELINE_RUN: '1',
    })).toBe('9999');
  });
});
