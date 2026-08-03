/**
 * RG-DELTA's "after" half: Step 3.58, inserted between Step 3.55 (bug-repro
 * gate) and Step 3.6 (team-lead review). Compares the failing-test set AFTER
 * the phase's implementation against Step 5's tolerated baseline (written to
 * regression-guard-baseline-<phase>.json) — pass only if after ⊆ baseline
 * (nothing NEW broke), fail if a test that was NOT in the baseline now fails.
 *
 * Gated to effort:"high" stories only (user decision, 2026-07-31): re-running
 * the entire suite a second time has a real cost, and most brownfield stories
 * are narrow enough that their own TC-writer test + team-lead review is
 * sufficient coverage. AMSD-2041 itself — effort:"low" despite spanning 3
 * codelines — is the concrete example that should NOT pay this cost; "not
 * complex enough" was the explicit call, not file/codeline count.
 *
 * Count-only comparison would miss a real regression when the total stays
 * the same but the IDENTITY differs (2 baseline failures, 2 after-failures,
 * different tests) — one of the three ship-with cases the backlog specifies.
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

/** The real Step 3.58 block, from its own start marker to its closing fi. */
function step358Block(): string {
  const start = orchSrc.indexOf('# Step 3.58: Regression delta gate (RG-DELTA)');
  expect(start, 'Step 3.58 block not found — has it been implemented yet?').toBeGreaterThan(-1);
  const nextStepMarker = '# Step 3.6: Team Lead Code Review';
  const end = orchSrc.indexOf(nextStepMarker, start);
  expect(end, 'Step 3.6 marker not found after Step 3.58').toBeGreaterThan(start);
  return orchSrc.slice(start, end);
}

function patternedCodeline(failuresByAttempt: string[][]) {
  const d = scratch('rgd-code-');
  const table = JSON.stringify(failuresByAttempt);
  const script = [
    'n=$(( $(cat .attempts 2>/dev/null || echo 0) + 1 ));',
    'echo $n > .attempts;',
    `node -e '` +
      `const t=${table}; const n=${'process.argv[1]'};` +
      `const fails = t[Math.min(n-1, t.length-1)] || [];` +
      `const allFiles=["a.spec.ts","b.spec.ts","c.spec.ts","d.spec.ts"];` +
      `for (const f of allFiles) console.log((fails.includes(f)?"FAIL ":"PASS ")+f);` +
      `process.exit(fails.length?1:0);` +
    `' "$n"`,
  ].join(' ');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: script } }));
  mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
  const stub = join(d, 'node_modules/.bin/anything');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  return d;
}

function prdWithEffort(effort: string | null) {
  const d = scratch('rgd-prd-');
  const prdFile = join(d, 'prd.json');
  const story: Record<string, unknown> = { id: 'AMSD-2041', status: 'pending' };
  if (effort !== null) story.effort = effort;
  writeFileSync(prdFile, JSON.stringify({
    stories: [story],
    implementationOrder: { core: ['AMSD-2041'] },
  }));
  return prdFile;
}

function manifestDir(testFailurePattern?: string) {
  const d = scratch('rgd-manifest-');
  if (testFailurePattern !== undefined) {
    writeFileSync(join(d, 'dependency-check.json'), JSON.stringify({ testFailurePattern }));
  }
  return d;
}

function runStep358(opts: {
  codelineFailures: string[][];
  effort: string | null;
  testFailurePattern?: string;
  baselineFailures?: string[];
  skipRegressionGuard?: boolean;
}) {
  const root = patternedCodeline(opts.codelineFailures);
  const prdFile = prdWithEffort(opts.effort);
  const manifest = manifestDir(opts.testFailurePattern);
  const harness = scratch('rgd-harness-');
  const logDir = join(harness, 'logs');
  mkdirSync(logDir, { recursive: true });
  if (opts.baselineFailures) {
    writeFileSync(
      join(logDir, 'regression-guard-baseline-core.json'),
      JSON.stringify({ stable: true, failures: opts.baselineFailures }),
    );
  }

  const bin = join(harness, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    `source ${join(__dirname, '../../../orchestrations/scripts/lib/flags.sh')}`,
    '[ "$1" = "test" ] || exit 0',
    'script=$(node -e \'try{const p=require(process.cwd()+"/package.json");process.stdout.write((p.scripts&&p.scripts.test)||"")}catch(e){}\')',
    '[ -n "$script" ] || exit 0',
    'sh -c "$script"',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);

  const script = join(harness, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `source ${join(__dirname, '../../../orchestrations/scripts/lib/flags.sh')}`,
    'set -uo pipefail',
    `_rg_root=${JSON.stringify(root)}`,
    `_rg_node=${JSON.stringify(process.execPath)}`,
    '_rg_pm=npm',
    '_rg_test_declared=1',
    `PRD_FILE=${JSON.stringify(prdFile)}`,
    `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(manifest)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    'PHASE=core',
    `SKIP_REGRESSION_GUARD=${opts.skipRegressionGuard ? 'true' : 'false'}`,
    'log()     { echo "LOG: $*"; }',
    'info()    { echo "INFO: $*"; }',
    'warning() { echo "WARN: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'error()   { echo "ERROR: $*"; }',
    'step_emit() { echo "STEP_EMIT: $1 $2 ${4:-}"; }',
    step358Block(),
  ].join('\n'));

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('Step 3.58 gating — only runs for effort:"high" stories with testFailurePattern configured', () => {
  it('SKIPS when no story in the phase is effort:"high"', () => {
    const r = runStep358({ codelineFailures: [[]], effort: 'low', testFailurePattern: '^FAIL\\s+(\\S+)' });
    expect(r.out).toMatch(/STEP_EMIT: 3\.58 skip/);
  });

  it('SKIPS when effort is unset entirely (matches AMSD-2041\'s own shape before CPA runs)', () => {
    const r = runStep358({ codelineFailures: [[]], effort: null, testFailurePattern: '^FAIL\\s+(\\S+)' });
    expect(r.out).toMatch(/STEP_EMIT: 3\.58 skip/);
  });

  it('SKIPS for effort:"high" when testFailurePattern is not configured (same fallback semantics as Step 5)', () => {
    const r = runStep358({ codelineFailures: [[]], effort: 'high' });
    expect(r.out).toMatch(/STEP_EMIT: 3\.58 skip/);
  });

  it('SKIPS entirely when SKIP_REGRESSION_GUARD=true, regardless of effort', () => {
    const r = runStep358({
      codelineFailures: [['a.spec.ts']], effort: 'high', testFailurePattern: '^FAIL\\s+(\\S+)',
      skipRegressionGuard: true,
    });
    expect(r.out).toMatch(/STEP_EMIT: 3\.58 skip/);
  });
});

describe('Step 3.58 — effort:"high", pre-existing failures tolerated, new ones blocked', () => {
  it('PASSES when the after-run has the SAME failures as the baseline', () => {
    const r = runStep358({
      codelineFailures: [['a.spec.ts', 'b.spec.ts'], ['a.spec.ts', 'b.spec.ts'], ['a.spec.ts', 'b.spec.ts']],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
      baselineFailures: ['a.spec.ts', 'b.spec.ts'],
    });
    expect(r.out, `expected pass:\n${r.out}`).toMatch(/STEP_EMIT: 3\.58 pass/);
    expect(r.code).toBe(0);
  });

  it('FAILS when the after-run has a NEW failure beyond the baseline', () => {
    const r = runStep358({
      codelineFailures: [
        ['a.spec.ts', 'c.spec.ts'], ['a.spec.ts', 'c.spec.ts'], ['a.spec.ts', 'c.spec.ts'],
      ],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
      baselineFailures: ['a.spec.ts'],
    });
    expect(r.out, `expected the new failure to be named:\n${r.out}`).toMatch(/STEP_EMIT: 3\.58 fail/);
    expect(r.out).toMatch(/c\.spec\.ts/);
    expect(r.code).not.toBe(0);
  });

  it('FAILS when after has the SAME COUNT but DIFFERENT identities than the baseline (count-only comparison would miss this)', () => {
    const r = runStep358({
      codelineFailures: [
        ['c.spec.ts', 'd.spec.ts'], ['c.spec.ts', 'd.spec.ts'], ['c.spec.ts', 'd.spec.ts'],
      ],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
      baselineFailures: ['a.spec.ts', 'b.spec.ts'],
    });
    expect(r.out, `2-vs-2 different tests must still fail:\n${r.out}`).toMatch(/STEP_EMIT: 3\.58 fail/);
    expect(r.code).not.toBe(0);
  });

  it('PASSES when there is no baseline file at all (Step 5 found a clean baseline) and the after-run is also clean', () => {
    const r = runStep358({
      codelineFailures: [[]],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
    });
    expect(r.out).toMatch(/STEP_EMIT: 3\.58 pass/);
  });

  it('PASSES when after-run failures are fully disjoint across attempts — nothing reproducible, so nothing to report as a confirmed new regression', () => {
    // Corrected semantics (live AMSD-2041, 2026-07-31): the intersection is
    // the only trustworthy signal, on EITHER side of this comparison. Fully
    // disjoint failures across attempts (a, b, c never overlap) means the
    // intersection is empty — no test failed in EVERY after-attempt, so
    // there is no reproducible new failure to report. This is one-off flake
    // noise, exactly what the retry exists to filter, not grounds to block.
    const r = runStep358({
      codelineFailures: [['a.spec.ts'], ['b.spec.ts'], ['c.spec.ts']],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
      baselineFailures: ['a.spec.ts'],
    });
    expect(r.out, `expected pass (nothing reproducible):\n${r.out}`).toMatch(/STEP_EMIT: 3\.58 pass/);
  });

  it('FAILS on a reproducible new failure even when unrelated flaky noise appears in only one attempt', () => {
    // Live gotransit shape: a genuinely new, reproducible failure
    // (c.spec.ts, present in every after-attempt) must still be caught even
    // though attempt 3 also has one-off flaky noise (d.spec.ts) that never
    // repeats. The noise must not mask the real regression, and it must not
    // itself be reported as a "new failure" either.
    const r = runStep358({
      codelineFailures: [
        ['a.spec.ts', 'c.spec.ts'],
        ['a.spec.ts', 'c.spec.ts'],
        ['a.spec.ts', 'c.spec.ts', 'd.spec.ts'],
      ],
      effort: 'high',
      testFailurePattern: '^FAIL\\s+(\\S+)',
      baselineFailures: ['a.spec.ts'],
    });
    expect(r.out, `expected the reproducible new failure to be caught:\n${r.out}`).toMatch(/STEP_EMIT: 3\.58 fail/);
    expect(r.out).toMatch(/c\.spec\.ts/);
    expect(r.out).not.toMatch(/d\.spec\.ts/);
  });
});
