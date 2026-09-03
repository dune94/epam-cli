/**
 * A BROWNFIELD STORY CANNOT BE FAILED FOR TESTS IT DID NOT BREAK.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Operator policy, verbatim: "For brownfield we can inherit existing test failures, but we
 * cannot be expected to fix them."
 *
 * The type-check path implements exactly that — run the check, run it again at the baseline
 * SHA, subtract by IDENTITY, and pass when every remaining failure is pre-existing:
 *
 *     [tsc-verify] the type check has only pre-existing baseline errors — none introduced
 *                  by this story
 *
 * run_external_verification, which runs the project's TEST suite, does none of it:
 *
 *     if [ "$test_exit" -ne 0 ]; then
 *         VERIFICATION_FAILURE=... "Fix the code so the tests pass."
 *         return 1
 *
 * A raw exit code. One pre-existing failing test fails the story on every attempt forever,
 * and the message instructs the writer to repair failures it did not cause — which for
 * brownfield is both impossible and against the stated policy. That is an UNWINNABLE GATE,
 * the same shape as the changeRequired one that cost three runs.
 *
 * LIVE, 2026-08-12. The failure analyst diagnosed it in plain text and the story failed anyway:
 *
 *     "Failing tests are pre-existing — schedules.spec.tsx fails identically with and
 *      without agent changes."
 *
 * Everything needed already exists and is already declared:
 *   - lib/tsc-baseline-gate.sh :: baseline_new_failures <root> <node> <logdir> [section] [out]
 *     was generalised off tsc earlier the same day and takes a SECTION.
 *   - .epam/verification.json declares BOTH `typecheck` AND `test`, each with failurePattern
 *     and failureIdentity. The `test` section has been sitting there unused.
 *
 * SUBTRACT ON IDENTITY, NEVER ON COUNTS. "745 passed -> 735 passed" says nothing about WHICH.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const PLUGIN = join(ROOT, 'orchestrations/plugins/verification-plugin.js');

/** The body of run_external_verification, braces balanced. */
function verificationFn(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('run_external_verification() {');
  expect(start, 'run_external_verification is gone — the test is stale, not the code').toBeGreaterThan(-1);
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

/** Comments stripped: a rule described in prose is not a rule the code follows. */
function verificationCode(): string {
  return verificationFn().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('the harness is anchored — otherwise these pass vacuously', () => {
  it('the function is found and substantial', () => {
    expect(verificationFn().length).toBeGreaterThan(2000);
  });

  it('the delta helper it needs exists and takes a section', () => {
    const gate = readFileSync(join(ROOT, 'orchestrations/scripts/lib/tsc-baseline-gate.sh'), 'utf8');
    expect(gate).toContain('baseline_new_failures()');
    expect(gate, 'the helper is still tsc-only').toMatch(/local section="\$\{4:-typecheck\}"/);
  });

  it('the plugin can parse and subtract test failures by identity', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const p = require(PLUGIN);
    expect(typeof p.parseFailures).toBe('function');
    expect(typeof p.newFailures).toBe('function');
    expect(p.newFailures(['a', 'b'], ['a'])).toEqual(['b']);
    // Equal counts, different sets — the trap a count-based diff walks into.
    expect(p.newFailures(['b'], ['a'])).toEqual(['b']);
  });
});

describe('THE TEST GATE SUBTRACTS A BASELINE', () => {
  it('THE DEFECT: it no longer fails the story on a raw exit code alone', () => {
    // Assert the CALL, not a mention. `command -v baseline_new_failures` names the function
    // in its guard, so a looser regex passes even when the invocation is deleted — caught by
    // mutation: removing the call left every assertion green.
    const code = verificationCode();
    expect(code, 'the delta is not actually computed — only guarded for')
      .toMatch(/=\$\(baseline_new_failures\b/);
  });

  it('it asks for the TEST section, not typecheck', () => {
    const code = verificationCode();
    const i = code.search(/=\$\(baseline_new_failures\b/);
    expect(i).toBeGreaterThan(-1);
    const call = code.slice(i, i + 300);
    expect(call, 'it would subtract type errors from a test run').toMatch(/"\$LOG_DIR" test\b/);
  });

  it('it hands over the ALREADY-CAPTURED output instead of re-running the suite', () => {
    // This runs per attempt, up to 8 times a story. Re-running the suite here would multiply
    // the most expensive gate in the run — the same reason the tsc path passes its output in.
    const code = verificationCode();
    const call = code.slice(code.indexOf('baseline_new_failures'), code.indexOf('baseline_new_failures') + 400);
    expect(call).toMatch(/mktemp|_test_out_file|\$test_output/);
  });
});

describe('EVERY FAILURE PRE-EXISTING MEANS THE STORY PASSES', () => {
  it('there is an explicit pass branch for an empty delta', () => {
    // The tsc path lost exactly this guard once: an empty delta fell through to the failure
    // branch and reported "TypeScript errors" with an EMPTY error list.
    const code = verificationCode();
    expect(code, 'an empty delta must PASS, not fall through to the failure branch')
      .toMatch(/pre-existing/i);
  });

  it('the pass branch returns 0', () => {
    const code = verificationCode();
    const i = code.search(/pre-existing/i);
    expect(i).toBeGreaterThan(-1);
    expect(code.slice(i, i + 300), 'it logs the policy and then fails anyway').toMatch(/return 0/);
  });
});

describe('THE WRITER IS NOT TOLD TO FIX WHAT IT DID NOT BREAK', () => {
  it('the failure message carries the NEW failures, not the whole suite output', () => {
    // The message is assembled from _test_head/_test_tail, which are built BEFORE the printf
    // — so the assertion is about what those are derived FROM, not about a window after it.
    // The tsc path feeds ${_new_errors:0:4000}; this path fed raw $test_output, so the writer
    // saw every pre-existing failure as if it were its own.
    const code = verificationCode();
    const head = code.match(/_test_head="\$\{([A-Za-z_]+):0:\d+\}"/);
    expect(head, '_test_head assignment not found — the test is stale').toBeTruthy();
    expect(head![1], 'the writer is still handed the entire suite output').toBe('_new_test_failures');
  });

  it('the instruction tells the writer the inherited failures are not its responsibility', () => {
    // "Fix the code so the tests pass" against an inherited red suite is an order it cannot
    // follow. Subtracting silently is not enough — the writer must know what it is looking at.
    expect(verificationCode()).toMatch(/YOUR CHANGES INTRODUCED/);
  });

  it('the helper is actually IN SCOPE here — a guarded call to a missing function is inert', () => {
    // `command -v baseline_new_failures` fails open to the old behaviour by design, so if the
    // library were not sourced this whole fix would silently do nothing. That is the exact
    // failure mode of the 2026-08-10 wall fix: correct code, never executed.
    const src = readFileSync(CLAUDE_SH, 'utf8');
    expect(src).toMatch(/source "\$SCRIPT_DIR\/lib\/story-guards\.sh"/);
    const guards = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-guards.sh'), 'utf8');
    expect(guards, 'story-guards.sh no longer loads the baseline gate').toMatch(/tsc-baseline-gate\.sh"/);
  });
});
