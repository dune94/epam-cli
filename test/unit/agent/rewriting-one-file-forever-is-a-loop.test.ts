/**
 * THIRTY-TWO WRITES TO ONE FILE IN ONE ATTEMPT IS A LOOP, AND NOTHING SAW IT.
 *
 * LoopDetector blocks a tool call whose {name + args} hash repeats. That contract catches an
 * agent re-issuing an identical call, and it is the right contract for reads and searches.
 *
 * It cannot see a rewrite loop. Live 2026-08-10, a single attempt issued:
 *
 *     32x  write_file  src/services/contentstack.ts     (only 6 distinct content sizes)
 *      2x  write_file  src/services/pageService.ts
 *
 * Every one of those 32 carried slightly different content, so every one hashed differently and
 * the detector passed them all. The attempt ran to 11.7M input tokens — up from 7.1M — because
 * each rewrite added a turn, and every turn re-sends the whole history.
 *
 * The writer was not being stupid. It was cornered: a scope guard had refused the file that held
 * the type its change needed, so it kept re-editing the one file it was allowed to touch. That
 * cause is fixed separately; this is the backstop for the next time something corners it.
 *
 * THE RULE: repeatedly targeting the SAME thing is a loop even when the payload differs. Distinct
 * from the identical-args rule and deliberately more permissive — iterating on a file two or
 * three times is ordinary work, and the threshold is configuration rather than a literal so it
 * can be tuned without a code change.
 *
 * NO TOOL NAMES, NO STACK FACTS. The rule keys on "a tool called repeatedly against the same
 * target", where the target is whatever path-like argument the call carries. It names no tool, no
 * extension and no directory, so a plugin tool that mutates something is covered on the day it is
 * added.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest';
import { LoopDetector } from '../../../src/agent/LoopDetector.js';

/** Issue n calls to the same tool against the same path, each with different content. */
function hammer(d: LoopDetector, tool: string, path: string, n: number): number {
  let blockedAt = -1;
  for (let i = 0; i < n; i++) {
    const { blocked } = d.preToolCheck(tool, { path, content: `revision ${i}\n`.repeat(i + 1) });
    if (blocked && blockedAt === -1) blockedAt = i;
  }
  return blockedAt;
}

describe('the existing contract is unchanged', () => {
  it('identical repeated calls are still blocked', () => {
    const d = new LoopDetector();
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const r = d.preToolCheck('search', { query: 'same' });
      if (r.blocked) blocked = true;
    }
    expect(blocked, 'the identical-args rule stopped working').toBe(true);
  });

  it('varied calls to DIFFERENT targets are never blocked', () => {
    const d = new LoopDetector();
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const r = d.preToolCheck('write_file', { path: `f${i}.x`, content: 'c' });
      if (r.blocked) blocked = true;
    }
    expect(blocked, 'legitimate work across many files was blocked').toBe(false);
  });
});

describe('THE DEFECT: same target, different payload, forever', () => {
  it('a handful of edits to one file is ordinary work and is NOT blocked', () => {
    const d = new LoopDetector();
    expect(hammer(d, 'write_file', 'a.x', 3), 'normal iterative editing was blocked').toBe(-1);
  });

  it('rewriting one file many times IS blocked', () => {
    const d = new LoopDetector();
    const at = hammer(d, 'write_file', 'a.x', 32);
    expect(
      at,
      '32 rewrites of one file passed unnoticed — this is what took an attempt from 7.1M to ' +
      '11.7M input tokens',
    ).toBeGreaterThan(-1);
  });

  it('it blocks well before 32, so the cost is bounded', () => {
    const d = new LoopDetector();
    expect(hammer(d, 'write_file', 'a.x', 32)).toBeLessThan(16);
  });

  it('the message says what to do instead of repeating', () => {
    const d = new LoopDetector();
    hammer(d, 'write_file', 'a.x', 32);
    const r = d.preToolCheck('write_file', { path: 'a.x', content: 'more' });
    expect(r.interventionMessage ?? '').toMatch(/same file|same target|repeat|not making progress/i);
  });

  it('the target is read from whichever path-like argument the call carries', () => {
    // Tools spell it differently; a rule that knows only one spelling silently covers only one.
    for (const key of ['path', 'file_path', 'file']) {
      const d = new LoopDetector();
      let blockedAt = -1;
      for (let i = 0; i < 32; i++) {
        const { blocked } = d.preToolCheck('write_file', { [key]: 'x.y', content: `${i}` });
        if (blocked && blockedAt === -1) blockedAt = i;
      }
      expect(blockedAt, `a call using '${key}' was never seen as repeating`).toBeGreaterThan(-1);
    }
  });

  it('a call with no path-like argument is unaffected by the target rule', () => {
    const d = new LoopDetector();
    let blocked = false;
    for (let i = 0; i < 20; i++) {
      const r = d.preToolCheck('some_tool', { question: `q${i}` });
      if (r.blocked) blocked = true;
    }
    expect(blocked).toBe(false);
  });
});

describe('the threshold is configuration, not a literal', () => {
  it('a caller can tune it', () => {
    const strict = new LoopDetector({
      maxIdenticalToolCalls: 3, slidingWindowSize: 40, maxSameTargetCalls: 4,
    } as never);
    expect(hammer(strict, 'write_file', 'a.x', 32)).toBeLessThan(6);
  });
});
