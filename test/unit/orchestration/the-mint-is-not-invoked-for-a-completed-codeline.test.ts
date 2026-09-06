/**
 * THE MINT IS NOT INVOKED FOR A CODELINE THAT IS ALREADY PROVISIONED.
 *
 * Operator: "mint should not run nor prompt builder." "test your changes completely."
 *
 * THIS TEST EXISTS BECAUSE THE LAST ONE PROVED THE WRONG THING. A previous attempt set
 * process.env.EPAM_SKIP_AGENT_MINT inside mint-agents-step.js and covered it with 12 green tests
 * that lifted the guard block and executed it directly. They proved the block computes a value.
 * They could not prove anything about the decision, because the decision is made in BASH, in
 * run-agent-orchestration.sh, BEFORE that script is spawned:
 *
 *     [ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ] || {
 *       log "[mint] Minting project agents and assigning roles..."
 *       "$NODE_BIN" "$SCRIPT_DIR/mint-agents-step.js" ...
 *
 * A child process cannot change the mind of the parent that already spawned it. The live run
 * showed it: MINTING=1.
 *
 * So this test does not inspect a value. It EXECUTES the real function with a stubbed NODE_BIN
 * that records every invocation, and asserts the count. That is the operator's sentence turned
 * into an assertion: the mint must not run.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');

/**
 * Run the REAL _run_agent_mint() with a NODE_BIN that records its calls instead of running them.
 * Returns what the mint step was invoked with, if at all.
 */
function invokeMint(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'mintcall-'));
  try {
    const cfg = join(dir, 'projects', 'metrolinx');
    mkdirSync(join(cfg, 'prompts'), { recursive: true });
    mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'profiles.json'),
      JSON.stringify({ agents: { 'checkout-forms-engineer': { role: 'implementer' } } }));
    writeFileSync(join(cfg, 'prd.json'), JSON.stringify({ phases: [], stories: [] }));

    // A NODE_BIN that records every invocation and succeeds.
    const calls = join(dir, 'node-calls.txt');
    const fakeNode = join(dir, 'fake-node');
    writeFileSync(fakeNode, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(fakeNode, 0o755);

    // Lift the function and the helpers it needs, then call it. Everything it decides with is
    // real; only the thing it would SPAWN is stubbed.
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('_run_agent_mint() {');
    const end = src.indexOf('\n}\n', start) + 3;
    const fn = src.slice(start, end);

    const script = join(dir, 'drive.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log()   { printf "%s\\n" "$*"; }',
      'error() { printf "ERR %s\\n" "$*"; }',
      'info()  { printf "%s\\n" "$*"; }',
      'require_stage_coverage() { return 0; }',
      `NODE_BIN=${JSON.stringify(fakeNode)}`,
      `SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}`,
      `EPAM_AGENTS_DIR=${JSON.stringify(join(dir, 'agents'))}`,
      `LOG_DIR=${JSON.stringify(dir)}`,
      fn,
      `_run_agent_mint ${JSON.stringify(join(cfg, 'prd.json'))} /dev/null || true`,
    ].join('\n'));

    let out = '';
    try {
      out = execFileSync('bash', [script], {
        encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '',
               EPAM_PROJECT_CONFIG_DIR: cfg, ...env },
      });
    } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }

    const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim() : '';
    const mintCalls = recorded ? recorded.split('\n').filter((l) => l.includes('mint-agents-step.js')).length : 0;
    return { mintCalls, out, cfg,
      marker: (cl: string) => writeFileSync(join(cfg, '.prompt-cache', `.complete-${cl}`), '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Same, but the fixture is prepared (marker + prompts) before the function runs. */
function invokeMintPrepared(opts: { codeline: string; marker: string | null; prompts: number;
  skipFlag?: string; regen?: string; prdCodelines?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'mintcall-'));
  try {
    const cfg = join(dir, 'projects', 'metrolinx');
    mkdirSync(join(cfg, 'prompts'), { recursive: true });
    mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'profiles.json'),
      JSON.stringify({ agents: { 'checkout-forms-engineer': { role: 'implementer' } } }));
    // THE PRD CARRIES THE RUN'S RESOLVED SCOPE, exactly as synthesize-prd-from-jira.js writes it
    // (project.outputDirs / project.outputDir). That is where a live run's codeline actually is.
    writeFileSync(join(cfg, 'prd.json'), JSON.stringify({
      phases: [], stories: [],
      ...(opts.prdCodelines
        ? { project: { outputDirs: opts.prdCodelines.map((c) => ({ path: `/codelines/${c}` })) } }
        : {}),
    }));
    for (let i = 0; i < opts.prompts; i++) writeFileSync(join(cfg, 'prompts', `p${i}.json`), '{}');
    if (opts.marker) writeFileSync(join(cfg, '.prompt-cache', `.complete-${opts.marker}`), '');

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
        env: {
          PATH: process.env.PATH || '', HOME: process.env.HOME || '',
          EPAM_PROJECT_CONFIG_DIR: cfg,
          // An EMPTY codeline means the variable is ABSENT, which is what a live run has: no
          // launcher, config or env file in this repo sets EPAM_CODELINE_ID.
          ...(opts.codeline ? { EPAM_CODELINE_ID: opts.codeline } : {}),
          ...(opts.skipFlag ? { EPAM_SKIP_AGENT_MINT: opts.skipFlag } : {}),
          ...(opts.regen ? { EPAM_REGENERATE_CODELINE_ASSETS: opts.regen } : {}),
        },
      });
    } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }

    const rec = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    return {
      mintCalls: (rec.match(/mint-agents-step\.js/g) || []).length,
      rosterOnly: /EPAM_ROSTER_ONLY/.test(rec) || /roster-only/i.test(out),
      out,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('_run_agent_mint, executed for real with a recording NODE_BIN', () => {
  it('THE REQUIREMENT — marker + prompts on disk: the mint is NOT invoked', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com', prompts: 41 });
    expect(r.mintCalls, [
      'mint-agents-step.js was invoked for a codeline already provisioned.',
      'Live 2026-09-06 this was MINTING=1: the decision is made in bash before the node script',
      'runs, so setting the flag inside that script cannot change it.',
      `output: ${r.out.slice(0, 300)}`,
    ].join('\n')).toBe(0);
  });

  it('and it does not log that it is minting', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com', prompts: 41 });
    expect(r.out, 'the run announced a mint it was supposed to skip')
      .not.toMatch(/Minting project agents/);
  });

  it('NO marker — the mint IS invoked, exactly as today', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: null, prompts: 41 });
    expect(r.mintCalls, 'the mint was skipped with nothing declaring the codeline complete')
      .toBeGreaterThan(0);
  });

  it('marker for ANOTHER codeline — the mint IS invoked', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: 'next.upexpress.com', prompts: 41 });
    expect(r.mintCalls, "another codeline's completion was accepted for this one").toBeGreaterThan(0);
  });

  it('marker but NO prompts on disk — the mint IS invoked', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com', prompts: 0 });
    expect(r.mintCalls, 'a marker with an empty prompts dir skipped the mint').toBeGreaterThan(0);
  });

  it('no codeline declared — the mint IS invoked', () => {
    const r = invokeMintPrepared({ codeline: '', marker: 'next.gotransit.com', prompts: 41 });
    expect(r.mintCalls, 'the mint was skipped with no codeline to match the marker against')
      .toBeGreaterThan(0);
  });

  it('OVERRIDE forces the mint even with a marker', () => {
    const r = invokeMintPrepared({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com',
      prompts: 41, regen: '1' });
    expect(r.mintCalls, 'EPAM_REGENERATE_CODELINE_ASSETS=1 did not force a re-mint').toBeGreaterThan(0);
  });
});

describe('the mint gate reads the codeline the RUN DETECTED', () => {
  /**
   * Operator, 2026-09-06: "code line is detected in a live run ... this var will never be preset
   * in a live run."
   *
   * The gate was written against EPAM_CODELINE_ID, which nothing in this repo sets. In a live run
   * the variable is absent, the marker path becomes `.complete-` which never exists, and the gate
   * silently never fires — so the mint runs and is paid for on every run while the reuse machinery
   * reports itself as working. The PRD holds the resolved scope by the time the mint is reached:
   * synthesize-prd-from-jira.js writes project.outputDirs, and the mint is invoked with that PRD.
   */
  it('skips the mint with NO EPAM_CODELINE_ID, on the codeline the PRD resolved', () => {
    const r = invokeMintPrepared({
      codeline: '', marker: 'next.gotransit.com', prompts: 3,
      prdCodelines: ['next.gotransit.com'],
    });
    expect(r.mintCalls,
      'the mint ran on a completed codeline because it waited for a variable no launcher sets — '
      + 'this is the paid mint on every live run').toBe(0);
  });

  it('still mints when the PRD resolves a DIFFERENT codeline than the marker names', () => {
    const r = invokeMintPrepared({
      codeline: '', marker: 'next.upexpress.com', prompts: 3,
      prdCodelines: ['next.gotransit.com'],
    });
    expect(r.mintCalls, 'another codeline\'s marker was accepted as this one\'s').toBe(1);
  });

  it('still mints when the PRD resolves TWO codelines — neither is attributable', () => {
    const r = invokeMintPrepared({
      codeline: '', marker: 'next.gotransit.com', prompts: 3,
      prdCodelines: ['next.gotransit.com', 'next.upexpress.com'],
    });
    expect(r.mintCalls, 'a two-codeline run claimed one codeline\'s completed assets').toBe(1);
  });

  it('still mints when the PRD resolves no scope at all', () => {
    const r = invokeMintPrepared({ codeline: '', marker: 'next.gotransit.com', prompts: 3 });
    expect(r.mintCalls, 'a scopeless run reused a codeline\'s assets on no evidence').toBe(1);
  });

  it('the override still forces a mint on the detected codeline', () => {
    const r = invokeMintPrepared({
      codeline: '', marker: 'next.gotransit.com', prompts: 3,
      prdCodelines: ['next.gotransit.com'], regen: '1',
    });
    expect(r.mintCalls, 'EPAM_REGENERATE_CODELINE_ASSETS=1 did not force a re-mint').toBe(1);
  });
});
