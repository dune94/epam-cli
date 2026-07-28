/**
 * A flaky suite must not be reported as a regression — and a real one still must.
 *
 * Live AMSD-2041, 2026-07-28. Step 5 blocked the run on next.gotransit.com:
 *
 *   Test Suites: 2 failed, 735 passed, 737 total
 *   Tests:       4 failed, 21 todo, 3292 passed, 3321 total
 *
 * Clean tree, HEAD == origin/develop, TZ=UTC, and no implementation written yet
 * — Step 5 runs before any work. So these were the client's own tests. But they
 * were not BROKEN. Re-measured on that exact commit:
 *
 *   the two files alone, 3x  ->  23/23 passed every time
 *   full suite, pass 1       ->  1 failed  (a DIFFERENT test than the pipeline hit)
 *   full suite, pass 2       ->  0 failed, exit 0
 *
 * Four, then one, then zero, with the failing test changing between runs. Real
 * breakage fails the same test every time; this is interference under the
 * parallel 737-suite run.
 *
 * WHY NOT BASELINE SUBTRACTION, the obvious fix and the one first proposed
 * here: recording the pre-existing failures and subtracting them assumes the
 * baseline is STABLE. Against a flaky suite it excuses whichever tests happened
 * to fail during capture — so a real regression in ProductContainer would be
 * subtracted away and never reported. It silences the gate instead of sharpening
 * it. Subtraction is right for a reliably-red baseline; that is not this.
 *
 * The rule being enforced is the user's: coding must not INCREASE the failure
 * count. That needs a decidable count, so the command is retried and a failure
 * is only real if it survives every attempt. Retrying the WHOLE command — not
 * re-running individually-named failed tests — is deliberate: parsing failed
 * test names out of runner output would bake in jest/vitest grammar, and this
 * engine has to run on the next unknown project unmodified.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The real Step 5 block, from its SKIP guard to the closing fi. */
function step5Block(): string {
  const start = orchSrc.indexOf('if [ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]; then');
  expect(start, 'Step 5 block not found').toBeGreaterThan(-1);
  const marker = 'Step 5: Regression guard skipped (SKIP_REGRESSION_GUARD=true)';
  const end = orchSrc.indexOf(marker, start);
  expect(end, 'Step 5 block end not found').toBeGreaterThan(start);
  return orchSrc.slice(start, orchSrc.indexOf('\nfi', end) + 3);
}

/**
 * A codeline whose test command fails the first `failFor` invocations and then
 * succeeds. Each invocation appends to `.attempts`, so the test can count how
 * many times the guard actually ran the command.
 */
function flakyCodeline(failFor: number) {
  const d = scratch('rg-flaky-');
  const script =
    'echo x >> .attempts; ' +
    `n=$(wc -l < .attempts); ` +
    `[ "$n" -le ${failFor} ] && exit 1; exit 0`;
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: script } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
  const stub = join(d, 'node_modules/.bin/anything');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  return d;
}

function attemptsRun(root: string): number {
  const f = join(root, '.attempts');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
}

function runStep5(root: string, env: Record<string, string> = {}) {
  const harness = scratch('rg-harness-');
  const logDir = join(harness, 'logs');
  mkdirSync(logDir, { recursive: true });

  const bin = join(harness, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    '[ "$1" = "test" ] || exit 0',
    'script=$(node -e \'try{const p=require(process.cwd()+"/package.json");process.stdout.write((p.scripts&&p.scripts.test)||"")}catch(e){}\')',
    '[ -n "$script" ] || exit 0',
    'sh -c "$script"',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);

  const script = join(harness, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `PROJECT_ROOT=${JSON.stringify(root)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    'PHASE=core',
    'EPAM_BROWNFIELD=0',
    'log()     { echo "LOG: $*"; }',
    'info()    { echo "INFO: $*"; }',
    'warning() { echo "WARN: $*"; }',
    'warn()    { echo "WARN: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'error()   { echo "ERROR: $*"; }',
    'step_emit() { echo "STEP_EMIT: $1 $2 ${4:-}"; }',
    'resolve_codeline_node() { command -v node; }',
    'ensure_node_modules_healthy() { :; }',
    step5Block(),
  ].join('\n'));

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), logDir };
}

describe('a green suite is not retried', () => {
  it('runs the command exactly once and passes', () => {
    const c = flakyCodeline(0);                 // never fails
    const r = runStep5(c);
    expect(r.out, `expected pass:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
    expect(attemptsRun(c), 'a passing suite was run more than once — pure waste').toBe(1);
  });
});

describe('a flake is not a regression', () => {
  it('PASSES when the suite fails once then succeeds', () => {
    const c = flakyCodeline(1);
    const r = runStep5(c);
    expect(r.out, `a one-off flake still blocked the run:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
    expect(r.out).not.toMatch(/STEP_EMIT: 5 fail/);
    expect(attemptsRun(c)).toBe(2);
  });

  it('PASSES when the suite fails twice then succeeds — 2 retries are allowed', () => {
    // The live gotransit shape: 4 failures, then 1, then 0.
    const c = flakyCodeline(2);
    const r = runStep5(c);
    expect(r.out, `the second retry was never attempted:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
    expect(attemptsRun(c), 'the guard gave up before its retry budget was spent').toBe(3);
  });
});

describe('a real regression still blocks', () => {
  it('FAILS when the suite fails every attempt', () => {
    const c = flakyCodeline(99);                // deterministically broken
    const r = runStep5(c);
    expect(r.out, `a permanently red baseline was allowed through:\n${r.out}`)
      .toMatch(/STEP_EMIT: 5 fail/);
    expect(r.code, 'a real regression must stop the phase').not.toBe(0);
  });

  it('spends exactly the retry budget before giving up — no more, no less', () => {
    const c = flakyCodeline(99);
    runStep5(c);
    expect(attemptsRun(c), 'the retry budget is not 1 + 2').toBe(3);
  });

  it('says the failure survived every attempt, not that it failed once', () => {
    const r = runStep5(flakyCodeline(99));
    expect(r.out, 'the operator cannot tell a persistent failure from a single bad roll')
      .toMatch(/3 attempt|all .* attempts|every attempt/i);
  });

  it('keeps each attempt\'s output instead of overwriting the evidence', () => {
    // One log overwritten twice would leave only the last attempt — and the
    // interesting one is usually the first.
    const r = runStep5(flakyCodeline(99));
    const { readdirSync } = require('node:fs');
    const logs = readdirSync(r.logDir).filter((f: string) => f.includes('regression-guard'));
    expect(logs.length,
      `only ${logs.length} log kept for 3 attempts — earlier evidence is gone: ${logs.join(', ')}`)
      .toBeGreaterThan(1);
  });
});

describe('the retry budget is configurable, not a constant', () => {
  it('honours EPAM_REGRESSION_GUARD_RETRIES=0 for a project that wants none', () => {
    const c = flakyCodeline(1);
    const r = runStep5(c, { EPAM_REGRESSION_GUARD_RETRIES: '0' });
    expect(attemptsRun(c), 'retries were run despite being disabled').toBe(1);
    expect(r.out).toMatch(/STEP_EMIT: 5 fail/);
  });
});
