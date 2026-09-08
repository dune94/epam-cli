/**
 * NOTHING IS DELETED BEFORE THE RUN KNOWS WHICH CODELINE IT IS FOR.
 *
 * Operator, 2026-09-06: "the prompts and profile cannot be deleted until the codeline or codelines
 * are known the order is now incorrect."
 *
 * pre-run-reset.sh runs from the LAUNCHER, before run-agent-orchestration.sh starts, so it deletes
 * the roster, the profile/role/investigator registries and prompts/ before either discovery step
 * has run. Its reuse gate reads EPAM_CODELINE_ID, which no launcher, config file or env file in
 * this repo sets — so in a live run the gate cannot fire and the assets are destroyed every time,
 * whichever codeline the run turns out to be for.
 *
 * THE ORDER IS THE FIX, NOT A BETTER GUESS. The reset defers the decision and records that it is
 * owed; _run_agent_mint settles it, because by then discovery has persisted the scope
 * (ingest-jira-tickets.sh, or resolve-codeline-scope.sh) and BOTH call paths pass through that one
 * function — and it runs before any profile is generated.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESET = join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh');
const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const CODELINE = 'next.gotransit.com';
// EXACTLY WHAT pre-run-reset.sh CLEARS, no more. The deferral must reproduce the decision the
// reset would have taken, not a broader one — a mint that deleted more than the reset does would
// be a second, divergent clean-slate policy. project-profiles.json is deliberately absent: the
// reset's loop covers project-roles, project-investigators and agent-profiles only, and widening
// that belongs to a change about the reset, not to this one.
const REGISTRIES = ['agent-profiles.json', 'project-roles.json', 'project-investigators.json'];
const NOT_CLEARED_BY_RESET = 'project-profiles.json';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project as a COMPLETED run leaves it: roster, registries, prompts, cache, marker. */
function project(opts: { marker?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'order-'));
  dirs.push(root);
  const cfg = join(root, 'projects', 'metrolinx');
  mkdirSync(join(cfg, 'prompts'), { recursive: true });
  mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
  writeFileSync(join(cfg, 'roster.json'),
    JSON.stringify({ agents: { 'checkout-forms-engineer': { role: 'implementer' } } }));
  for (const f of [...REGISTRIES, NOT_CLEARED_BY_RESET]) {
    writeFileSync(join(cfg, f), JSON.stringify({ from: 'the completed run' }));
  }
  writeFileSync(join(cfg, 'prompts', 'roster-review.json'), JSON.stringify({ body: 'THE COMPLETED BODY' }));
  writeFileSync(join(cfg, '.prompt-cache', 'roster-review.json'), JSON.stringify({ base: 'a', reviewed: true }));
  if (opts.marker !== null) {
    writeFileSync(join(cfg, '.prompt-cache', `.complete-${opts.marker || CODELINE}`), '');
  }
  return { root, cfg };
}

function runReset(cfg: string, env: Record<string, string> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'order-logs-'));
  dirs.push(logDir);
  const prd = join(logDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [] }));
  let out = '';
  try {
    out = execFileSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
      encoding: 'utf8', timeout: 180_000,
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: cfg, JIRA_CODELINE_ROOT: '',
             EPAM_SKIP_CONTAINER_RESTART: '1', ...env },
    });
  } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  return out;
}

const has = (cfg: string, rel: string) => existsSync(join(cfg, rel));
const PENDING = join('.prompt-cache', '.reset-pending');

describe('pre-run-reset defers what it cannot decide', () => {
  it('GUARD: the reset actually ran and can delete — otherwise nothing below proves anything', () => {
    // With the codeline KNOWN and no marker for it, the reset has every reason to clear, and must.
    const { cfg } = project({ marker: null });
    const out = runReset(cfg, { EPAM_CODELINE_ID: CODELINE });
    expect(out.length, 'the reset produced no output — it probably never ran').toBeGreaterThan(0);
    expect(has(cfg, 'roster.json'),
      'the reset cleared nothing even with the codeline known and no marker').toBe(false);
  });

  it('with NO codeline knowable, the roster SURVIVES the reset', () => {
    // The live-run reality: EPAM_CODELINE_ID is absent because nothing sets it.
    const { cfg } = project({ marker: CODELINE });
    runReset(cfg, { EPAM_CODELINE_ID: '' });
    expect(has(cfg, 'roster.json'),
      'the roster was destroyed before the run knew which codeline it was for — a paid '
      + 'roster-specialiser call and ~13 minutes, on every live run').toBe(true);
  });

  it.each(REGISTRIES)('with NO codeline knowable, %s SURVIVES the reset', (f) => {
    const { cfg } = project({ marker: CODELINE });
    runReset(cfg, { EPAM_CODELINE_ID: '' });
    expect(has(cfg, f), `${f} was deleted before the codeline was known`).toBe(true);
  });

  it('with NO codeline knowable, prompts/ SURVIVES the reset', () => {
    const { cfg } = project({ marker: CODELINE });
    runReset(cfg, { EPAM_CODELINE_ID: '' });
    expect(has(cfg, join('prompts', 'roster-review.json')),
      'the provisioned prompts were deleted before the codeline was known').toBe(true);
  });

  it('records that the decision is OWED, so it cannot be silently skipped', () => {
    // A deferral with no record is just a deletion that stopped happening. The sentinel is what
    // makes the mint step responsible for settling it.
    const { cfg } = project({ marker: CODELINE });
    runReset(cfg, { EPAM_CODELINE_ID: '' });
    expect(has(cfg, PENDING),
      'nothing recorded that the codeline-asset decision was deferred — a run that dies here '
      + 'leaves the next one unable to tell a deferral from a completed reset').toBe(true);
  });

  it('THE OTHER END — a knowable codeline still settles immediately, as before', () => {
    const { cfg } = project({ marker: CODELINE });
    runReset(cfg, { EPAM_CODELINE_ID: CODELINE });
    expect(has(cfg, 'roster.json'), 'the completed codeline\'s roster was cleared').toBe(true);
    expect(has(cfg, PENDING),
      'a reset that DID decide still left the decision marked as owed').toBe(false);
  });
});

/** Drives the real _run_agent_mint with a recording NODE_BIN, and keeps the fixture for inspection. */
function invokeMint(opts: { marker: string | null; prdCodelines?: string[]; pending: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'order-mint-'));
  dirs.push(dir);
  const cfg = join(dir, 'projects', 'metrolinx');
  mkdirSync(join(cfg, 'prompts'), { recursive: true });
  mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'profiles.json'),
    JSON.stringify({ agents: { 'checkout-forms-engineer': { role: 'implementer' } } }));
  writeFileSync(join(cfg, 'roster.json'), JSON.stringify({ agents: { a: {} } }));
  for (const f of [...REGISTRIES, NOT_CLEARED_BY_RESET]) {
    writeFileSync(join(cfg, f), JSON.stringify({ from: 'the previous run' }));
  }
  writeFileSync(join(cfg, 'prompts', 'roster-review.json'), JSON.stringify({ body: 'PREVIOUS' }));
  if (opts.marker) writeFileSync(join(cfg, '.prompt-cache', `.complete-${opts.marker}`), '');
  if (opts.pending) writeFileSync(join(cfg, '.prompt-cache', '.reset-pending'), '');
  writeFileSync(join(cfg, 'prd.json'), JSON.stringify({
    phases: [], stories: [],
    ...(opts.prdCodelines
      ? { project: { outputDirs: opts.prdCodelines.map((c) => ({ path: `/codelines/${c}` })) } } : {}),
  }));

  const calls = join(dir, 'node-calls.txt');
  const fakeNode = join(dir, 'fake-node');
  writeFileSync(fakeNode, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
  chmodSync(fakeNode, 0o755);

  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('_run_agent_mint() {');
  const end = src.indexOf('\n}\n', start) + 3;
  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'log()   { printf "%s\\n" "$*"; }',
    'error() { printf "ERR %s\\n" "$*"; }',
    'info()  { printf "%s\\n" "$*"; }',
    'require_stage_coverage() { return 0; }',
    // THE AMBIENT DEPENDENCY THE REAL SCRIPT PROVIDES. run-agent-orchestration.sh sources
    // lib/prompt-variant.sh (line ~158) before _run_agent_mint runs, and the mint's marker check
    // calls prompt_marker_key from it. The REAL lib is sourced here, not a stub, so the name this
    // harness looks for is the name the builder actually writes.
    `. ${JSON.stringify(join(__dirname, '../../../orchestrations/scripts/lib/prompt-variant.sh'))}`,
    `NODE_BIN=${JSON.stringify(fakeNode)}`,
    `SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}`,
    `EPAM_AGENTS_DIR=${JSON.stringify(join(dir, 'agents'))}`,
    `LOG_DIR=${JSON.stringify(dir)}`,
    src.slice(start, end),
    `_run_agent_mint ${JSON.stringify(join(cfg, 'prd.json'))} /dev/null || true`,
  ].join('\n'));

  let out = '';
  try {
    out = execFileSync('bash', [script], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '',
             EPAM_PROJECT_CONFIG_DIR: cfg },
    });
  } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim() : '';
  return { cfg, out,
    mintCalls: recorded ? recorded.split('\n').filter((l) => l.includes('mint-agents-step.js')).length : 0 };
}

describe('the mint settles the deferred decision, once the codeline is known', () => {
  it('KEEPS the assets when the detected codeline is the one that completed', () => {
    const r = invokeMint({ marker: CODELINE, prdCodelines: [CODELINE], pending: true });
    expect(has(r.cfg, 'roster.json'), 'the completed codeline\'s roster was cleared').toBe(true);
    expect(has(r.cfg, join('prompts', 'roster-review.json'))).toBe(true);
    expect(r.mintCalls, 'the mint ran for a codeline that had already completed').toBe(0);
    expect(has(r.cfg, PENDING), 'the deferred decision was never marked settled').toBe(false);
  });

  it('DELETES the assets when the detected codeline is a DIFFERENT one', () => {
    // The deferral must not become a way for one codeline's roster to reach another's run. This
    // is the clean slate, executed at the first moment it can be executed correctly.
    const r = invokeMint({ marker: 'next.upexpress.com', prdCodelines: [CODELINE], pending: true });
    expect(has(r.cfg, 'roster.json'),
      'another codeline\'s roster survived into this run — the deferral became contamination')
      .toBe(false);
    for (const f of REGISTRIES) expect(has(r.cfg, f), `${f} survived from another codeline`).toBe(false);
    expect(has(r.cfg, NOT_CLEARED_BY_RESET),
      'the mint cleared more than pre-run-reset does — two divergent clean-slate policies')
      .toBe(true);
    expect(has(r.cfg, join('prompts', 'roster-review.json')),
      'another codeline\'s prompts survived into this run').toBe(false);
    expect(r.mintCalls, 'the mint did not run for a codeline with no completed assets').toBe(1);
    expect(has(r.cfg, PENDING)).toBe(false);
  });

  it('DELETES when the run resolves no codeline at all', () => {
    const r = invokeMint({ marker: CODELINE, pending: true });
    expect(has(r.cfg, 'roster.json'),
      'a run that resolved no scope kept the previous run\'s roster').toBe(false);
    expect(r.mintCalls).toBe(1);
  });

  it('DELETES when the run resolves TWO codelines — neither is attributable', () => {
    const r = invokeMint({ marker: CODELINE, prdCodelines: [CODELINE, 'next.upexpress.com'], pending: true });
    expect(has(r.cfg, 'roster.json'), 'a two-codeline run claimed one codeline\'s roster').toBe(false);
    expect(r.mintCalls).toBe(1);
  });

  it('THE OTHER END — with NO deferral owed, the mint touches nothing', () => {
    // pre-run-reset already decided (it knew the codeline). The mint must not delete a second
    // time: a resumed run's roster is kept by the reset and must survive this function.
    const r = invokeMint({ marker: CODELINE, prdCodelines: ['next.upexpress.com'], pending: false });
    expect(has(r.cfg, 'roster.json'),
      'the mint deleted assets nobody asked it to decide about').toBe(true);
    for (const f of REGISTRIES) expect(has(r.cfg, f)).toBe(true);
    expect(has(r.cfg, NOT_CLEARED_BY_RESET)).toBe(true);
    expect(has(r.cfg, join('prompts', 'roster-review.json'))).toBe(true);
  });
});
