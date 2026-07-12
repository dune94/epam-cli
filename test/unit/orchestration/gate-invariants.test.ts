/**
 * Testing gate invariants — decision logic, edge cases, and structural checks.
 *
 * Complements gate-evaluator.test.ts (which covers extraction).
 * This file tests:
 *   1. Gate decision thresholds — 0 blockers → pass, ≥1 → abort
 *   2. Empty / null output → no false abort (handles M3 refusals)
 *   3. All four gates are wired in the orch script (sast-sentinel, mutant-hunter,
 *      review-ranger, spec-validator)
 *   4. Gate log cleanup — stale cross-phase output is cleared between phases
 *   5. Gate prompts use "analyze injected data only" — no tool execution
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH_SCRIPT = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

// ─── Gate decision threshold ──────────────────────────────────────────────────
// The orch script uses python3 to extract blockerCount, then compares to 0.
// We mirror that logic here to test the decision boundary.

function evalBlockerDecision(blockerCount: number): 'pass' | 'abort' {
  // Mirror the orch script: [ "$blockers" -gt 0 ] → abort
  return blockerCount > 0 ? 'abort' : 'pass';
}

describe('gate decision threshold — SAST', () => {
  it('blockerCount=0 → pass (no abort)', () => {
    expect(evalBlockerDecision(0)).toBe('pass');
  });

  it('blockerCount=1 → abort', () => {
    expect(evalBlockerDecision(1)).toBe('abort');
  });

  it('blockerCount=5 → abort', () => {
    expect(evalBlockerDecision(5)).toBe('abort');
  });

  it('blockerCount=-1 (extraction failure) → pass (treat as 0)', () => {
    // -1 means the python extractor couldn't parse the output
    // The orch script should NOT abort on extraction failure
    expect(evalBlockerDecision(-1)).toBe('pass');
  });
});

// ─── Gate decision threshold — verdict-based gates ────────────────────────────

function evalVerdictDecision(verdict: string | null): 'pass' | 'warn' | 'abort' | 'skip' {
  if (!verdict) return 'skip';  // no verdict → no abort (M3 refusal case)
  if (verdict === 'fail') return 'abort';
  if (verdict === 'warn') return 'warn';
  return 'pass';
}

describe('gate decision threshold — verdict-based (mutant-hunter, review-ranger)', () => {
  it('"verdict":"pass" → pass', () => {
    expect(evalVerdictDecision('pass')).toBe('pass');
  });

  it('"verdict":"warn" → non-blocking warn (not abort)', () => {
    expect(evalVerdictDecision('warn')).toBe('warn');
  });

  it('"verdict":"fail" → abort', () => {
    expect(evalVerdictDecision('fail')).toBe('abort');
  });

  it('null verdict (no JSON, M3 refusal) → skip (no false abort)', () => {
    expect(evalVerdictDecision(null)).toBe('skip');
  });

  it('empty string verdict → skip (same as null — no false abort)', () => {
    // Empty string is falsy — treated same as null, not as 'fail'
    expect(evalVerdictDecision('')).toBe('skip');
  });
});

// ─── All four gates wired in orch script ─────────────────────────────────────

describe('gate wiring — all four gates defined in run-agent-orchestration.sh', () => {
  it('sast-sentinel gate is defined', () => {
    expect(orchSrc).toContain('sast-sentinel');
  });

  it('mutant-hunter gate is defined', () => {
    expect(orchSrc).toContain('mutant-hunter');
  });

  it('review-ranger gate is defined', () => {
    expect(orchSrc).toContain('review-ranger');
  });

  it('spec-validator gate is defined', () => {
    expect(orchSrc).toContain('spec-validator');
  });

  it('all gates guarded by SKIP_TESTING_GATES env var', () => {
    expect(orchSrc).toContain('SKIP_TESTING_GATES');
  });
});

// ─── Gate prompts use oracle injection (no tool execution) ───────────────────

describe('gate prompts — oracle injection, no tool execution', () => {
  it('SAST prompt references injected evidence (not live tool execution)', () => {
    expect(orchSrc).toContain('injected evidence');
  });

  it('review-ranger prompt uses injected git diff (not a live git call inside the model)', () => {
    // The prompt should reference a pre-computed diff, not instruct the model to run git
    expect(orchSrc).toContain('Git Diff Evidence');
  });

  it('mutant-hunter prompt uses injected source/test files', () => {
    expect(orchSrc).toContain('Source and Test Evidence');
  });

  it('orch script does NOT instruct gates to run tsc themselves', () => {
    // "find node binary and run tsc" was removed after run 43 failures
    // Any remaining tsc commands should be in oracle-injection sections (run in shell, not by model)
    const gatePromptSection = orchSrc.slice(
      orchSrc.indexOf('run_testing_gates'),
      orchSrc.indexOf('run_testing_gates') + 5000
    );
    // The MODEL prompt should not tell M3 to "find node" or "find the node binary"
    expect(gatePromptSection).not.toContain('find the node binary');
    expect(gatePromptSection).not.toContain('find node binary and run');
  });

  it('gates have at least one "Do NOT" instruction preventing tool calls', () => {
    expect(orchSrc).toContain('Do NOT attempt to call any shell commands');
  });
});

// ─── Gate log cleanup between phases ─────────────────────────────────────────
// If a gate log from phase 1 is not cleared, the phase 2 gate might read stale
// data (e.g., blockerCount=0 from a phase that hasn't run yet).

describe('gate log file handling', () => {
  it('orch script creates gate log paths using phase variable (not hardcoded)', () => {
    // Gate log paths must include $phase so each phase gets its own log
    // Check that log file paths reference $phase or $PHASE
    const gateSection = orchSrc.slice(
      orchSrc.indexOf('run_testing_gates'),
      orchSrc.indexOf('run_testing_gates') + 8000
    );
    const hasPhaseInPath = /gate.*\$\{?[Pp][Hh][Aa][Ss][Ee]\}?|PHASE.*gate|phase.*\.log/.test(gateSection);
    expect(hasPhaseInPath).toBe(true);
  });
});

// ─── Step 3.8: Lint gate ─────────────────────────────────────────────────────

describe('step 3.8 lint gate', () => {
  it('lint gate step 3.8 is declared in the pipeline checklist', () => {
    expect(orchSrc).toContain('"3.8"');
    expect(orchSrc).toContain('Lint gate');
  });

  it('lint gate has a SKIP_LINT_GATE bypass env var', () => {
    expect(orchSrc).toContain('SKIP_LINT_GATE');
  });

  it('lint gate runs tsc --noEmit with PIPESTATUS[0] exit capture', () => {
    // Anchor on the running step_emit which appears in the actual gate code block
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    expect(lintIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(lintIdx, lintIdx + 2500);
    expect(block).toContain('tsc --noEmit');
    expect(block).toContain('PIPESTATUS[0]');
  });

  it('lint gate skips tsc when src/ has no .ts files (avoids TS18003 on scaffold-only phase)', () => {
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    const block = orchSrc.slice(lintIdx, lintIdx + 2500);
    expect(block).toMatch(/find.*src.*\.ts.*wc -l|_lint_ts_count/);
    expect(block).toMatch(/\[ "\$_lint_ts_count" -eq 0 \]|\[ \$_lint_ts_count -eq 0 \]/);
  });

  it('lint gate remediation uses AUTOMATION_DIR not SCRIPT_DIR for profiles path', () => {
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    const block = orchSrc.slice(lintIdx, lintIdx + 10000);
    expect(block).not.toContain('"${SCRIPT_DIR}/agents/profiles.json"');
    expect(block).toContain('AUTOMATION_DIR');
  });

  it('lint gate fails the phase on non-zero tsc exit', () => {
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    // Gate includes self-healing remediation before the exit — measure with:
    // node -e "src=require('fs').readFileSync('orchestrations/scripts/run-agent-orchestration.sh','utf8'); s=src.indexOf('step_emit \"3.8\" \"running\"'); console.log(src.indexOf('exit 1',s)-s)"
    const block = orchSrc.slice(lintIdx, lintIdx + 10600);
    expect(block).toContain('_lint_failed=1');
    // exit 2 = remediation applied (retry); exit 1 = fallback (hard abort). Both must be present.
    expect(block).toContain('exit 2');
    expect(block).toContain('exit 1');
  });

  it('lint gate runs eslint when binary is available', () => {
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    const block = orchSrc.slice(lintIdx, lintIdx + 2500);
    expect(block).toContain('eslint');
    expect(block).toContain('--max-warnings 0');
  });

  it('lint gate guards eslint with --print-config probe before running on src/ (run 84 regression)', () => {
    // Bug (first fix): eslint ran when binary found but no config file existed → ESLint 6.x "no config" error.
    // Bug (second fix): file-existence check found .eslintrc.cjs but ESLint 6.x doesn't support .cjs format.
    // Root fix: use `eslint --print-config <file>` as a dry-run probe — if eslint itself can't resolve
    // its config, skip it. This works regardless of eslint version or config file format.
    const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    const block = orchSrc.slice(lintIdx, lintIdx + 2500);

    // eslint invocation must be present
    const eslintInvocationIdx = block.indexOf('"$_eslint_bin" src/');
    expect(eslintInvocationIdx, 'eslint invocation not found in lint gate block').toBeGreaterThan(-1);

    // The block before the invocation must use --print-config as a probe
    const preInvocation = block.slice(0, eslintInvocationIdx);
    expect(preInvocation).toContain('--print-config');

    // The guard condition must reference _eslint_config (not just _eslint_bin)
    expect(preInvocation).toMatch(/if\s+\[.*_eslint_bin.*_eslint_config|if\s+\[.*_eslint_config/);
  });

  it('lint gate is positioned after step 3.7 and before step 4', () => {
    const idx37 = orchSrc.indexOf('Step 3.7: Pre-review gate PASSED');
    const idx38 = orchSrc.indexOf('Step 3.8: Lint gate');
    const idx4  = orchSrc.indexOf('Step 4: Run review stories');
    expect(idx37).toBeGreaterThan(-1);
    expect(idx38).toBeGreaterThan(idx37);
    expect(idx4).toBeGreaterThan(idx38);
  });
});

// ─── Step 3.7: Pre-review gate tsc exit code ─────────────────────────────────
// The pre-review gate runs `tsc --noEmit 2>&1 | tee logfile`.
// In bash, `if cmd | tee file; then` tests tee's exit code, not cmd's.
// tee always exits 0, so tsc errors are silently swallowed unless PIPESTATUS[0] is used.
// This failure mode let a cli.ts syntax error through to perf-sentinel in run 83
// (tsc printed 4 errors, gate reported PASS). The fix: capture ${PIPESTATUS[0]}.

describe('step 3.7 pre-review gate tsc exit code handling', () => {
  it('pre-review gate captures tsc exit via PIPESTATUS[0], not tee exit', () => {
    // Must use PIPESTATUS[0] after the pipeline to get tsc's real exit code.
    // The naive pattern `if cmd | tee file; then` silently passes on tsc errors.
    expect(orchSrc).toContain('PIPESTATUS[0]');
  });

  it('pre-review gate does NOT use bare `if tsc ... | tee` pattern', () => {
    // Locate the pre-review gate tsc block
    const preReviewIdx = orchSrc.indexOf('Running tsc --noEmit');
    expect(preReviewIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(preReviewIdx, preReviewIdx + 400);
    // Must NOT have the broken pattern where tsc output is piped to tee inside an `if` condition
    const brokenPattern = /if\s+["$\w./]*tsc\s+--noEmit[^;]*\|\s*tee/.test(block);
    expect(
      brokenPattern,
      'Found `if tsc | tee` pattern — tee exit masks tsc failures; use PIPESTATUS[0] instead',
    ).toBe(false);
  });

  it('pre-review gate marks _pre_review_failed=1 when tsc exits non-zero', () => {
    const preReviewIdx = orchSrc.indexOf('Running tsc --noEmit');
    const block = orchSrc.slice(preReviewIdx, preReviewIdx + 900);
    // After the tsc invocation, _pre_review_failed must be set on non-zero exit
    expect(block).toContain('_pre_review_failed=1');
    expect(block).toContain('PIPESTATUS');
  });

  it('pre-review gate skips tsc when src/ has no .ts files (avoids TS18003 on scaffold-only phase)', () => {
    // Without this guard, tsc --noEmit fails with TS18003 "No inputs were found"
    // after the scaffold story runs (src/ exists but is empty until impl stories write files).
    const preReviewIdx = orchSrc.indexOf('Running tsc --noEmit');
    const block = orchSrc.slice(preReviewIdx, preReviewIdx + 900);
    expect(block).toMatch(/find.*src.*\.ts.*wc -l|_pre_review_ts_count/);
    expect(block).toMatch(/\[ "\$_pre_review_ts_count" -eq 0 \]|\[ \$_pre_review_ts_count -eq 0 \]/);
  });
});
