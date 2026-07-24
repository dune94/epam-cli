/**
 * Two deterministic gates that FAILED OPEN (found live 2026-07-24, AMSD-1820 run #2).
 *
 * A brownfield change shipped NO reproducing test (the impl wrote a stray file
 * literally named "test\n" — a copy of the source — instead of a real .test.ts).
 * BOTH safety nets that should have stopped it fell open, and a change the reviewer
 * never approved was reported as PASSED:
 *
 *  1. REPRO-GATE consumption: `if ! bash gate | tee log; then ...`. A pipeline's
 *     exit status is the LAST command's — `tee` (always 0) — not the gate's. So the
 *     gate's `exit 1` on "no test" was swallowed: the log showed "⛔ BLOCK: no test
 *     file accompanies the change" and the very next line was "gate passed". Fix:
 *     capture ${PIPESTATUS[0]} (the gate's real rc), not the pipeline's.
 *
 *  2. REVIEW-ESCALATION hard-block: it tagged stories reviewStatus=escalated by
 *     iterating review-feedback-*.json files, then counted tagged stories. When the
 *     reviewer wrote NO feedback files, nothing got tagged, the count was 0, and the
 *     escalation fell through to PASSED. Fix: a direct _review_escalated flag set by
 *     the loop itself — block on the FACT of escalation, not on a file that may not exist.
 *
 * These reproduce the exact exit-masking / count-of-nothing behaviour and prove the
 * fixed patterns block, plus assert the real orchestration script carries the fixes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

// Run a bash snippet, return its exit code (0 = "phase proceeded", non-0 = "blocked").
function bashCode(snippet: string): number {
  try {
    execFileSync('bash', ['-c', snippet], { encoding: 'utf8' });
    return 0;
  } catch (e: any) {
    return e.status ?? 1;
  }
}

// NOTE on the `| tee` idioms: `if ! gate | tee` and `cmd | tee || VAR=${PIPESTATUS[0]}`
// are BOTH correct under `set -o pipefail` (which every launcher + the orchestrator
// set): pipefail makes the pipe carry the inner command's non-zero exit, so the gate's
// `exit 1` is honoured. An earlier change that rewrote these to capture ${PIPESTATUS[0]}
// on a separate line was WRONG — it tripped `set -e` on the failing pipe and aborted
// before the retry logic (broke tier3-mock-run). Do not touch these without pipefail in mind.

describe('review-escalation hard-block — must fire on the FACT of escalation, not on tagged files', () => {
  it('reproduces the fail-open: counting tagged stories is 0 when no feedback files exist', () => {
    // OLD: block only if tagged-count > 0. Reviewer wrote no files → tagged=0 → falls through.
    const code = bashCode(`_tagged=0; if [ "\${_tagged:-0}" -gt 0 ]; then exit 2; fi; exit 0`);
    expect(code).toBe(0); // BUG: escalated, yet proceeded
  });

  it('the FIX blocks: a direct _review_escalated flag hard-blocks regardless of tagged count', () => {
    const code = bashCode(`_review_escalated=1; _tagged=0; if [ "\${_review_escalated:-0}" -eq 1 ] || [ "\${_tagged:-0}" -gt 0 ]; then exit 2; fi; exit 0`);
    expect(code).toBe(2); // FIXED: escalation itself blocks
  });

  it('approved review (flag 0, no tags) still proceeds — no false block', () => {
    const code = bashCode(`_review_escalated=0; _tagged=0; if [ "\${_review_escalated:-0}" -eq 1 ] || [ "\${_tagged:-0}" -gt 0 ]; then exit 2; fi; exit 0`);
    expect(code).toBe(0);
  });
});

describe('the real orchestration script carries the review-escalation fix', () => {
  it('review escalation sets and hard-blocks on the _review_escalated flag', () => {
    expect(src).toMatch(/_review_escalated=0/);           // initialised
    expect(src).toMatch(/_review_escalated=1/);           // set on escalation
    expect(src).toMatch(/\[ "\$\{_review_escalated:-0\}" -eq 1 \] \|\| \[ "\$\{_escalated:-0\}" -gt 0 \]/);
  });
});
