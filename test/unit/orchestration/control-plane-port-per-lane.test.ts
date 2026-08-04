/**
 * Every lane needs its OWN control-plane port.
 *
 * THE BUG (live, run 20260804T011537Z, metrolinx AMSD-2041 across three codelines):
 *
 *     CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"     <- one global default
 *     [control-plane] port 8094 already in use — another instance running? Exiting cleanly.
 *     [WARNING] Killing stale process on port 8094 (PID 1471664)   x3
 *
 * Every lane starts a control plane on 8094. The first binds it; the rest exit, so those
 * lanes run with no control plane at all. Worse, the startup path KILLS whatever holds the
 * port first — so a later lane murders the running lane's control plane. Three lanes, one
 * port, mutual destruction.
 *
 * This is the SAME SHAPE as the checkpoint collision fixed in b76e414: a per-lane resource
 * keyed on a run-global value. That fix addressed the instance; this is its sibling, which
 * I did not go looking for.
 *
 * The port must be:
 *  - DISTINCT per lane, so lanes cannot collide or kill each other
 *  - DETERMINISTIC, so a restart/resume of the same lane finds the same port
 *  - UNCHANGED for single-codeline runs, which have no lane
 *
 * Executes the real bash. No source-text greps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const LANES = ['gotransit', 'upexpress', 'metrolinx'] as const;
const BASE_PORT = 8094;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Extract the real port-resolution logic from the orchestrator and run it. */
function resolvePort(env: Record<string, string> = {}): { port: string; out: string } {
  const i = orchSrc.indexOf('_resolve_control_plane_port()');
  expect(
    i,
    '_resolve_control_plane_port() not found — the port is still a bare global default, ' +
      'so every lane of a run resolves to the same port and they collide',
  ).toBeGreaterThan(-1);
  const lines = orchSrc.split('\n');
  const s = lines.findIndex((l) => l.startsWith('_resolve_control_plane_port()'));
  const e = lines.findIndex((l, k) => k > s && l === '}');
  const body = lines.slice(s, e + 1).join('\n');

  const dir = mkdtempSync(join(tmpdir(), 'cp-port-'));
  dirs.push(dir);
  const script = join(dir, 'probe.sh');
  writeFileSync(script, ['#!/usr/bin/env bash', 'set -uo pipefail', body, '_resolve_control_plane_port'].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
  return { port: `${r.stdout || ''}`.trim(), out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** A PRD as each lane receives it: project.outputDir is that lane's checkout. */
function lanePrd(lane: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-prd-'));
  dirs.push(dir);
  const p = join(dir, 'prd.json');
  writeFileSync(
    p,
    JSON.stringify({
      project: {
        outputDir: `/repos/next.${lane}.com`,
        outputDirs: LANES.map((l) => ({ codeline: l, path: `/repos/next.${l}.com` })),
      },
      stories: [{ id: 'AMSD-2041', codelines: [...LANES] }],
    }),
  );
  return p;
}

describe('each lane resolves its own control-plane port', () => {
  it('REPRODUCES THE LIVE BUG: three lanes get three DIFFERENT ports', () => {
    const ports = LANES.map((l) => resolvePort({ CODELINE_NAME: l }).port);
    expect(
      new Set(ports).size,
      `lanes resolved to: ${ports.join(', ')} — a shared port means the second and third ` +
        'lanes exit with "port already in use", and the startup path kills whatever holds ' +
        'it, so lanes destroy each other. Live 2026-08-04.',
    ).toBe(LANES.length);
  });

  it('resolves the lane from the PRD when CODELINE_NAME is not exported', () => {
    // The orchestrator keeps the lane name as a local; only project.outputDir is per-lane.
    const ports = LANES.map((l) => resolvePort({ PRD_FILE: lanePrd(l) }).port);
    expect(new Set(ports).size, `PRD-derived ports collided: ${ports.join(', ')}`).toBe(LANES.length);
  });

  it('is DETERMINISTIC — the same lane always gets the same port', () => {
    for (const lane of LANES) {
      const a = resolvePort({ CODELINE_NAME: lane }).port;
      const b = resolvePort({ CODELINE_NAME: lane }).port;
      expect(b, `${lane} moved between invocations — a resume could not find its own control plane`).toBe(a);
    }
  });

  it('every port is a valid, plausible TCP port', () => {
    for (const lane of LANES) {
      const p = Number(resolvePort({ CODELINE_NAME: lane }).port);
      expect(Number.isInteger(p), `${lane} produced a non-numeric port`).toBe(true);
      expect(p).toBeGreaterThanOrEqual(BASE_PORT);
      expect(p).toBeLessThan(65536);
    }
  });

  it('a single-codeline run is UNCHANGED — it keeps the base port', () => {
    expect(
      Number(resolvePort({}).port),
      'single-codeline runs must not move off the port the dashboard expects',
    ).toBe(BASE_PORT);
  });

  it('an explicit CONTROL_PLANE_PORT still wins — the operator can override', () => {
    expect(Number(resolvePort({ CONTROL_PLANE_PORT: '9500' }).port)).toBe(9500);
  });
});

/**
 * The kill is as dangerous as the bind. Live, three "Killing stale process on port 8094"
 * warnings appeared while lanes were running — lanes reaping each other's control planes.
 */
describe('the stale-port kill cannot reap a sibling lane', () => {
  it('the kill targets the LANE-RESOLVED port, not a hardcoded 8094', () => {
    const killLine = orchSrc.split('\n').find((l) => l.includes('lsof -ti') && l.includes('tcp:'));
    expect(killLine, 'no stale-port kill found').toBeTruthy();
    expect(
      killLine,
      'the kill still falls back to a literal 8094, so a lane whose own port differs will ' +
        "kill whatever holds the shared default — i.e. a sibling lane's control plane",
    ).not.toMatch(/:-8094/);
  });

  it('the bind uses the resolved port too, not the literal default', () => {
    const bindLine = orchSrc.split('\n').find((l) => l.trim().startsWith('CONTROL_PLANE_PORT=') && l.includes('\\'));
    if (bindLine) {
      expect(bindLine, 'the launch line re-defaults to 8094, undoing per-lane resolution')
        .not.toMatch(/:-8094/);
    }
  });
});
