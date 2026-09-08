/**
 * A REPLY THAT THINKS OUT LOUD STILL PARSES.
 *
 * The segments contract asks for JSON. Live 2026-09-08, with real tokens, the model frequently
 * answered with a FALSE START, corrected itself in prose, and then gave the real answer:
 *
 *   {"segments":["","","","","","","",""][0:0]}
 *
 *   Let me answer properly.
 *
 *   {"segments":["","\n\n---\nRUNTIME BOUNDARY REVIEW: "," — ", ...
 *
 * The first extraction matched /\{[\s\S]*\}/ — GREEDY, so it spanned from the first brace to the
 * last, swallowing the abandoned attempts and the prose between them. Every parse failed, and
 * runtime-boundary-review burned all three attempts on replies whose FINAL object was perfectly
 * good. That is the same template whose placeholder drops aborted the previous run: fixing the
 * contract only to lose the answer to a regex would have moved the failure, not removed it.
 *
 * Thinking out loud is normal model behaviour, not an error to be retried at a higher rung. The
 * reply is scanned for candidate objects and the LAST one that parses and carries the expected
 * number of segments wins — deterministic, and free.
 *
 * Fixtures are the REAL replies captured from that run, not hand-written approximations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const c = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));
const FIX = join(ROOT, 'test/fixtures/prompt-replies');

describe('a reply that thinks out loud still parses', () => {
  it('EXPOSES an extractor that takes the LAST usable object', () => {
    expect(typeof c.extractSegmentsReply,
      'no extractor, so a model that corrects itself mid-answer costs a paid retry').toBe('function');
  });

  it('IGNORES A FALSE START and takes the corrected answer — real captured reply', () => {
    const raw = readFileSync(join(FIX, 'thinks-out-loud.txt'), 'utf8');
    const segs = c.extractSegmentsReply(raw);
    expect(Array.isArray(segs), 'the real reply did not yield segments').toBe(true);
    // The abandoned attempt was all empty strings; the real one carries prose.
    expect(segs.join(''), 'took the abandoned attempt rather than the corrected one')
      .toMatch(/RUNTIME BOUNDARY REVIEW/);
  });

  it('HANDLES THE OTHER REAL SHAPE — a bare false start then the answer', () => {
    const raw = readFileSync(join(FIX, 'false-start.txt'), 'utf8');
    const segs = c.extractSegmentsReply(raw);
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.join(''), 'took the empty first attempt').toMatch(/GO Transit|gotransit/);
  });

  it('PREFERS THE CANDIDATE WITH THE EXPECTED COUNT when one is given', () => {
    const raw = '{"segments":["a","b"]}\nhmm\n{"segments":["x","y","z"]}';
    expect(c.extractSegmentsReply(raw, 3)).toEqual(['x', 'y', 'z']);
    expect(c.extractSegmentsReply(raw, 2)).toEqual(['a', 'b']);
  });

  it('A CLEAN SINGLE OBJECT IS UNAFFECTED', () => {
    expect(c.extractSegmentsReply('{"segments":["one","two"]}')).toEqual(['one', 'two']);
  });

  it('REFUSES A REPLY WITH NO USABLE OBJECT — never guesses', () => {
    expect(() => c.extractSegmentsReply('I cannot do that.')).toThrow();
    expect(() => c.extractSegmentsReply('{"notsegments":[1]}')).toThrow();
  });

  it('BRACES INSIDE SEGMENT PROSE DO NOT BREAK THE SCAN', () => {
    const raw = '{"segments":["use {curly} braces","and \\"quotes\\" too"]}';
    expect(c.extractSegmentsReply(raw)).toEqual(['use {curly} braces', 'and "quotes" too']);
  });
});
