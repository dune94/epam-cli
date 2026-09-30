/**
 * AN IN-RUN AMENDMENT REACHES THE AGENT'S SI — ONE WRITER, ONE READER.
 *
 * Operator, 2026-09-30: "Self heal MUST work", and — asked where identity amendments go under one
 * path — yes to the project roster. Agents that teach another agent a skill mid-run (the pre-phase
 * skill assessor, profile-augmentor, skills-coordinator, post-failure-analyst) wrote into
 * profiles.json, which since the SI convergence no agent's SI is read from: every addition was written
 * and never delivered. The one applier (lib/roster-amend.js) writes into the roster entry the SI
 * resolver reads (lib/agent-si.js), under a marked section; the roster is re-derived at every fresh
 * launch, so nothing lingers across runs.
 *
 * EXECUTED: the real roster library builds the roster from the real registry; the real applier
 * amends it; the real resolver CLI (what the hub runs) produces the SI that is asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rosterLib = require(join(LIB, 'project-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam } = require(join(LIB, 'seam-invocation.js'));
const REG = JSON.parse(readFileSync(REGISTRY, 'utf8'));
// A declared name the RESOLVER maps to a seam with an si without being it — so the alias case always
// runs, on the mapping the applier itself uses.
const seamOfName = (n: string) => { try { return resolveSeam(n, REGISTRY, { ignoreXref: true }) as string; } catch { return ''; } };
const ALIAS = Object.keys(REG.agentSeams || {}).find((n) => { const x = seamOfName(n); return x && x !== n && REG.profiles[x] && REG.profiles[x].si; }) as string;
const SEAM = seamOfName(ALIAS);
const OTHER = Object.keys(REG.profiles).find((x) => x !== SEAM && REG.profiles[x].si) as string;

const work = mkdtempSync(join(tmpdir(), 'roster-amend-'));
const proj = join(work, 'proj');
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeAll(async () => {
  const logs = join(work, 'logs'); mkdirSync(logs, { recursive: true }); mkdirSync(proj, { recursive: true });
  const base = rosterLib.seamBaseForRun(REGISTRY, logs);
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = proj;
  try {
    await rosterLib.buildProjectRoster({ canonicalPath: base, logDir: logs, projectConfigDir: proj,
      produce: async ({ outPath }: any) => writeFileSync(outPath, JSON.stringify({ agents: {} })),
      review: async () => ({ verdict: 'approved' }), attempts: 1, log: () => {} });
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
  }
});

const amend = (agent: string, text: string) => spawnSync(process.execPath, [join(LIB, 'roster-amend.js'), agent, 'test-source', text],
  { encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: proj } });
function siOf(agent: string): string {
  const out = join(work, `si-${agent}`);
  const r = spawnSync(process.execPath, [join(LIB, 'agent-si.js'), agent, proj, out], { encoding: 'utf8', env: { ...process.env, EPAM_SEAM: '', PROJECT_ROOT: '' } });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(out, 'utf8');
}

describe('an in-run amendment reaches the agent\'s SI', () => {
  it('the addition is in the target agent\'s SI on its next call — and in no other agent\'s', () => {
    const r = amend(SEAM, 'Always run the codeline\'s declared formatter before finishing.');
    expect(r.status, r.stderr).toBe(0);
    expect(siOf(SEAM)).toContain('Always run the codeline\'s declared formatter before finishing.');
    expect(siOf(OTHER)).not.toContain('Always run the codeline\'s declared formatter before finishing.');
  });

  it('the base SI is untouched — the addition is appended under a marked section', () => {
    const si = siOf(SEAM);
    expect(si.startsWith(REG.profiles[SEAM].si)).toBe(true);
    expect(si.indexOf('Always run the codeline')).toBeGreaterThan(REG.profiles[SEAM].si.length);
  });

  it('the same addition twice is recorded once', () => {
    amend(SEAM, 'Always run the codeline\'s declared formatter before finishing.');
    expect(siOf(SEAM).split('Always run the codeline\'s declared formatter before finishing.').length - 1).toBe(1);
  });

  it('the roster stays valid: its entries still derive from today\'s seam bases', () => {
    const roster = JSON.parse(readFileSync(join(proj, 'roster.json'), 'utf8'));
    const base = rosterLib.seamBase(REGISTRY);
    expect(rosterLib.checkRoster(roster, base).ok).toBe(true);
  });

  it('an amendment for a name that maps to a seam lands on that seam\'s entry', () => {
    expect(ALIAS, 'the registry declares no alias to prove this with').toBeTruthy();
    expect(resolveSeam(ALIAS, REGISTRY, { ignoreXref: true })).toBe(SEAM);
    const r = amend(ALIAS as string, 'Prefer the codeline\'s existing fixtures over new ones.');
    expect(r.status, r.stderr).toBe(0);
    expect(siOf(SEAM)).toContain('Prefer the codeline\'s existing fixtures over new ones.');
  });

  it('an amendment for a name the roster cannot answer is refused, loudly — nothing is written', () => {
    const before = readFileSync(join(proj, 'roster.json'), 'utf8');
    const r = amend('no-such-agent-anywhere', 'x');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no-such-agent-anywhere/);
    expect(readFileSync(join(proj, 'roster.json'), 'utf8')).toBe(before);
  });
});
