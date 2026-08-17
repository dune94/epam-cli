/**
 * FOUR AGENTS PARSE THEIR ANSWER ONCE AND DIE, WITH NO SELF-HEAL AND NO EVIDENCE.
 *
 * Ladder access is universal — every model call resolves its model, effort and budget through
 * seamInvocationEnv. Transport retry is universal — ai-run.sh retries a FAILED call up to
 * EPAM_CALL_MAX_ATTEMPTS with ladder escalation between attempts.
 *
 * Neither helps here. These calls SUCCEED: the model answers, the response arrives intact, and
 * ai-run.sh is satisfied. The failure is in the CONTENT — a missing tag, unparseable JSON — and
 * that path has no retry at all:
 *
 *   codeline-discovery.js:295  'discovery-vocabulary-agent returned no tagged JSON'
 *   codeline-discovery.js:297  'discovery-vocabulary-agent returned an empty blacklist'
 *   cpa-inference.js:184       'No valid JSON object found in response'
 *   ac-gate.js:159             'No JSON in <what> response'
 *
 * Live 2026-08-17: runs 20260817T165956Z and 20260817T174348Z both died at the first of these,
 * ~2 of 3 runs, each after a ~4 minute call. One malformed answer kills the whole run before any
 * work starts.
 *
 * The mint already solves this exactly: a proposal violating the contract is refused WITH THE
 * REASON, the reason is fed back into the prompt, and the model re-proposes. That is why the
 * empty-rationale case self-corrected on attempt 2 instead of dying. These four call sites have
 * the identical failure shape and none of that machinery.
 *
 * AND THE FAILURE DESTROYS ITS OWN EVIDENCE. `throw new Error('returned no tagged JSON')`
 * discards the response, so a truncated answer, a well-formed answer with no tag, and an empty
 * answer are indistinguishable — three different causes, one useless message. Every diagnosis of
 * this defect has been blind for that reason.
 *
 * ONE MECHANISM, NOT FOUR PATCHES.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { retryUntilParsed } = require(join(ROOT, 'orchestrations/scripts/lib/content-retry.js'));

/** A parse that wants a tagged payload, like the vocabulary agent's. */
const wantsTag = (raw: string) => {
  const m = String(raw || '').match(/<TAG>([\s\S]*?)<\/TAG>/);
  return m ? { ok: true, value: m[1] } : { ok: false, reason: 'no <TAG> block in the answer' };
};

describe('agents parse once and die', () => {
  it('the shared mechanism exists', () => {
    expect(typeof retryUntilParsed, 'there is no shared content-retry mechanism').toBe('function');
  });

  it('a good answer costs exactly ONE call', () => {
    let calls = 0;
    const out = retryUntilParsed({
      call: () => { calls += 1; return '<TAG>payload</TAG>'; },
      parse: wantsTag,
      attempts: 3,
      what: 'vocabulary',
    });
    expect(out).toBe('payload');
    expect(calls, 'a valid answer was retried anyway — that doubles the cost of every call').toBe(1);
  });

  it('RETRIES a malformed answer and succeeds on the second attempt', () => {
    // The live case: one bad draw killed the run. It must self-correct.
    let calls = 0;
    const out = retryUntilParsed({
      call: () => { calls += 1; return calls === 1 ? 'here you go: {json}' : '<TAG>payload</TAG>'; },
      parse: wantsTag,
      attempts: 3,
      what: 'vocabulary',
    });
    expect(out).toBe('payload');
    expect(calls).toBe(2);
  });

  it('TELLS THE MODEL WHAT WAS WRONG — an identical retry gets an identical answer', () => {
    const seen: string[] = [];
    retryUntilParsed({
      call: (note: string) => { seen.push(note || ''); return seen.length < 2 ? 'junk' : '<TAG>ok</TAG>'; },
      parse: wantsTag,
      attempts: 3,
      what: 'vocabulary',
    });
    expect(seen[0], 'the first call should carry no correction').toBe('');
    expect(seen[1], 'the retry did not say what was wrong').toMatch(/no <TAG> block/);
    // The model must also see what IT sent, or it cannot tell which part was rejected.
    expect(seen[1]).toMatch(/junk/);
  });

  it('KEEPS THE EVIDENCE when it finally gives up', () => {
    // The whole reason this defect took three runs to diagnose.
    let err: Error | null = null;
    try {
      retryUntilParsed({
        call: () => 'a well formed answer that simply lacks the tag',
        parse: wantsTag,
        attempts: 2,
        what: 'vocabulary',
      });
    } catch (e) { err = e as Error; }

    expect(err, 'giving up did not throw').toBeTruthy();
    expect(err!.message, 'the response was discarded, so the cause is unknowable')
      .toMatch(/a well formed answer that simply lacks the tag/);
    expect(err!.message, 'the reader cannot tell truncation from a contract breach')
      .toMatch(/\b46\b|length/i);
    expect(err!.message, 'it does not say how many attempts were spent').toMatch(/2/);
    expect(err!.message, 'it does not name what failed').toMatch(/vocabulary/i);
  });

  it('an EMPTY answer is distinguishable from a malformed one', () => {
    let err: Error | null = null;
    try {
      retryUntilParsed({ call: () => '', parse: wantsTag, attempts: 1, what: 'vocabulary' });
    } catch (e) { err = e as Error; }
    expect(err!.message, 'empty and malformed report identically').toMatch(/empty/i);
  });

  it('attempts are bounded — a permanently broken agent cannot spend the run', () => {
    let calls = 0;
    try {
      retryUntilParsed({
        call: () => { calls += 1; return 'junk'; }, parse: wantsTag, attempts: 3, what: 'x',
      });
    } catch { /* expected */ }
    expect(calls, 'the retry budget was not honoured').toBe(3);
  });

  it('THE DISCOVERY VOCABULARY AGENT USES IT — the site that killed three runs', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');
    expect(src, 'the vocabulary agent still parses once and dies').toMatch(/retryUntilParsed/);
  });
});
