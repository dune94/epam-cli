/**
 * B25 — the reviewer fails leaving NO evidence at all.
 *
 * Live (metrolinx 21:25 run): Step 3.6 escalated twice with "the REVIEWER did not
 * produce a verdict", and `review-agent-AMSD-1820.log` was NEVER WRITTEN — a
 * filesystem-wide search for any copy newer than the run start found nothing. So
 * the one artifact that would explain the failure does not exist.
 *
 * Hypotheses ELIMINATED by direct check (not assumption):
 *   - ai-run.sh not executable -> it IS executable, and the distinctive
 *     "reviewer unavailable" message never appears in the run log.
 *   - iteration thrash -> raising 12 -> 25 changed nothing, and there is no
 *     "reached maximum iterations" line from this run either.
 *
 * Three mechanism guesses were already wrong today (LLM latency, 48 processes, a
 * flat ladder), each from inference over evidence. So this does not guess a fourth:
 * it makes the failure OBSERVABLE so the next run supplies facts.
 *
 * The gap: REVIEW_OUTPUT is captured via `$(... | tee "$REVIEW_OUTPUT_FILE")`, so
 * if the invocation dies before producing stdout there is nothing to tee and no
 * file appears. Exit status and stderr are lost. Anything that cannot explain its
 * own failure will be re-diagnosed by guesswork every time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REVIEW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');

describe('B25 — a failed review must leave evidence', () => {
  it('records the review invocation exit status', () => {
    expect(REVIEW).toMatch(/_review_rc=|_review_exit=/);
  });

  it('writes a diagnostic line even when the agent produced NOTHING', () => {
    // The empty case is exactly the one that left no trace.
    expect(REVIEW).toMatch(/no output|produced nothing|empty output|0 bytes/i);
  });

  it('always creates the review log file, even on an empty result', () => {
    // `$(... | tee FILE)` never creates FILE if the pipeline dies before stdout.
    expect(REVIEW).toMatch(/touch "\$REVIEW_OUTPUT_FILE"|: > "\$REVIEW_OUTPUT_FILE"/);
  });

  it('logs the resolved model and provider so a bad route is visible', () => {
    expect(REVIEW).toMatch(/review-agent.*model|model=\$_model|_model.*provider/i);
  });

  it('still never auto-approves an unreviewed change', () => {
    // Observability must not weaken the fail-safe.
    expect(REVIEW).toMatch(/changes_requested/);
    expect(REVIEW).toMatch(/reviewIncomplete/);
  });
});
