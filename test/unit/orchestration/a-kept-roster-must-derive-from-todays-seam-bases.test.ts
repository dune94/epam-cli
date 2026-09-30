/**
 * A KEPT ROSTER MUST DERIVE FROM TODAY'S SEAM BASES — OR IT IS CLEARED, NOT KEPT.
 *
 * Operator, 2026-09-30: "Why would the project level SI not exist? It cannot fail." — and the
 * decision "re-derive stale rosters". Every call resolves its standing instructions from the
 * project roster once one exists (lib/agent-si.js), keyed by seam. pre-run-reset KEEPS the roster
 * on a resume and when the codeline decision is deferred to the mint (EPAM_CODELINE_ID unset — the
 * usual live case). A roster written before the seam convergence is agent-named and holds no seam
 * key, so every seam call before the roster stage would find no SI. The roster stage re-derives
 * the roster on every launch (mint-agents-step runRosterStage), so a kept roster that does not
 * derive from the current seam bases is cleared here and the pre-roster seams read the registry
 * base, exactly as on a first run.
 *
 * EXECUTED: the real pre-run-reset.sh. The old-shape roster is a real past run's output (the one
 * committed for a project in this repository); the current one is built by the real roster library
 * from the real registry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rosterLib = require(join(LIB, 'project-roster.js'));
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles;
const SEAMS = Object.keys(reg).filter((s) => reg[s].si);

/** A committed project roster missing today's seam keys — a real run's output from before the convergence. */
function oldShapeRoster(): string {
  const projects = join(ROOT, 'orchestrations/projects');
  for (const p of readdirSync(projects)) {
    const f = join(projects, p, 'roster.json');
    if (!existsSync(f)) continue;
    const agents = (JSON.parse(readFileSync(f, 'utf8')) || {}).agents || {};
    if (Object.keys(agents).length && !SEAMS.every((s) => s in agents)) return readFileSync(f, 'utf8');
  }
  throw new Error('no committed pre-convergence roster found — this test proves nothing without one');
}

const dirs: string[] = [];
let CURRENT = '';
beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), 'kept-roster-')); dirs.push(work);
  const logs = join(work, 'logs'); const proj = join(work, 'proj');
  mkdirSync(logs, { recursive: true }); mkdirSync(proj, { recursive: true });
  const base = rosterLib.seamBaseForRun(REGISTRY, logs);
  const [seam] = SEAMS;
  const produce = async ({ canonicalCopyPath, outPath }: any) => {
    const c = JSON.parse(readFileSync(canonicalCopyPath, 'utf8'));
    writeFileSync(outPath, JSON.stringify({ agents: { [seam]: { persona: `[project] ${c[seam]}` } } }));
  };
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = proj;
  try {
    await rosterLib.buildProjectRoster({ canonicalPath: base, logDir: logs, projectConfigDir: proj,
      produce, review: async () => ({ verdict: 'approved' }), attempts: 1, log: () => {} });
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
  }
  CURRENT = readFileSync(join(proj, 'roster.json'), 'utf8');
});
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the real reset with `roster` on disk; return what is left, and the reset's output. */
function reset(roster: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'kept-roster-run-')); dirs.push(dir);
  const logDir = join(dir, 'logs'); const proj = join(dir, 'proj'); const agentsDir = join(dir, 'agents');
  for (const d of [logDir, proj, agentsDir]) mkdirSync(d, { recursive: true });
  // The reset restores agents/profiles.json from its .original: pointed at the fixture, never the repo's.
  writeFileSync(join(agentsDir, 'profiles.json.original'), '{}');
  writeFileSync(join(agentsDir, 'profiles.json'), '{}');
  writeFileSync(join(proj, 'roster.json'), roster);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { name: 'x' }, stories: [] }));
  const res = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
    encoding: 'utf8', timeout: 240000,
    env: { ...process.env, EPAM_AGENTS_DIR: agentsDir, EPAM_PROJECT_CONFIG_DIR: proj, EPAM_CODELINE_ID: '', NODE_BIN: process.execPath, ...env },
  });
  const f = join(proj, 'roster.json');
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, left: existsSync(f) ? readFileSync(f, 'utf8') : null };
}

describe('a kept roster must derive from today\'s seam bases', () => {
  it('the fixtures are what they claim: one roster current, one of the old shape', () => {
    expect(rosterLib.checkRoster(JSON.parse(CURRENT), JSON.parse(readFileSync(rosterLib.seamBaseForRun(REGISTRY, dirs[0]), 'utf8'))).ok).toBe(true);
    expect(SEAMS.every((s) => s in JSON.parse(oldShapeRoster()).agents)).toBe(false);
  });

  for (const [mode, env] of [['a resume', { EPAM_RESUME_RUN: 'a-previous-run' }], ['a deferred codeline decision', {}]] as const) {
    it(`${mode}: an old-shape roster is CLEARED, not kept`, () => {
      const r = reset(oldShapeRoster(), env);
      expect(r.status, r.out.slice(-1500)).toBe(0);
      expect(r.left, 'a roster missing seam keys survived into the run — every seam call before the roster stage finds no SI').toBeNull();
    }, 300_000);

    it(`${mode}: a roster derived from today's seam bases is KEPT, byte for byte`, () => {
      const r = reset(CURRENT, env);
      expect(r.status, r.out.slice(-1500)).toBe(0);
      expect(r.left).toBe(CURRENT);
    }, 300_000);
  }
});
