/**
 * A GREEDY BRACE MATCH IS NOT A JSON EXTRACTOR.
 *
 * codeline-discovery pulled its answer out with /\{[\s\S]*\}/ — first '{' to LAST '}'. A model that
 * fences its JSON, or adds a sentence containing a brace after it, produces a match that spans both
 * and JSON.parse throws.
 *
 * Live 2026-08-27, run 20260827T143143Z: the discovery agent returned fenced JSON, the parse threw
 * "Unexpected non-whitespace character after JSON at position 958", the exception escaped the retry
 * loop and killed the run, which then reported "codeline scope could not be resolved" — the
 * consequence, not the cause.
 *
 * Fenced JSON is the most ordinary thing a model does. The extractor must find the FIRST balanced
 * object, not the widest span between braces.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractJsonObject } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'));

describe('the JSON extractor finds the object, not the widest span', () => {
  it('REPRODUCES the run: fenced JSON parses', () => {
    const raw = '```json\n{"codelines":["mock-a"]}\n```';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ codelines: ['mock-a'] });
  });

  it('prose after the object does not break it', () => {
    const raw = 'Here is my answer:\n{"codelines":["mock-a"]}\nI hope that helps {see above}.';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ codelines: ['mock-a'] });
  });

  it('nested objects are kept whole', () => {
    const raw = 'x {"a":{"b":[1,2]},"c":3} y';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ a: { b: [1, 2] }, c: 3 });
  });

  it('a brace inside a string does not end the object', () => {
    const raw = '{"reason":"use the } character","ok":true}';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ reason: 'use the } character', ok: true });
  });

  it('returns empty when there is genuinely no object — absent is not a guess', () => {
    expect(extractJsonObject('no json at all')).toBe('');
    expect(extractJsonObject('')).toBe('');
  });
});
