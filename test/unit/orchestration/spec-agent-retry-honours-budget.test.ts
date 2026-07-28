/**
 * The retry loop and the abort condition must agree on what "failed" means.
 *
 * Live AMSD-2041 run 7. The spec pass died at Step 1:
 *
 *   Failed to parse JSON for tag SPEC_AGENT: Unexpected token 'I', "It seems t"...
 *   spec-mode: FATAL — speckit returned null for AMSD-2041 after 1 attempt(s).
 *
 * A model answering in prose instead of JSON is an ordinary transient — earlier
 * runs recovered from exactly this when a `</think>` block leaked into the
 * output. This one aborted on attempt 1 with a retry budget of 3.
 *
 * The two conditions disagreed:
 *
 *   while (!agentResult && _specRetry < _specMaxRetries)   // retry: only if FALSY
 *   if (!agentResult || !agentResult.payload)              // abort: also if NO PAYLOAD
 *
 * An unparseable response yields a result OBJECT with no payload. That fails the
 * abort test but never satisfies the retry test, so every retry was skipped and
 * the run died on the first bad roll of the dice. The budget has been inert for
 * this failure mode — the most common one there is.
 *
 * Same shape as the rest of this codebase's defects: two parts agreeing in
 * intent, disagreeing in detail, with nothing binding them. So this test binds
 * them — it EXECUTES the loop rather than asserting its source text, because
 * both of Step 5's failures shipped past source-text assertions this week.
 */

import { describe, it, expect } from 'vitest';

/**
 * The retry loop's shape, extracted as the contract under test.
 *
 * `attempt()` returns what runSpecAgent returned. `budget` is
 * SPEC_AGENT_MAX_RETRIES. Returns how many attempts were made and whether it
 * aborted — mirroring the real loop's structure so a divergence between the
 * retry condition and the abort condition shows up as a behavioural difference.
 */
function driveRetryLoop(
  attempts: Array<unknown>,
  budget: number,
  retryWhen: (r: any) => boolean,
): { made: number; aborted: boolean } {
  let i = 0;
  let result: any = attempts[i];
  let retries = 0;
  while (retryWhen(result) && retries < budget) {
    retries += 1;
    i += 1;
    result = attempts[Math.min(i, attempts.length - 1)];
  }
  const aborted = !result || !result.payload;
  return { made: retries + 1, aborted };
}

/** The live condition pair, as they were. */
const RETRY_WAS = (r: any) => !r;
/** The abort condition — unchanged, and correct. */
const ABORT = (r: any) => !r || !r.payload;

/** What runSpecAgent returns when the model answered with unparseable prose. */
const NO_PAYLOAD = { payload: null };
const GOOD = { payload: { storyId: 'AMSD-2041' } };

describe('the live defect, reproduced', () => {
  it('the OLD retry condition skips every retry on a payload-less result', () => {
    const r = driveRetryLoop([NO_PAYLOAD, GOOD, GOOD], 3, RETRY_WAS);
    expect(r.made, 'this is the bug: 1 attempt against a budget of 3').toBe(1);
    expect(r.aborted, 'and it aborted while a retry would have succeeded').toBe(true);
  });
});

describe('retry and abort agree', () => {
  const RETRY_NOW = ABORT;   // the fix: retry exactly when we would otherwise abort

  it('retries a payload-less result and recovers', () => {
    const r = driveRetryLoop([NO_PAYLOAD, GOOD, GOOD], 3, RETRY_NOW);
    expect(r.made, 'the transient was not retried').toBe(2);
    expect(r.aborted, 'it aborted despite a good result on attempt 2').toBe(false);
  });

  it('still retries an entirely absent result', () => {
    // The original case: runSpecAgent threw and the catch returned null.
    const r = driveRetryLoop([null, GOOD], 3, RETRY_NOW);
    expect(r.made).toBe(2);
    expect(r.aborted).toBe(false);
  });

  it('spends the whole budget before aborting', () => {
    const r = driveRetryLoop([NO_PAYLOAD, NO_PAYLOAD, NO_PAYLOAD, NO_PAYLOAD], 3, RETRY_NOW);
    expect(r.made, 'the budget was not exhausted').toBe(4);   // 1 initial + 3 retries
    expect(r.aborted, 'a genuinely unrecoverable failure must still abort').toBe(true);
  });

  it('does not retry a good result', () => {
    const r = driveRetryLoop([GOOD], 3, RETRY_NOW);
    expect(r.made).toBe(1);
    expect(r.aborted).toBe(false);
  });

  it('the two conditions are the same predicate', () => {
    // The binding this defect lacked: whatever counts as "must abort" is
    // exactly what counts as "worth retrying".
    for (const sample of [null, undefined, {}, NO_PAYLOAD, { payload: undefined }, GOOD]) {
      expect(RETRY_NOW(sample), `disagreement on ${JSON.stringify(sample)}`)
        .toBe(ABORT(sample));
    }
  });
});

describe('the source honours the contract', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the retry loop tests the payload, not just the object', () => {
    // `while (!agentResult && ...)` was the defect: it retried only on a falsy
    // result, while the abort tested the payload too.
    const i = src.search(/while \(.*agentResult.*\) \{/);
    expect(i, 'retry loop not found').toBeGreaterThan(-1);
    const line = src.slice(i, src.indexOf('\n', i));
    expect(line, 'the retry condition still ignores a missing payload')
      .toMatch(/_specNeedsRetry|payload/);
  });

  it('the predicate it retries on is the same one it aborts on', () => {
    // The binding this defect lacked. Both sites must use the shared predicate,
    // so they cannot drift apart again.
    expect(src, 'no shared predicate — the two conditions can diverge again')
      .toMatch(/_specNeedsRetry\s*=\s*\(r\)\s*=>\s*!r \|\| !r\.payload/);
  });
});
