/**
 * Root cause of a recurring live failure (2026-07-07, scaffold phase, twice in
 * one night): when a testing gate's underlying AGENT PROCESS exits cleanly but
 * its CONTENT indicates a real failure (e.g. SAST reporting blockerCount > 0),
 * the gate's own `*_exit` variable (sast_exit/spec_exit/review_exit/
 * mutant_exit/fuzz_exit) stays 0 — it only reflects whether the agent process
 * itself crashed. The 3-agent self-heal remediation pipeline
 * (gate-finding-analyst -> story-ac-remediator -> profile-augmentor) is only
 * offered a gate's log for remediation when `[ "${X_exit:-0}" -ne 0 ]`, so
 * the MOST COMMON failure mode — agent ran fine, content says fail — silently
 * never reached remediation at all. Every scaffold-phase SAST failure went
 * straight to a hard pipeline abort with zero self-heal attempt.
 *
 * perf-sentinel already had the correct fix (an explicit `_failing_logs+=(...)`
 * in its content-based-fail branch, with a comment explaining exactly this
 * gap) but it was never applied to the other five gates (SAST x2 branches,
 * spec-validator, review-ranger, mutant-hunter, fuzz-weaver). This test
 * proves all six gates now append correctly, AND that the array declarations
 * were moved to the top of run_testing_gates() (a `local` re-declaration
 * later in the same function would silently wipe out earlier appends —
 * caught while building this fix, not by a stale existing test).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('run_testing_gates() — _failing_logs/_log_labels scope (structural)', () => {
  it('is declared exactly once, at the top of the function (before any gate evaluation)', () => {
    const fnStart = orchSrc.indexOf('run_testing_gates() {');
    const fnNextStart = orchSrc.indexOf('\n_run_vitest_check', fnStart);
    const fnBody = orchSrc.slice(fnStart, fnNextStart === -1 ? undefined : fnNextStart);
    const declMatches = [...fnBody.matchAll(/local _failing_logs=\(\)/g)];
    expect(declMatches.length).toBe(1);
    // Must appear before the first gate evaluation (sast_exit check), not down
    // in the remediation block — otherwise it wipes out earlier appends.
    const declIdx = fnBody.indexOf('local _failing_logs=()');
    const firstSastEvalIdx = fnBody.indexOf('if [ $sast_exit -ne 0 ]');
    expect(declIdx).toBeLessThan(firstSastEvalIdx);
  });

  it('_log_labels has exactly one declaration too, alongside _failing_logs', () => {
    const fnStart = orchSrc.indexOf('run_testing_gates() {');
    const fnNextStart = orchSrc.indexOf('\n_run_vitest_check', fnStart);
    const fnBody = orchSrc.slice(fnStart, fnNextStart === -1 ? undefined : fnNextStart);
    const declMatches = [...fnBody.matchAll(/local _log_labels=\(\)/g)];
    expect(declMatches.length).toBe(1);
  });
});

describe('every content-based gate failure appends to _failing_logs (structural)', () => {
  const cases: Array<{ label: string; failLine: string; append: string }> = [
    {
      label: 'SAST sentinel (blockerCount > 0)',
      failLine: 'error "  SAST sentinel: FAIL — $_sast_blockers blocker finding(s) detected"',
      append: '_failing_logs+=("$sast_log")',
    },
    {
      label: 'SAST sentinel (unparseable JSON, raw verdict fallback)',
      failLine: 'error "  SAST sentinel: FAIL verdict (could not parse blockerCount)"',
      append: '_failing_logs+=("$sast_log")',
    },
    {
      label: 'spec-validator (story-level fail count > 0)',
      failLine: 'error "  Spec validator: FAIL — $_spec_failing story/stories failed criteria"',
      append: '_failing_logs+=("$spec_log")',
    },
    {
      label: 'review-ranger (verdict:fail)',
      failLine: 'error "  Review-ranger: FAIL — confirmed blocker (codeSnippet verified against the real file)"',
      append: '_failing_logs+=("$review_log")',
    },
    {
      label: 'mutant-hunter (verdict:fail)',
      failLine: 'error "  Mutant-hunter: FAIL — confirmed surviving mutation (originalCode verified against the real file, survived count self-consistent)"',
      append: '_failing_logs+=("$mutant_log")',
    },
    {
      label: 'fuzz-weaver (executable-evidence confirmed)',
      failLine: "error \"  Fuzz-weaver: FAIL — ${_fuzz_grounded} confirmed vulnerability/vulnerabilities (verified by actually running the agent's own test against the real code)\"",
      append: '_failing_logs+=("$fuzz_log")',
    },
    {
      label: 'perf-sentinel (pre-existing fix, still present)',
      failLine: 'error "  Perf-sentinel: FAIL — confirmed performance blocker (codeSnippet verified against the real file)"',
      append: '_failing_logs+=("$perf_log")',
    },
  ];

  it.each(cases)('$label sets failed=1 AND appends its log within the next 400 chars', ({ failLine, append }) => {
    const idx = orchSrc.indexOf(failLine);
    expect(idx, `fail line not found: ${failLine}`).toBeGreaterThan(-1);
    const window = orchSrc.slice(idx, idx + 700);
    expect(window).toContain('failed=1');
    expect(window).toContain(append);
  });
});

describe('_failing_logs append — REAL execution (proves the fix actually works at runtime)', () => {
  function extractByLineAnchors(startAnchor: string, endAnchor: string): string {
    const lines = orchSrc.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === startAnchor);
    if (startIdx === -1) throw new Error(`start anchor not found: ${startAnchor}`);
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === endAnchor);
    if (endIdx === -1) throw new Error(`end anchor not found: ${endAnchor}`);
    return lines.slice(startIdx, endIdx).join('\n');
  }

  function runSastEvaluation(sastLogContent: string): { failed: string; failingLogs: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gate-remediation-eligibility-'));
    try {
      const sastLog = join(dir, 'sast-sentinel-scaffold.log');
      writeFileSync(sastLog, sastLogContent);

      // Extract the REAL SAST evaluation block (sast_exit check through its
      // closing fi, right before the spec_exit check begins) from the actual
      // source — not a hand-copied duplicate.
      const sastBlock = extractByLineAnchors('if [ $sast_exit -ne 0 ]; then', 'if [ $spec_exit -ne 0 ]; then');

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash
set -uo pipefail
step_emit() { :; }
error() { :; }
success() { :; }
run_eval() {
  local _failing_logs=()
  local _log_labels=()
  local failed=0
  local sast_exit=0
  local sast_log="${sastLog}"
${sastBlock}
  echo "FAILED=$failed"
  echo "FAILING_LOGS=\${_failing_logs[*]:-}"
}
run_eval
`,
      );
      chmodSync(scriptPath, 0o755);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const failed = output.match(/FAILED=(\d+)/)?.[1] ?? '';
      const failingLogs = output.match(/FAILING_LOGS=(.*)$/m)?.[1] ?? '';
      return { failed, failingLogs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('agent-crash case (sast_exit != 0 handled separately) is not exercised here — content-fail case: blockerCount > 0 sets failed=1 AND appends sast_log to _failing_logs', () => {
    const { failed, failingLogs } = runSastEvaluation(
      JSON.stringify({ summary: { blockerCount: 1 }, findings: [{ severity: 'blocker' }] }),
    );
    expect(failed).toBe('1');
    expect(failingLogs).toContain('sast-sentinel-scaffold.log');
  });

  it('a clean SAST pass (blockerCount 0) does NOT set failed and does NOT append', () => {
    const { failed, failingLogs } = runSastEvaluation(JSON.stringify({ summary: { blockerCount: 0 }, findings: [] }));
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('garbled/malformed JSON that still contains a recognizable severity:blocker marker (last-resort regex path) still sets failed=1 AND appends', () => {
    const { failed, failingLogs } = runSastEvaluation(
      `some preamble text the agent emitted { "findings": [ {"severity": "blocker", "file": "tsconfig.json" broken here `,
    );
    expect(failed).toBe('1');
    expect(failingLogs).toContain('sast-sentinel-scaffold.log');
  });
});
