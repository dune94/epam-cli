/**
 * SEGMENTS COME BACK DELIMITED, NOT AS JSON.
 *
 * The segments contract removed placeholder drops — 25 refusals in the previous run became zero.
 * It replaced them with a worse failure: asking a model to return 18 multi-line prose strings as
 * JSON. Live 2026-09-08, pipeline-tests-45, team-lead-review (17 placeholders, 5,545-char body)
 * burned all five attempts and aborted the run at 7 of 39 prompts.
 *
 * The replies were NOT truncated. They ended correctly with "]} and still failed to parse:
 *
 *   Expected ',' or ']' after array element at position 609
 *   ..."worse than no fix.","\n---\nREVIEW TASK: Story ","," — ","\n\nDESCRIPTION:\n"...
 *
 * Segments that are themselves punctuation — ", ", "," — collide with JSON's own delimiters, and
 * escaping quotes, commas and newlines across 7kB of prose is where it breaks. A second reply
 * showed a false start, the model saying "Wait — that response is invalid", and the CORRECTED
 * object failing to parse too.
 *
 * The INPUT already uses --- SEGMENT n --- markers and the model reads them perfectly. The output
 * uses the same shape, so there is no escaping to get wrong: newlines are newlines, quotes are
 * quotes, and a segment that is a single comma is just a line containing a comma.
 *
 * JSON is still accepted, because a model that answers correctly in JSON should not be refused for
 * choosing the harder format.
 *
 * Fixtures are the REAL replies from the failed run, pulled from Langfuse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const c = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));
const FIX = join(ROOT, 'test/fixtures/prompt-replies');
const D = (n: number, body: string) => `--- SEGMENT ${n} ---\n${body}`;

describe('segments come back delimited', () => {
  it('PARSES THE DELIMITED SHAPE the prompt asks for', () => {
    const reply = [D(1, 'first bit'), D(2, 'second bit'), '--- END SEGMENTS ---'].join('\n');
    expect(c.parseSegmentsReply(reply)).toEqual(['first bit', 'second bit']);
  });

  it('KEEPS PROSE VERBATIM — newlines, quotes and commas need no escaping', () => {
    const prose = 'He said "stop",\nthen {left}.\n\nTwo blank lines above.';
    const reply = [D(1, prose), D(2, ','), '--- END SEGMENTS ---'].join('\n');
    const segs = c.parseSegmentsReply(reply);
    expect(segs[0], 'prose was mangled in transit').toBe(prose);
    expect(segs[1], 'a segment that is a single comma — the exact shape that broke JSON').toBe(',');
  });

  it('AN EMPTY SEGMENT SURVIVES — adjacent placeholders produce them legitimately', () => {
    const reply = [D(1, ''), D(2, 'middle'), D(3, ''), '--- END SEGMENTS ---'].join('\n');
    expect(c.parseSegmentsReply(reply)).toEqual(['', 'middle', '']);
  });

  it('IGNORES A FALSE START — takes the last complete set', () => {
    const reply = [
      D(1, 'rubbish'), '--- END SEGMENTS ---',
      'Wait, that was wrong. Let me answer properly.',
      D(1, 'good one'), D(2, 'good two'), '--- END SEGMENTS ---',
    ].join('\n');
    expect(c.parseSegmentsReply(reply), 'took the abandoned attempt')
      .toEqual(['good one', 'good two']);
  });

  it('STILL ACCEPTS VALID JSON — a model that gets it right is not punished', () => {
    expect(c.parseSegmentsReply('{"segments":["a","b"]}')).toEqual(['a', 'b']);
  });

  it('THE REAL FAILING REPLIES: JSON is unparseable, and that is reported honestly', () => {
    const broken = readFileSync(join(FIX, 'json-escaping-broke.txt'), 'utf8');
    // It carries no delimiters and its JSON is malformed — there is nothing to recover.
    expect(() => c.parseSegmentsReply(broken),
      'a reply with neither delimiters nor valid JSON must be refused, not guessed at').toThrow();
  });

  it('REFUSES A WRONG COUNT when the expected number is known', () => {
    const reply = [D(1, 'a'), D(2, 'b'), '--- END SEGMENTS ---'].join('\n');
    expect(c.parseSegmentsReply(reply, 2)).toEqual(['a', 'b']);
    expect(() => c.parseSegmentsReply(reply, 5),
      'a short answer must not be padded into a malformed prompt').toThrow();
  });

  it('A REPLY WITH NOTHING USABLE IS REFUSED', () => {
    expect(() => c.parseSegmentsReply('I would rather not.')).toThrow();
  });
});
