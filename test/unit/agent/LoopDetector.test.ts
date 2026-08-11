/**
 * LoopDetector — per-attempt tool-call loop / repeating-error detector.
 *
 * TS port of a proposed Python sketch, with two fixes verified here:
 *  1. Error fingerprints normalize away digit runs, so the same underlying
 *     error at a different line number still matches (the original didn't).
 *  2. Repeat-error detection keys off the tool's own isError flag, not a
 *     substring scan — so legitimate output containing the word "error"
 *     (e.g. grep results) never counts as a failure.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { LoopDetector } from '../../../src/agent/LoopDetector.js';

// Wording lives in the project catalog now, not the engine (src/tools/messages.ts). Point at
// the shipped catalog exactly as the runtime invocation does, so these assert the words an
// agent really sees rather than words compiled into the tool.
process.env.EPAM_AGENT_MESSAGE_CATALOG =
  join(__dirname, '../../../orchestrations/config/agent-messages.json');

describe('LoopDetector.preToolCheck — identical tool-call repetition', () => {
  it('allows the first N calls (maxIdenticalToolCalls) through unblocked', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    expect(d.preToolCheck('bash', { command: 'npm test' }).blocked).toBe(false);
    expect(d.preToolCheck('bash', { command: 'npm test' }).blocked).toBe(false);
  });

  it('blocks the call once it repeats maxIdenticalToolCalls times, with an intervention message', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.preToolCheck('bash', { command: 'npm test' });
    d.preToolCheck('bash', { command: 'npm test' });
    const third = d.preToolCheck('bash', { command: 'npm test' });
    expect(third.blocked).toBe(true);
    expect(third.interventionMessage).toMatch(/LOOP PROTECTION/);
    expect(third.interventionMessage).toMatch(/bash/);
  });

  it('a different tool name is a different signature — not blocked', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.preToolCheck('bash', { command: 'npm test' });
    d.preToolCheck('bash', { command: 'npm test' });
    expect(d.preToolCheck('read_file', { command: 'npm test' }).blocked).toBe(false);
  });

  it('different arguments to the same tool are a different signature — not blocked', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.preToolCheck('bash', { command: 'npm test' });
    d.preToolCheck('bash', { command: 'npm test' });
    expect(d.preToolCheck('bash', { command: 'npm run build' }).blocked).toBe(false);
  });

  it('argument key order does not affect the signature (stable serialization)', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.preToolCheck('write_file', { path: 'a.ts', content: 'x' });
    d.preToolCheck('write_file', { content: 'x', path: 'a.ts' }); // same args, different key order
    const third = d.preToolCheck('write_file', { path: 'a.ts', content: 'x' });
    expect(third.blocked).toBe(true);
  });

  it('a blocked call is not itself added to history (repeated blocks keep reporting the same duplicate count)', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.preToolCheck('bash', { command: 'x' });
    d.preToolCheck('bash', { command: 'x' });
    const first = d.preToolCheck('bash', { command: 'x' });
    const second = d.preToolCheck('bash', { command: 'x' });
    expect(first.blocked).toBe(true);
    expect(second.blocked).toBe(true);
  });

  it('only considers the sliding window, not the whole history', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 3 });
    d.preToolCheck('bash', { command: 'x' }); // window: [x]
    d.preToolCheck('a', {}); // window: [x, a]
    d.preToolCheck('b', {}); // window: [x, a, b]
    d.preToolCheck('c', {}); // window: [a, b, c] — x fell out
    expect(d.preToolCheck('bash', { command: 'x' }).blocked).toBe(false); // x's old occurrence is out of window
  });
});

describe('LoopDetector.postToolCheck — repeating error fingerprints', () => {
  it('a successful result is never flagged, however many times it repeats', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    for (let i = 0; i < 5; i++) {
      expect(d.postToolCheck({ content: 'error: found 3 matches', isError: false }).repeating).toBe(false);
    }
  });

  it('output containing the word "error" is NOT flagged when isError is false (the false-positive the substring version would have)', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    const grepOutput = { content: 'src/handler.ts:12: catch (error) { logError(error) }', isError: false };
    expect(d.postToolCheck(grepOutput).repeating).toBe(false);
    expect(d.postToolCheck(grepOutput).repeating).toBe(false);
    expect(d.postToolCheck(grepOutput).repeating).toBe(false);
  });

  it('flags a repeating real error after maxIdenticalErrorOutcomes occurrences', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    const err = { content: 'TypeError: Cannot read property "foo" of undefined\n  at line 42', isError: true };
    expect(d.postToolCheck(err).repeating).toBe(false);
    const second = d.postToolCheck(err);
    expect(second.repeating).toBe(true);
    expect(second.feedbackMessage).toMatch(/LOOP PROTECTION/);
  });

  it('the SAME underlying error at a DIFFERENT line number still fingerprints identically (the bug fixed vs the original Python sketch)', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.postToolCheck({ content: 'TypeError: Cannot read property "foo" of undefined\n  at line 42', isError: true });
    const second = d.postToolCheck({ content: 'TypeError: Cannot read property "foo" of undefined\n  at line 43', isError: true });
    expect(second.repeating).toBe(true);
  });

  it('a genuinely different error does not trip the repeat detector', () => {
    const d = new LoopDetector({ maxIdenticalToolCalls: 2, maxIdenticalErrorOutcomes: 2, slidingWindowSize: 6 });
    d.postToolCheck({ content: 'TypeError: Cannot read property "foo" of undefined', isError: true });
    const second = d.postToolCheck({ content: 'SyntaxError: unexpected token', isError: true });
    expect(second.repeating).toBe(false);
  });
});
