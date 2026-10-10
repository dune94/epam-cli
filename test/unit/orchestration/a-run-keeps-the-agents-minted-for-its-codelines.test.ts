/**
 * A RUN KEEPS THE AGENTS MINTED FOR ITS CODELINES — and the prompts keyed by them.
 *
 * AMSD-2974 run 6 (2026-10-09) minted and reviewed its agents (roster review: sound) and banked 20 reviewed prompts,
 * then died on the provider's quota before its prompt set completed — so it wrote no completion marker. The next fresh
 * launch over the SAME four codelines would have thrown the agents away and paid to mint them again, and with them the
 * 13 prompts keyed by those agents' names. Operator: "I want agents kept and 20 prompts kept".
 *
 * The roster on disk is this run's when it derives from today's seam bases AND the investigators it minted cover
 * exactly the codelines this run's PRD names. Then the mint is skipped, and the role identity the prompt cache is keyed
 * by is read back from what the mint wrote (project-roles.json, project-investigators.json, the roster's kinds) — never
 * the placeholder that names no role.
 *
 * EXECUTED: the real buildProjectRoster (a current roster), the real keptRosterFor / mintedFromRegistries, and the real
 * _run_agent_mint settle step (lib/mint-and-spec.sh) with only the mint's own invocation recorded instead of run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rosterLib = require(join(LIB, 'project-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rolesIdentity } = require(join(LIB, 'project-prompt-builder.js'));
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles;
const [SEAM] = Object.keys(reg).filter((s) => reg[s].si);

const CODELINES = ['cxshared', 'gotransit', 'upexpress'];
const IMPLEMENTER = 'toast-fixer';
const INVESTIGATORS = Object.fromEntries(CODELINES.map((c) => [c, `${c}-detective`]));
const dirs: string[] = [];
let TEMPLATE = '';   // a project whose roster is current and whose mint recorded its agents

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), 'kept-agents-')); dirs.push(work);
  const logs = join(work, 'logs'); const proj = join(work, 'proj');
  mkdirSync(logs, { recursive: true }); mkdirSync(proj, { recursive: true });
  // What the mint writes for the agents it made.
  writeFileSync(join(proj, 'project-roles.json'), JSON.stringify({ roles: [IMPLEMENTER] }));
  writeFileSync(join(proj, 'project-investigators.json'), JSON.stringify({ investigators: Object.values(INVESTIGATORS), byCodeline: INVESTIGATORS }));
  writeFileSync(join(proj, 'agent-profiles.json'), JSON.stringify({ profiles: Object.fromEntries(
    [IMPLEMENTER, ...Object.values(INVESTIGATORS)].map((n) => [n, `# Role & Purpose\nYou are ${n}.`])) }));
  const base = rosterLib.seamBaseForRun(REGISTRY, logs);
  const produce = async ({ canonicalCopyPath, outPath }: any) => {
    const c = JSON.parse(readFileSync(canonicalCopyPath, 'utf8'));
    writeFileSync(outPath, JSON.stringify({ agents: { [SEAM]: { persona: `[project] ${c[SEAM]}` } } }));
  };
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = proj;
  try {
    await rosterLib.buildProjectRoster({ canonicalPath: base, logDir: logs, projectConfigDir: proj,
      produce, review: async () => ({ verdict: 'approved' }), attempts: 1, log: () => {} });
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
  }
  TEMPLATE = proj;
});
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function copy(prdCodelines: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'kept-run-')); dirs.push(d);
  const proj = join(d, 'proj'); cpSync(TEMPLATE, proj, { recursive: true });
  writeFileSync(join(proj, 'prd.json'), JSON.stringify({ stories: [], project: {
    outputDirs: prdCodelines.map((c) => ({ codeline: c, path: `/codelines/${c}` })) } }));
  return { d, proj, prd: join(proj, 'prd.json') };
}

describe('the roster on disk is this run\'s when it is current and minted for exactly its codelines', () => {
  it('GUARD: the fixture roster is current and carries the minted agents — otherwise nothing below proves anything', () => {
    expect(rosterLib.rosterIsCurrent(join(TEMPLATE, 'roster.json'), REGISTRY).ok).toBe(true);
    expect(rosterLib.mintedFromRegistries(TEMPLATE).map((m: any) => m.name).sort())
      .toEqual([IMPLEMENTER, ...Object.values(INVESTIGATORS)].sort());
  });

  it('the same codelines, listed in any order: kept', () => {
    const c = copy([...CODELINES].reverse());
    expect(rosterLib.keptRosterFor(c.proj, c.prd, REGISTRY).ok).toBe(true);
  });

  it('one codeline more, or one fewer: another run\'s agents — not kept', () => {
    for (const set of [[...CODELINES, 'metrolinx'], CODELINES.slice(1)]) {
      const c = copy(set);
      const v = rosterLib.keptRosterFor(c.proj, c.prd, REGISTRY);
      expect(v.ok, `kept for ${set.join(',')}`).toBe(false);
      expect(v.reason).toMatch(/minted for/);
    }
  });

  it('a roster that is not current for today\'s seam bases: not kept, whatever its codelines', () => {
    const c = copy(CODELINES);
    const r = JSON.parse(readFileSync(join(c.proj, 'roster.json'), 'utf8'));
    delete r.agents[SEAM];
    writeFileSync(join(c.proj, 'roster.json'), JSON.stringify(r));
    expect(rosterLib.keptRosterFor(c.proj, c.prd, REGISTRY).ok).toBe(false);
  });
});

describe('the kept agents\' identity is read back from what the mint wrote', () => {
  it('names from the registries, kinds from the roster — the identity the cache was keyed by', () => {
    const md = rosterLib.mintedFromRegistries(TEMPLATE);
    const lines = md.map((m: any) => `- ${m.name} [${m.kind}] — ${m.rationale}`).join('\n');
    expect(rolesIdentity(lines), 'the derived roles carry no identity').not.toBe('');
    expect(rolesIdentity(lines)).toBe(rolesIdentity(md.map((m: any) => `- ${m.name} [${m.kind}]`).join('\n')));
    for (const m of md) expect(m.kind, `${m.name} has no kind`).toBeTruthy();
  });
});

describe('the mint\'s settle step keeps them and mints nothing', () => {
  function settle(prdCodelines: string[], discovered?: string[]) {
    const c = copy(prdCodelines);
    // What discovery persisted for this run, beside its logs (LOG_DIR), as the ingest leaves it.
    if (discovered) writeFileSync(join(c.d, 'codeline-discovery.json'), JSON.stringify({
      codelines: discovered.map((n) => ({ name: n, path: `/codelines/${n}` })) }));
    mkdirSync(join(c.proj, '.prompt-cache'), { recursive: true });
    writeFileSync(join(c.proj, '.prompt-cache', '.reset-pending'), '');
    mkdirSync(join(c.proj, 'prompts'), { recursive: true });
    writeFileSync(join(c.proj, 'prompts', 'kept-copy.json'), '{}');
    const agents = join(c.d, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'profiles.json'), JSON.stringify({ agents: { [IMPLEMENTER]: { role: 'implementer' } } }));
    const calls = join(c.d, 'calls.txt'); const fake = join(c.d, 'node');
    writeFileSync(fake, `#!/usr/bin/env bash\ncase "$*" in *mint-agents-step.js*) printf '%s ROSTER_ONLY=%s\\n' "$*" "\${EPAM_ROSTER_ONLY:-0}" >> ${JSON.stringify(calls)}; exit 0;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(fake, 0o755);
    const src = readFileSync(join(LIB, 'mint-and-spec.sh'), 'utf8');
    const fn = src.slice(src.indexOf('_run_agent_mint() {'), src.indexOf('\n}\n', src.indexOf('_run_agent_mint() {')) + 3);
    const drive = join(c.d, 'drive.sh');
    writeFileSync(drive, ['set -uo pipefail', 'log(){ printf "%s\\n" "$*"; }', 'error(){ printf "ERR %s\\n" "$*"; }',
      'info(){ :; }', 'warning(){ :; }', 'require_stage_coverage(){ return 0; }', `. ${JSON.stringify(join(LIB, 'prompt-variant.sh'))}`,
      `NODE_BIN=${JSON.stringify(fake)}`, `SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`,
      `EPAM_AGENTS_DIR=${JSON.stringify(agents)}`, `LOG_DIR=${JSON.stringify(c.d)}`, fn,
      `_run_agent_mint ${JSON.stringify(c.prd)} /dev/null || true`].join('\n'));
    const r = spawnSync('bash', [drive], { encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', EPAM_PROJECT_CONFIG_DIR: c.proj } });
    const rec = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { ...c, out: (r.stdout || '') + (r.stderr || ''), mints: rec.filter((l) => !l.includes('ROSTER_ONLY=1')).length };
  }

  it('the same codelines: the roster stays, nothing is minted, installed copies give way to the reviewed cache', () => {
    const s = settle(CODELINES);
    expect(s.out).toMatch(/minted for exactly this run's codelines — kept/);
    expect(existsSync(join(s.proj, 'roster.json')), `the roster was cleared:\n${s.out.slice(-1200)}`).toBe(true);
    expect(s.mints, 'the mint ran for agents this run already has').toBe(0);
    expect(readdirSync(join(s.proj, 'prompts')), 'installed copies would be re-reviewed (paid)').toEqual([]);
  });

  it('AT MINT TIME the PRD names only the first lane — the run\'s codelines are discovery\'s answer: kept', () => {
    // AMSD-2974 run 9 (2026-10-10): the PRD the mint receives lists outputDirs [cxshared] only; the other lanes are added
    // later. Compared with the four codelines the agents were minted for, it re-minted a roster made for this very run.
    const [first] = CODELINES;
    const s = settle([first], CODELINES);
    expect(s.out, s.out.slice(-1200)).toMatch(/minted for exactly this run's codelines — kept/);
    expect(s.mints, 'the mint ran for agents this run already has').toBe(0);
  });

  it('and discovery naming ANOTHER set still clears, even with the PRD\'s first lane matching', () => {
    const [first] = CODELINES;
    const s = settle([first], [...CODELINES, 'metrolinx']);
    expect(existsSync(join(s.proj, 'roster.json')), 'another run\'s roster survived').toBe(false);
    expect(s.mints).toBe(1);
  });

  it('another set of codelines: the clean slate, and the mint runs', () => {
    const s = settle([...CODELINES, 'metrolinx']);
    expect(existsSync(join(s.proj, 'roster.json')), 'another run\'s roster survived').toBe(false);
    expect(s.mints).toBe(1);
  });
});
