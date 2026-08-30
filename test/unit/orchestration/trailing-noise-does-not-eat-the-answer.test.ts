/**
 * A COMPLETE JSON VALUE FOLLOWED BY ANYTHING IS STILL A COMPLETE JSON VALUE.
 *
 * The parser calls JSON.parse on the WHOLE captured text, so one extra line after the answer makes
 * it throw "Extra data" and the seam is told there was no answer at all.
 *
 * That is not hypothetical and it is not the model's fault. run_orch_prompt captures the runner
 * with `2>&1 | tee`, so everything the pipeline itself writes to stderr lands in the stream being
 * parsed. On metrolinx AMSD-1919, twice, a provider-substitution notice followed the reviewer's
 * JSON and the roster specialiser failed 3 attempts out of 3:
 *
 *     {"verdict":"defects_found","findings":[...]}
 *
 *       [provider] 'qwen' is not routable by the 'claude' set — using 'claude'.
 *
 * Sending that notice to stderr did NOT fix it — 2>&1 merges the two streams — which is why the
 * remedy belongs here rather than in whichever component prints next. Any banner, deprecation
 * warning or progress line from any future component is covered by this.
 *
 * Tolerating trailing noise is not tolerating nonsense: text that never contains a complete value
 * still parses to nothing, and a SECOND value is ignored rather than merged.
 */
import { describe, it, expect } from 'vitest';

const runner = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** The notice that actually did this, in shape. */
const NOTICE = [
  "  [provider] 'qwen' is not routable by the 'claude' set — using 'claude'.",
  "  [provider] The set is the launch's own choice; the env value was left by something else.",
].join('\n');

const ANSWER = { verdict: 'defects_found', findings: [{ agent: 'a', severity: 'advisory' }] };

describe('trailing noise does not eat the answer', () => {
  it('parses a bare object with no noise — the control', () => {
    const out = runner.extractTaggedJson(JSON.stringify(ANSWER), 'ROSTER_REVIEW');
    expect(out, 'the plain case must work, or nothing below means anything').toEqual(ANSWER);
  });

  it('parses an answer followed by the provider notice — the metrolinx failure', () => {
    const out = runner.extractTaggedJson(`${JSON.stringify(ANSWER)}\n\n${NOTICE}`, 'ROSTER_REVIEW');
    expect(out, 'the answer was complete; something else shared the stream').toEqual(ANSWER);
  });

  it('parses an answer followed by ordinary prose', () => {
    const out = runner.extractTaggedJson(
      `${JSON.stringify(ANSWER)}\nI hope this helps!`, 'ROSTER_REVIEW');
    expect(out).toEqual(ANSWER);
  });

  it('parses an array answer followed by noise', () => {
    const arr = [{ storyId: 'AMSD-1919', agentRole: 'checkout-form-engineer' }];
    const out = runner.extractTaggedJson(`${JSON.stringify(arr)}\n${NOTICE}`, 'ROLE_ASSIGNMENTS');
    expect(out).toEqual(arr);
  });

  it('still returns nothing when there is no complete value at all', () => {
    // The negative: tolerance must not become invention.
    expect(runner.extractTaggedJson(NOTICE, 'ROSTER_REVIEW')).toBeFalsy();
    expect(runner.extractTaggedJson('{"verdict": "defects_', 'ROSTER_REVIEW')).toBeFalsy();
  });

  it('takes the FIRST complete value and ignores a second, rather than merging them', () => {
    const second = { verdict: 'pass', findings: [] };
    const out = runner.extractTaggedJson(
      `${JSON.stringify(ANSWER)}\n${JSON.stringify(second)}`, 'ROSTER_REVIEW');
    expect(out).toEqual(ANSWER);
  });

  it('a tagged block still wins over anything outside it', () => {
    // The tag is the stronger signal; noise outside must not compete with it.
    const tagged = `noise before\n<ROSTER_REVIEW>${JSON.stringify(ANSWER)}</ROSTER_REVIEW>\n${NOTICE}`;
    expect(runner.extractTaggedJson(tagged, 'ROSTER_REVIEW')).toEqual(ANSWER);
  });
});
