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

// ─── Step 20: Lint gate ─────────────────────────────────────────────────────

describe('step 3.8 lint gate', () => {
  it('lint gate step 3.8 is declared in the pipeline checklist', () => {
    expect(orchSrc).toContain('"20"');
    expect(orchSrc).toContain('Lint gate');
  });

  it('lint gate has a SKIP_LINT_GATE bypass env var', () => {
    expect(orchSrc).toContain('SKIP_LINT_GATE');
  });

  it('lint gate runs tsc --noEmit with PIPESTATUS[0] exit capture', () => {
    // Anchor on the running step_emit which appears in the actual gate code block
    const lintIdx = orchSrc.indexOf('step_emit "20" "running"');
    expect(lintIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(lintIdx, lintIdx + 2500);
    // The engine runs the project's DECLARED command; it no longer names a compiler.
    expect(block).toContain('_run_project_verification');
    expect(block).toContain('PIPESTATUS[0]');
  });

  it('lint gate verifies unconditionally — no stack precondition', () => {
    // The empty-src guard was REMOVED. Counting a language's files to decide whether to
    // verify meant "skip", which callers read as PASS, so any repository without that
    // language passed without being checked. runVerification reports UNKNOWN for a
    // project that declared nothing and callers treat non-zero as failure, so the
    // project's own declaration is the only condition — see
    // verification-gates-name-no-stack.test.ts for the sweep.
    expect(orchSrc).not.toMatch(/_lint_ts_count/);
  });

  it('lint gate remediation uses AUTOMATION_DIR not SCRIPT_DIR for profiles path', () => {
    const lintIdx = orchSrc.indexOf('step_emit "20" "running"');
    const block = orchSrc.slice(lintIdx, lintIdx + 10000);
    expect(block).not.toContain('"${SCRIPT_DIR}/agents/profiles.json"');
    expect(block).toContain('AUTOMATION_DIR');
  });

  it('lint gate fails the phase on non-zero tsc exit', () => {
    // WINDOW-FREE. This was slice(lintIdx, lintIdx + 13500) and broke when the gate
    // grew by 34 bytes — `exit 2` landed at +13534. A fixed byte window asserts the
    // length of a block, not its behaviour, and this is the third false failure of
    // that shape today. Bound by the NEXT step marker instead, so the block can
    // grow freely and the test still measures the right region.
    const lintIdx = orchSrc.indexOf('step_emit "20" "running"');
    const nextStep = orchSrc.indexOf('step_emit "21"', lintIdx);
    const block = orchSrc.slice(lintIdx, nextStep > lintIdx ? nextStep : undefined);
    expect(block).toContain('_lint_failed=1');
    // exit 2 = remediation applied (retry); exit 1 = fallback (hard abort). Both must be present.
    expect(block).toContain('exit 2');
    expect(block).toContain('exit 1');
  });

  it('lint gate runs eslint when binary is available', () => {
    // The verdict itself moved into lib/eslint-baseline-gate.sh (scoped to the
    // writers' output, judged against the phase baseline). This used to assert
    // the literal string `--max-warnings 0`; that flag is gone because the gate
    // now reads `-f json` and counts every message, severity 1 included — the
    // same contract expressed differently. The invariant it was protecting (a
    // warning still fails the gate) is behaviour, so it is tested as behaviour
    // in eslint-baseline-gate.test.ts rather than as a substring here.
    const lintIdx = orchSrc.indexOf('step_emit "20" "running"');
    const nextStep = orchSrc.indexOf('step_emit "21"', lintIdx);
    const block = orchSrc.slice(lintIdx, nextStep > lintIdx ? nextStep : undefined);
    expect(block).toContain('eslint');
    expect(block, 'the lint verdict is no longer delegated to the baseline-scoped gate')
      .toContain('eslint_baseline_gate');
    expect(block, 'a non-zero gate result must still fail the step').toContain('_lint_failed=1');
  });

  it('lint gate guards eslint with --print-config probe before running (run 84 regression)', () => {
    // Bug (first fix): eslint ran when binary found but no config file existed → ESLint 6.x "no config" error.
    // Bug (second fix): file-existence check found .eslintrc.cjs but ESLint 6.x doesn't support .cjs format.
    // Root fix: use `eslint --print-config <file>` as a dry-run probe — if eslint itself can't resolve
    // its config, skip it. This works regardless of eslint version or config file format.
    //
    // This test previously required the invocation `"$_eslint_bin" src/` to be
    // present — enshrining the very defect that killed the 2026-07-25 run: a
    // bare directory is expanded with --ext (default .js), so on a TypeScript
    // codeline it matched nothing and the gate failed having examined no files.
    // The probe requirement is real and stays; the bare-directory target does not.
    const lintIdx = orchSrc.indexOf('step_emit "20" "running"');
    const nextStep = orchSrc.indexOf('step_emit "21"', lintIdx);
    const block = orchSrc.slice(lintIdx, nextStep > lintIdx ? nextStep : undefined);

    const gateCallIdx = block.indexOf('eslint_baseline_gate "$PROJECT_ROOT"');
    expect(gateCallIdx, 'eslint gate invocation not found in lint gate block').toBeGreaterThan(-1);

    const preInvocation = block.slice(0, gateCallIdx);
    expect(preInvocation).toContain('--print-config');
    expect(preInvocation).toMatch(/if\s+\[.*_eslint_bin.*_eslint_config|if\s+\[.*_eslint_config/);
    expect(block, 'a bare directory target is back — it matches nothing on a TypeScript tree')
      .not.toContain('"$_eslint_bin" src/');
  });

  it('lint gate is positioned after step 3.7 and before step 4', () => {
    const idx37 = orchSrc.indexOf('Step 19: Pre-review gate PASSED');
    const idx38 = orchSrc.indexOf('Step 20: Lint gate');
    const idx4  = orchSrc.indexOf('Step 21: Running review stories');
    expect(idx37).toBeGreaterThan(-1);
    expect(idx38).toBeGreaterThan(idx37);
    expect(idx4).toBeGreaterThan(idx38);
  });
});

// ─── Step 19: Pre-review gate tsc exit code ─────────────────────────────────
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
    const preReviewIdx = orchSrc.indexOf("Running the project's declared type check");
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
    const preReviewIdx = orchSrc.indexOf("Running the project's declared type check");
    const block = orchSrc.slice(preReviewIdx, preReviewIdx + 3000);
    // After the tsc invocation, _pre_review_failed must be set on non-zero exit
    expect(block).toContain('_pre_review_failed=1');
    expect(block).toContain('PIPESTATUS');
  });

  it('pre-review gate verifies unconditionally — no stack precondition', () => {
    // The empty-src guard was REMOVED. Counting a language's files to decide whether to
    // verify meant "skip", which callers read as PASS, so any repository without that
    // language passed without being checked. runVerification reports UNKNOWN for a
    // project that declared nothing and callers treat non-zero as failure, so the
    // project's own declaration is the only condition — see
    // verification-gates-name-no-stack.test.ts for the sweep.
    expect(orchSrc).not.toMatch(/_pre_review_ts_count/);
  });
});

// ─── Spec validator: oracle injection (max-iterations fix) ────────────────────
// Root cause (2026-07-20): spec validator called tools to read files for each
// story in the phase. With 7 stories × ~3 reads = 21+ iterations, the 20-iter
// agent cap triggered before the JSON verdict was written. Fix: pre-inject git
// diff + key file excerpts so the agent concludes without any tool calls.

describe('spec validator — oracle injection (prevents max-iteration exhaustion)', () => {
  it('injects implementation evidence (git diff + file excerpts) before calling the gate', () => {
    // The impl evidence block must be built BEFORE _run_qa_gate_with_retry
    const specIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator"');
    expect(specIdx).toBeGreaterThan(-1);
    const before = orchSrc.slice(Math.max(0, specIdx - 9000), specIdx);
    expect(before).toContain('_spec_impl_evidence');
    expect(before).toContain('phase-baseline-sha.txt');
    expect(before).toContain('technicalNotes');
  });

  it('spec validator prompt tells the agent NOT to call tools', () => {
    const specIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator"');
    const before = orchSrc.slice(Math.max(0, specIdx - 6000), specIdx);
    expect(before).toMatch(/Do NOT call any tools|Do NOT attempt to call any/);
  });

  it('implementation evidence is injected into spec_prompt before gate call', () => {
    // $_spec_impl_evidence must appear in the spec_prompt assignment that
    // precedes _run_qa_gate_with_retry — proving it reaches the agent.
    const specIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator"');
    const before = orchSrc.slice(Math.max(0, specIdx - 1500), specIdx);
    expect(before).toContain('$_spec_impl_evidence');
  });

  it('spec validator prompt instructs untestable classification when evidence insufficient', () => {
    const specIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator"');
    const before = orchSrc.slice(Math.max(0, specIdx - 6000), specIdx);
    expect(before).toContain('untestable');
  });
});

// ─── Gate retry: oracle-aware prefix (mutant-hunter no-output fix) ────────────
// Root cause (2026-07-20): _run_qa_gate_with_retry retry prefix told the model
// "Use ReadFile and Bash tools" even when the gate prompt already contained
// pre-injected oracle evidence and a "Do NOT attempt to call any shell commands"
// instruction. The contradiction caused the model to produce no structured output
// on both attempts. Fix: detect the no-tools contract from the prompt itself and
// emit a retry prefix that stays consistent — "re-analyze the pre-injected
// evidence" instead of "use tools now".

describe('_run_qa_gate_with_retry — oracle-aware retry prefix', () => {
  // Extract the full function body rather than a fixed character slice,
  // so the tests don't silently break when the function grows.
  function extractRetryFn(): string {
    const retryIdx = orchSrc.indexOf('_run_qa_gate_with_retry()');
    expect(retryIdx).toBeGreaterThan(-1);
    // Function ends at the first top-level closing brace after the opening
    const bodyStart = orchSrc.indexOf('{', retryIdx);
    // Find the matching closing brace by counting depth
    let depth = 0;
    let i = bodyStart;
    while (i < orchSrc.length) {
      if (orchSrc[i] === '{') depth++;
      else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
      i++;
    }
    return orchSrc.slice(retryIdx, i + 1);
  }

  it('retry function detects no-tools contract via prompt content, not hardcoded gate name', () => {
    const block = extractRetryFn();
    expect(block).toContain('Do NOT attempt to call any shell commands');
    expect(block).not.toMatch(/mutant-hunter|spec-validator|sast/);
  });

  it('oracle-injected prompts get a retry prefix that does NOT say "Use ReadFile and Bash tools"', () => {
    const block = extractRetryFn();
    const oracleBranchIdx = block.indexOf('Re-analyze the pre-injected evidence');
    expect(oracleBranchIdx).toBeGreaterThan(-1);
    const oracleBranch = block.slice(oracleBranchIdx, oracleBranchIdx + 250);
    expect(oracleBranch).not.toContain('Use ReadFile and Bash tools');
  });

  it('non-oracle prompts still get the tool-using retry prefix', () => {
    const block = extractRetryFn();
    expect(block).toContain('Use ReadFile and Bash tools to read the relevant source files now');
  });

  it('oracle branch retry prefix still instructs the model not to call tools', () => {
    const block = extractRetryFn();
    const oracleBranchIdx = block.indexOf('Re-analyze the pre-injected evidence');
    const oracleBranch = block.slice(oracleBranchIdx, oracleBranchIdx + 250);
    expect(oracleBranch).toMatch(/Do NOT call any tools/);
  });
});
