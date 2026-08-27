/**
 * A CALL THAT THREW IS AN ATTEMPT, NOT THE END OF THE RUN.
 *
 * Live 2026-08-27, run 20260827T143143Z: the discovery agent wrapped its JSON answer in markdown
 * fences. callLlm ran JSON.parse on it, threw, and the exception escaped retryUntilParsed and killed
 * the process — the run died at codeline discovery with an uncaught SyntaxError and then reported
 * "codeline scope could not be resolved", which describes the consequence and not the cause.
 *
 * The retry loop exists precisely for an answer that comes back unusable. A model returning fenced
 * JSON is the most ordinary failure there is, and it took the run down on attempt one of three.
 *
 * retryUntilParsedAsync already guards its call — its own comment says a call that never came back
 * is the most retryable failure there is. The SYNC twin did not, so the same defect was fixed in one
 * of two places. Nothing here is about JSON: a throwing call, whatever the reason, costs ONE attempt
 * and the loop continues, exactly as an unparseable answer does.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { retryUntilParsed, retryUntilParsedAsync } = require(
  join(REPO_ROOT, 'orchestrations/scripts/lib/content-retry.js'));

describe('a throwing call costs one attempt, it does not kill the run', () => {
  it('REPRODUCES the run: a call that throws is retried, not propagated — sync', () => {
    let calls = 0;
    const value = retryUntilParsed({
      what: 'probe',
      attempts: 3,
      call: () => {
        calls += 1;
        // Exactly what killed the run: JSON.parse on a fenced answer.
        if (calls === 1) JSON.parse('```json\n{"a":1}\n```');
        return '{"a":1}';
      },
      parse: (raw: string) => {
        try { return { ok: true, value: JSON.parse(raw) }; }
        catch (e) { return { ok: false, reason: String(e) }; }
      },
    });
    expect(calls, 'the throw escaped the loop — the run dies on the first bad answer').toBe(2);
    expect(value).toEqual({ a: 1 });
  });

  it('async keeps the behaviour it already had', async () => {
    let calls = 0;
    const value = await retryUntilParsedAsync({
      what: 'probe',
      attempts: 3,
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error('runner exploded');
        return '{"a":1}';
      },
      parse: (raw: string) => {
        try { return { ok: true, value: JSON.parse(raw) }; }
        catch (e) { return { ok: false, reason: String(e) }; }
      },
    });
    expect(calls).toBe(2);
    expect(value).toEqual({ a: 1 });
  });

  it('a call that throws EVERY time still ends as a refusal, never an escape', () => {
    // The budget is spent and the loop reports; it must not propagate the last throw either.
    let threw = false;
    try {
      retryUntilParsed({
        what: 'probe', attempts: 2,
        call: () => { throw new Error('always'); },
        parse: () => ({ ok: false, reason: 'never' }),
      });
    } catch (e) {
      // Exhausting the budget throws by design — but it must be the LOOP's refusal, naming the
      // agent and the budget, not the raw error from inside the call.
      threw = true;
      expect(String(e), 'the raw call error escaped instead of the loop\'s refusal')
        .toMatch(/probe|attempt/i);
    }
    expect(threw, 'exhausting the budget must still be reported').toBe(true);
  });
});
