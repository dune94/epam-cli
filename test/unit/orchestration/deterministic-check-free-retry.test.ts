/**
 * Architectural refinement to the deterministic pre-test checks (relative-
 * import-check, mock-completeness-check): before this fix, a violation these
 * checks found still went through the FULL expensive path — coordinator
 * escalation assessment, then run_failure_analyst's gate-model call to
 * "diagnose" something the check's own message already named precisely
 * (e.g. "missing method(s): getApiKey") — and the retry still counted against
 * retry_count/the model-escalation ladder, even though a mechanical "you
 * missed a spot" violation is not evidence of a capability gap the way a real
 * test failure is.
 *
 * Fix: DETERMINISTIC_CHECK_FAILURE (set by run_external_verification when
 * either check fails) routes the retry loop to:
 *   1. Skip run_failure_analyst entirely — inject the check's own
 *      VERIFICATION_FAILURE message directly as retry guidance instead.
 *   2. Grant up to 3 FREE retries that do NOT advance retry_count (so they
 *      don't consume ladder budget) — falling through to a normal counted
 *      retry after that, to bound the loop.
 *
 * This required a related fix: COORDINATOR_PROMPT_AMENDMENT injection was
 * gated on `retry_count -gt 0`, but a free retry (by design) never advances
 * retry_count — so a violation on the very first attempt would never see its
 * own guidance on the free-retry attempt. Introduced `_total_attempts`
 * (advances on every real invocation, unlike retry_count) for this gate
 * instead, and reset COORDINATOR_PROMPT_AMENDMENT per-story (it's a
 * script-global that a prior story's failure could otherwise leak forward
 * from, since run_implementation() processes multiple stories per invocation).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// Naive `indexOf('\n}', start)` extraction breaks on same_root_cause_diagnoses():
// its embedded Python heredoc has a multi-line STOPWORDS set literal whose
// closing `}` sits at column 0, so a naive search stops there and truncates the
// heredoc — producing a script with an unterminated `<<'PYEOF'` block. Scan
// line-by-line tracking heredoc state instead, same pattern used elsewhere for
// check_healing_effectiveness/generate_story_contract.
function extractHeredocAwareFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  let inHeredoc = false;
  let heredocDelim = '';
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    if (!inHeredoc) {
      const m = line.match(/<<-?\s*'?(\w+)'?/);
      if (m) {
        inHeredoc = true;
        heredocDelim = m[1];
        continue;
      }
      if (line === '}') return body.join('\n');
    } else if (line.trim() === heredocDelim) {
      inHeredoc = false;
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('claude.sh — DETERMINISTIC_CHECK_FAILURE design', () => {
  it('run_external_verification resets DETERMINISTIC_CHECK_FAILURE=0 at the start', () => {
    const fnStart = claudeSrc.indexOf('run_external_verification() {');
    const nearby = claudeSrc.slice(fnStart, fnStart + 400);
    expect(nearby).toMatch(/DETERMINISTIC_CHECK_FAILURE=0/);
  });

  it('relative-import-check failure sets DETERMINISTIC_CHECK_FAILURE=1 before returning', () => {
    const idx = claudeSrc.indexOf('[relative-import-check] Broken import detected');
    const block = claudeSrc.slice(idx, idx + 200);
    expect(block).toMatch(/DETERMINISTIC_CHECK_FAILURE=1/);
  });

  it('mock-completeness-check failure sets DETERMINISTIC_CHECK_FAILURE=1 before returning', () => {
    const idx = claudeSrc.indexOf('[mock-completeness-check] Incomplete vi.mock() factory detected');
    const block = claudeSrc.slice(idx, idx + 200);
    expect(block).toMatch(/DETERMINISTIC_CHECK_FAILURE=1/);
  });

  it('the retry loop skips run_failure_analyst when DETERMINISTIC_CHECK_FAILURE is set, injecting VERIFICATION_FAILURE directly instead', () => {
    const idx = claudeSrc.indexOf('Skipping failure-analyst — violation already precisely known');
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx - 100, idx + 400);
    expect(block).toMatch(/COORDINATOR_PROMPT_AMENDMENT="\$\{_existing_amendment\}/);
    expect(block).toContain('${VERIFICATION_FAILURE}');
  });

  it('grants up to 3 free retries that do NOT advance retry_count', () => {
    const idx = claudeSrc.indexOf('_free_retry_count" -lt 3');
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx - 50, idx + 450);
    expect(block).toMatch(/_free_retry_count=\$\(\(_free_retry_count \+ 1\)\)/);
    expect(block).toMatch(/\bcontinue\b/);
  });

  it('falls through to a normal counted retry after 3 free retries (does not loop forever)', () => {
    const capIdx = claudeSrc.indexOf('_free_retry_count" -lt 3');
    const afterCapBlock = claudeSrc.slice(capIdx, capIdx + 600);
    // The "continue" is inside the if-branch (< 3); falling past it reaches the
    // unconditional retry_count increment below.
    const continueIdx = afterCapBlock.indexOf('continue');
    const retryIncrementIdx = afterCapBlock.indexOf('retry_count=$((retry_count + 1))');
    expect(continueIdx).toBeGreaterThan(-1);
    expect(retryIncrementIdx).toBeGreaterThan(continueIdx);
  });

  it('resets DETERMINISTIC_CHECK_FAILURE=0 unconditionally before falling through (no bleed into the next real attempt)', () => {
    const capIdx = claudeSrc.indexOf('_free_retry_count" -lt 3');
    const block = claudeSrc.slice(capIdx, capIdx + 700);
    const occurrences = [...block.matchAll(/DETERMINISTIC_CHECK_FAILURE=0/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // once inside free-retry branch, once after
  });
});

describe('claude.sh — _total_attempts fixes the amendment-injection gate for free retries', () => {
  it('implement_story declares _total_attempts and increments it every loop iteration (unlike retry_count)', () => {
    const fnStart = claudeSrc.indexOf('implement_story() {');
    // Widened from 800 (2026-07-12): the retry-extension-coordinator's
    // MAX_RETRIES shadow-local + explanatory comment pushed this declaration
    // further into the function.
    const nearby = claudeSrc.slice(fnStart, fnStart + 1600);
    expect(nearby).toMatch(/local _total_attempts=0/);
    const loopIdx = claudeSrc.indexOf('while [ $retry_count -le $MAX_RETRIES ]; do');
    const afterLoop = claudeSrc.slice(loopIdx, loopIdx + 200);
    expect(afterLoop).toMatch(/_total_attempts=\$\(\(_total_attempts \+ 1\)\)/);
  });

  it('COORDINATOR_PROMPT_AMENDMENT injection is gated on _total_attempts, not retry_count', () => {
    const idx = claudeSrc.indexOf('Inject coordinator prompt amendment when available');
    const block = claudeSrc.slice(idx, idx + 400);
    expect(block).toMatch(/\[ "\$_total_attempts" -gt 1 \]/);
    expect(block).not.toMatch(/\[ "\$retry_count" -gt 0 \] && \[ -n "\$\{COORDINATOR_PROMPT_AMENDMENT/);
  });

  it('implement_story resets COORDINATOR_PROMPT_AMENDMENT="" per-story (prevents cross-story leak in multi-story invocations)', () => {
    const fnStart = claudeSrc.indexOf('implement_story() {');
    const loopStart = claudeSrc.indexOf('while [ $retry_count -le $MAX_RETRIES ]; do', fnStart);
    const preLoop = claudeSrc.slice(fnStart, loopStart);
    expect(preLoop).toContain('COORDINATOR_PROMPT_AMENDMENT=""');
  });
});

describe('deterministic-check free-retry loop — REAL execution', () => {
  function extractRetryTailBlock(): string {
    const startMarker = '# Layer 3: failure analyst — diagnose test failure and patch PRD or inject';
    const start = claudeSrc.indexOf(startMarker);
    // End right after the "if retry_count -le MAX_RETRIES ... sleep ... fi" block,
    // BEFORE the outer wrapper's own closing fi (which was opened long before
    // this snippet and must not be included standalone).
    const sleepIdx = claudeSrc.indexOf('sleep $RETRY_DELAY', start);
    const closingFiIdx = claudeSrc.indexOf('\n            fi', sleepIdx) + '\n            fi'.length;
    return claudeSrc.slice(start, closingFiIdx);
  }

  function runSimulation(resolveAfterAttempt: number, maxTestIterations: number): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'free-retry-sim-'));
    try {
      const block = extractRetryTailBlock();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `MAX_RETRIES=7
RETRY_DELAY=0
log() { :; }
warning() { echo "W: $*"; }
error() { echo "E: $*"; }
run_failure_analyst() { echo "CALLED_FAILURE_ANALYST retry=$3"; }
# Stub — these tests never populate _prev_deterministic_violation across
# iterations, so the repeat-detector's comparison is never meaningfully
# exercised here (see the dedicated boilerplate-regression describe block
# below for real same_root_cause_diagnoses coverage). Without this stub bash
# prints a harmless but noisy "command not found" to stderr.
same_root_cause_diagnoses() { echo "false"; }

simulate() {
    local story_id="SKY-004"
    local story_cli="epam"
    local retry_count=0
    local _free_retry_count=0
    local _total_attempts=0
    COORDINATOR_PROMPT_AMENDMENT=""
    local attempt_no=0

    while [ $retry_count -le $MAX_RETRIES ]; do
        _total_attempts=$((_total_attempts + 1))
        attempt_no=$((attempt_no + 1))
        inject="no"
        if [ "$_total_attempts" -gt 1 ] && [ -n "\${COORDINATOR_PROMPT_AMENDMENT:-}" ]; then
            inject="yes"
        fi
        echo "attempt_no=$attempt_no retry_count=$retry_count total=$_total_attempts free=$_free_retry_count inject=$inject"
        if [ $attempt_no -le ${resolveAfterAttempt} ]; then
            DETERMINISTIC_CHECK_FAILURE=1
            VERIFICATION_FAILURE="violation #$attempt_no"
        else
            DETERMINISTIC_CHECK_FAILURE=0
            VERIFICATION_FAILURE=""
        fi

${block}

        if [ $attempt_no -ge ${maxTestIterations} ]; then
            break
        fi
    done
}
simulate
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      return output.trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('grants exactly 3 free retries (retry_count stays 0) before falling through to a counted retry on the 4th unresolved violation', () => {
    const lines = runSimulation(4, 6);
    expect(lines[0]).toBe('attempt_no=1 retry_count=0 total=1 free=0 inject=no');
    expect(lines[2]).toBe('attempt_no=2 retry_count=0 total=2 free=1 inject=yes');
    expect(lines[4]).toBe('attempt_no=3 retry_count=0 total=3 free=2 inject=yes');
    expect(lines[6]).toBe('attempt_no=4 retry_count=0 total=4 free=3 inject=yes');
    // 5th attempt: cap reached on attempt 4, so retry_count finally advances to 1
    expect(lines[8]).toBe('attempt_no=5 retry_count=1 total=5 free=3 inject=yes');
  });

  it('once the violation resolves, run_failure_analyst is called again and retry_count advances normally (ladder resumes)', () => {
    const lines = runSimulation(1, 4);
    // attempt 1: deterministic-check failure -> free retry, retry_count stays 0
    expect(lines[0]).toBe('attempt_no=1 retry_count=0 total=1 free=0 inject=no');
    // attempt 2: now "resolved" (a real failure) -> failure-analyst called, retry_count advances
    expect(lines).toContain('attempt_no=2 retry_count=0 total=2 free=1 inject=yes');
    const analystCallLine = lines.find(l => l.startsWith('CALLED_FAILURE_ANALYST'));
    expect(analystCallLine).toBe('CALLED_FAILURE_ANALYST retry=0');
  });

  it('amendment is NOT injected on the very first attempt of a story (no prior failure yet)', () => {
    const lines = runSimulation(1, 2);
    expect(lines[0]).toMatch(/inject=no$/);
  });

  it('amendment IS injected starting from the second attempt onward, even though retry_count is still 0 during free retries', () => {
    const lines = runSimulation(3, 3);
    const secondAttemptLine = lines.find(l => l.startsWith('attempt_no=2'));
    expect(secondAttemptLine).toMatch(/retry_count=0/);
    expect(secondAttemptLine).toMatch(/inject=yes$/);
  });
});

/**
 * Regression for a false-positive found live (SKY-003 sandbox test #3,
 * 2026-07-05): the deterministic-check repeat-detector compared RAW
 * VERIFICATION_FAILURE text (including each check's fixed templated preamble,
 * e.g. "## Verification Failure\n\nA relative import does not resolve to a
 * real file... anything else:\n\n") between attempts. Every deterministic
 * check shares near-identical boilerplate phrasing PLUS the same recurring
 * file/class names for a given story — so a genuinely DIFFERENT violation
 * (relative-import-check, then on the very next attempt an unrelated
 * mock-completeness-check about a different file) scored an 11-token overlap
 * (ratio 0.52) purely from shared generic words ("anything", "else", "real",
 * "test", "will", "failure", "verification") and the story's own file/class
 * names ("client", "skyscanner") — well above the 0.4 match threshold — and
 * was incorrectly treated as a repeat, jumping the ladder rung for no reason.
 *
 * Fix: strip each message's templated intro (everything through the first
 * ":\n\n", which is exactly where every check's boilerplate sentence ends
 * and its check-specific detail lines begin) before comparing.
 */
describe('deterministic-check repeat-detector — does NOT false-positive on boilerplate (regression)', () => {
  const RELATIVE_IMPORT_MSG = `
## Verification Failure

A relative import does not resolve to a real file — this will fail immediately when the test suite runs. Fix the import path before anything else:

src/cli.ts: imports './skyscanner/client.js' which does not exist. Did you mean './skyscanner/client'? (found at src/skyscanner/client.ts)
`;

  const MOCK_COMPLETENESS_MSG = `
## Verification Failure

A vi.mock() factory is missing method(s) that the real class exports — any test calling a missing method will throw "X is not a function". Add the missing method(s) to the mock before anything else:

src/cli.test.ts: vi.mock() factory for 'SkyscannerClient' (from './skyscanner/client' -> src/skyscanner/client.ts) is missing method(s): for, if
`;

  it('claude.sh strips the templated intro (everything through the first ":\\n\\n") before comparing violations for repeats', () => {
    const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
    const idx = claudeSrc.indexOf('_prev_violation_detail=');
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx, idx + 500);
    expect(block).toMatch(/_prev_deterministic_violation#\*:\$'\\n'\$'\\n'/);
    expect(block).toMatch(/VERIFICATION_FAILURE#\*:\$'\\n'\$'\\n'/);
    // The comparison must use the STRIPPED detail variables, not the raw messages
    expect(block).toMatch(/same_root_cause_diagnoses "\$_prev_violation_detail" "\$_cur_violation_detail"/);
  });

  it('REAL execution: raw (unstripped) boilerplate text alone crosses the match threshold — proves the bug was real, not hypothetical', () => {
    const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
    const fnBody = extractHeredocAwareFunctionBody('same_root_cause_diagnoses');

    const dir = mkdtempSync(join(tmpdir(), 'boilerplate-fp-test-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `${fnBody}
a=$(cat <<'MSGEOF'
${RELATIVE_IMPORT_MSG}
MSGEOF
)
b=$(cat <<'MSGEOF'
${MOCK_COMPLETENESS_MSG}
MSGEOF
)
same_root_cause_diagnoses "$a" "$b"
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      expect(output).toBe('true'); // documents the bug: raw comparison DOES false-positive
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL execution: after stripping the templated intro, two genuinely DIFFERENT violations are correctly NOT treated as a repeat', () => {
    const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
    const fnBody = extractHeredocAwareFunctionBody('same_root_cause_diagnoses');

    const dir = mkdtempSync(join(tmpdir(), 'boilerplate-fix-test-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `${fnBody}
a=$(cat <<'MSGEOF'
${RELATIVE_IMPORT_MSG}
MSGEOF
)
b=$(cat <<'MSGEOF'
${MOCK_COMPLETENESS_MSG}
MSGEOF
)
a_detail="\${a#*:$'\\n'$'\\n'}"
b_detail="\${b#*:$'\\n'$'\\n'}"
same_root_cause_diagnoses "$a_detail" "$b_detail"
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      expect(output).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL execution: after stripping, a GENUINE repeat (same violation worded identically) is still correctly detected', () => {
    const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
    const fnBody = extractHeredocAwareFunctionBody('same_root_cause_diagnoses');

    const dir = mkdtempSync(join(tmpdir(), 'boilerplate-genuine-repeat-test-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `${fnBody}
a=$(cat <<'MSGEOF'
${RELATIVE_IMPORT_MSG}
MSGEOF
)
a_detail="\${a#*:$'\\n'$'\\n'}"
same_root_cause_diagnoses "$a_detail" "$a_detail"
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      expect(output).toBe('true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full pipeline REAL execution: the retry loop no longer treats two different deterministic-check violations as a repeat', () => {
    const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
    const startMarker = '# Layer 3: failure analyst — diagnose test failure and patch PRD or inject';
    const start = claudeSrc.indexOf(startMarker);
    const sleepIdx = claudeSrc.indexOf('sleep $RETRY_DELAY', start);
    const closingFiIdx = claudeSrc.indexOf('\n            fi', sleepIdx) + '\n            fi'.length;
    const block = claudeSrc.slice(start, closingFiIdx);

    const sameRootCauseFn = extractHeredocAwareFunctionBody('same_root_cause_diagnoses');

    const dir = mkdtempSync(join(tmpdir(), 'full-pipeline-boilerplate-test-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `MAX_RETRIES=7
RETRY_DELAY=0
log() { :; }
warning() { echo "W: $*"; }
error() { echo "E: $*"; }
run_failure_analyst() { :; }
${sameRootCauseFn}

simulate() {
    local story_id="SKY-003"
    local story_cli="epam"
    local retry_count=0
    local _free_retry_count=0
    local _total_attempts=0
    local _prev_deterministic_violation=""
    COORDINATOR_PROMPT_AMENDMENT=""
    local attempt_no=0

    local RELATIVE_IMPORT_MSG
    RELATIVE_IMPORT_MSG=$(cat <<'MSGEOF'
${RELATIVE_IMPORT_MSG}
MSGEOF
)
    local MOCK_COMPLETENESS_MSG
    MOCK_COMPLETENESS_MSG=$(cat <<'MSGEOF'
${MOCK_COMPLETENESS_MSG}
MSGEOF
)

    while [ $retry_count -le $MAX_RETRIES ]; do
        # Stop BEFORE processing a 3rd attempt — checked at the top of the loop
        # because the free-retry branch inside \${block} does its own \`continue\`,
        # which would otherwise skip a bottom-of-loop break check entirely and
        # keep the loop running past the 2 attempts this test actually needs.
        if [ $attempt_no -ge 2 ]; then
            break
        fi
        _total_attempts=$((_total_attempts + 1))
        attempt_no=$((attempt_no + 1))
        echo "attempt_no=$attempt_no retry_count=$retry_count"
        DETERMINISTIC_CHECK_FAILURE=1
        if [ $attempt_no -eq 1 ]; then
            VERIFICATION_FAILURE="$RELATIVE_IMPORT_MSG"
        else
            VERIFICATION_FAILURE="$MOCK_COMPLETENESS_MSG"
        fi

${block}
    done
}
simulate
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      // Two DIFFERENT violations in a row must each get their own free retry —
      // neither should trigger HealingBroken/rung-skip.
      expect(output).not.toContain('HealingBroken');
      expect(output).toContain('Free retry 1/3');
      expect(output).toContain('Free retry 2/3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
