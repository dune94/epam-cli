/**
 * RG-DELTA (backlog item, user requirement 2026-07-30): Step 5's regression
 * guard must TOLERATE pre-existing test failures on a brownfield codeline
 * instead of hard-blocking on them — live AMSD-2041, 2026-07-31: gotransit
 * had exactly one genuinely-failing test on develop itself
 * (PageLevelServiceAlert), stable across all 3 attempts, and the guard
 * halted the entire run over it even though it had nothing to do with the
 * story being implemented.
 *
 * Mechanism: when the project's dependency-check.json declares
 * `testFailurePattern` (a regex identifying a failing test from the runner's
 * own output, e.g. Jest's "FAIL <path>" line), Step 5 extracts the failing
 * set from EACH of the 3 attempts and takes their INTERSECTION — only tests
 * failing in every attempt are "stable" (the same bar the existing flake
 * retry already uses: "a failure surviving 3 runs is stable"). A stable
 * failing set is written to a baseline file and Step 5 PASSES, tolerating
 * it. An UNSTABLE set (attempts disagree on which tests failed) cannot be
 * trusted as a baseline and falls through to the existing hard-fail.
 *
 * Absence of testFailurePattern (no dependency-check.json, or one without
 * the field) must reproduce today's exact all-or-nothing behavior — every
 * existing project's manifest lacks this field, and RG-DELTA must not
 * change their runs.
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
 * A codeline whose test command prints deterministic Jest-shaped "FAIL
 * <path>" / "PASS <path>" lines and exits non-zero whenever any FAIL line is
 * printed. `failuresByAttempt` gives the set of failing file names for each
 * attempt (1-indexed); an attempt index beyond the array reuses the last
 * entry. `.attempts` tracks how many times the command actually ran.
 */
function patternedCodeline(failuresByAttempt: string[][]) {
  const d = scratch('rg-delta-');
  const table = JSON.stringify(failuresByAttempt);
  const script = [
    'n=$(( $(cat .attempts 2>/dev/null || echo 0) + 1 ));',
    'echo $n > .attempts;',
    `node -e '` +
      `const t=${table}; const n=${'process.argv[1]'};` +
      `const fails = t[Math.min(n-1, t.length-1)] || [];` +
      `const allFiles=["a.spec.ts","b.spec.ts","c.spec.ts","d.spec.ts"];` +
      `for (const f of allFiles) console.log((fails.includes(f)?"FAIL ":"PASS ")+f);` +
      `console.log(fails.length?"Tests: "+fails.length+" failed":"Tests: 0 failed");` +
      `process.exit(fails.length?1:0);` +
    `' "$n"`,
  ].join(' ');
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
  return existsSync(f) ? parseInt(readFileSync(f, 'utf8').trim(), 10) : 0;
}

function manifestDir(testFailurePattern?: string) {
  const d = scratch('rg-delta-manifest-');
  if (testFailurePattern !== undefined) {
    writeFileSync(join(d, 'dependency-check.json'), JSON.stringify({ testFailurePattern }));
  }
  return d;
}

function runStep5(root: string, env: Record<string, string> = {}) {
  const harness = scratch('rg-delta-harness-');
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

describe('RG-DELTA absent (no testFailurePattern) — today\'s exact behavior, unchanged', () => {
  it('a permanently-red baseline still hard-fails when no manifest is configured', () => {
    const c = patternedCodeline([['a.spec.ts'], ['a.spec.ts'], ['a.spec.ts']]);
    const r = runStep5(c); // no EPAM_PROJECT_CONFIG_DIR at all
    expect(r.out).toMatch(/STEP_EMIT: 5 fail/);
    expect(r.code).not.toBe(0);
  });

  it('a permanently-red baseline still hard-fails when the manifest has no testFailurePattern field', () => {
    const c = patternedCodeline([['a.spec.ts'], ['a.spec.ts'], ['a.spec.ts']]);
    const m = manifestDir(); // dependency-check.json absent entirely
    const r = runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(r.out).toMatch(/STEP_EMIT: 5 fail/);
    expect(r.code).not.toBe(0);
  });
});

describe('RG-DELTA present — stable pre-existing failures are tolerated', () => {
  it('PASSES and writes a baseline file when the SAME failure is stable across all 3 attempts', () => {
    const c = patternedCodeline([['a.spec.ts'], ['a.spec.ts'], ['a.spec.ts']]);
    const m = manifestDir('^FAIL\\s+(\\S+)');
    const r = runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(r.out, `expected tolerated pass:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
    expect(r.out).not.toMatch(/STEP_EMIT: 5 fail/);
    expect(r.code).toBe(0);
    const baseline = JSON.parse(readFileSync(join(r.logDir, 'regression-guard-baseline-core.json'), 'utf8'));
    expect(baseline.failures).toEqual(['a.spec.ts']);
  });

  it('names the tolerated-count in its success message, distinct from a genuinely green baseline', () => {
    const c = patternedCodeline([['a.spec.ts', 'b.spec.ts'], ['a.spec.ts', 'b.spec.ts'], ['a.spec.ts', 'b.spec.ts']]);
    const m = manifestDir('^FAIL\\s+(\\S+)');
    const r = runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(r.out).toMatch(/2 pre-existing failure/);
  });

  it('does NOT tolerate an UNSTABLE failing set — different tests failing per attempt still hard-fails', () => {
    // The exact live gotransit shape this guards against reintroducing:
    // failing test identity changes between attempts under interference.
    const c = patternedCodeline([['a.spec.ts'], ['b.spec.ts'], ['c.spec.ts']]);
    const m = manifestDir('^FAIL\\s+(\\S+)');
    const r = runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(r.out, `an unstable failing set must not become a trusted baseline:\n${r.out}`)
      .toMatch(/STEP_EMIT: 5 fail/);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(r.logDir, 'regression-guard-baseline-core.json')),
      'no baseline should be written for an untrustworthy set').toBe(false);
  });

  it('a genuinely green suite still passes without writing a baseline file (nothing to tolerate)', () => {
    const c = patternedCodeline([[]]);
    const m = manifestDir('^FAIL\\s+(\\S+)');
    const r = runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(r.out).toMatch(/STEP_EMIT: 5 pass/);
    expect(attemptsRun(c), 'a passing suite was retried needlessly').toBe(1);
    expect(existsSync(join(r.logDir, 'regression-guard-baseline-core.json'))).toBe(false);
  });

  it('still spends exactly the existing retry budget before tolerating — no shortcut around the flake-retry', () => {
    const c = patternedCodeline([['a.spec.ts'], ['a.spec.ts'], ['a.spec.ts']]);
    const m = manifestDir('^FAIL\\s+(\\S+)');
    runStep5(c, { EPAM_PROJECT_CONFIG_DIR: m });
    expect(attemptsRun(c)).toBe(3);
  });
});
