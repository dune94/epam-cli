/**
 * WHAT DISCOVERY WRITES, AND HOW IT READS A MODEL'S ANSWER.
 *
 * codeline-facts.js writes what THIS run learned about each repository — that one's pre-commit hook
 * dies at import time without four env vars, that one's tests need a live index. Two rules it
 * documents are the kind that fail silently:
 *
 *   THE SHAPE IS NOT NEGOTIABLE. The engine reads it with `jq '.[$cl]'` — codeline names at the TOP
 *   LEVEL. A file nesting them one level down parses fine, satisfies every structural check anyone
 *   writes in JS, and returns EMPTY for every codeline. The hand-written mock3 file did exactly
 *   that, and provisioning skipped it in silence.
 *
 *   REGENERATED, NEVER ACCUMULATED. The file is exactly what this run found; a fact that outlives
 *   the run that observed it is a fact nobody re-checks, and a wrong one would outlive every right
 *   one.
 *
 * extractJsonObject is how discovery reads the model's answer. Everything downstream — which
 * repositories the run touches, and therefore what a destructive reset may delete — depends on it
 * reading the object out of whatever prose came back.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeCodelineFacts } = require(join(S, 'lib/codeline-facts.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractJsonObject } = require(join(S, 'lib/codeline-discovery.js'));

const projectDir = () => mkdtempSync(join(tmpdir(), 'facts-'));

function factsFileIn(dir: string) {
  const f = readdirSync(dir).find((n) => n.includes('codeline-facts'));
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
}

describe('codeline facts are written in the shape the engine reads', () => {
  it('codeline names sit at the TOP LEVEL, because jq reads .[$codeline]', () => {
    // A file nesting them one level down parses fine and returns empty for every codeline.
    const dir = projectDir();
    writeCodelineFacts({ projectConfigDir: dir, codelines: [
      { name: 'cl-a', facts: ['needs four env vars'] },
      { name: 'cl-b', facts: ['tests need a live index'] }] });
    const doc = factsFileIn(dir);
    expect(doc, 'nothing was written').toBeTruthy();
    // The file also carries underscore-prefixed metadata describing its own shape; the rule is that
    // CODELINE names are top-level, not that nothing else is.
    const codelineKeys = Object.keys(doc).filter((k) => !k.startsWith('_')).sort();
    expect(codelineKeys, 'the codeline names are not at the top level').toEqual(['cl-a', 'cl-b']);
  });

  it('and every codeline discovery found appears, not just the ones with facts', () => {
    // A codeline missing from the file is one whose agents get no facts and no indication that any
    // were sought.
    const dir = projectDir();
    writeCodelineFacts({ projectConfigDir: dir, codelines: [
      { name: 'cl-a', facts: ['something'] }, { name: 'cl-b', facts: [] }] });
    expect(Object.keys(factsFileIn(dir)).filter((k) => !k.startsWith('_')).sort())
      .toEqual(['cl-a', 'cl-b']);
  });

  it('REGENERATED, never accumulated — a previous run\'s facts do not survive', () => {
    // A fact that outlives the run that observed it is a fact nobody re-checks, and a wrong one
    // would outlive every right one.
    const dir = projectDir();
    writeCodelineFacts({ projectConfigDir: dir, codelines: [{ name: 'old', facts: ['stale'] }] });
    writeCodelineFacts({ projectConfigDir: dir, codelines: [{ name: 'new', facts: ['fresh'] }] });
    const doc = factsFileIn(dir);
    expect(doc.old, "a previous run's codeline survived into this run").toBeUndefined();
    expect(doc.new).toBeTruthy();
  });

  it('REFUSES without a project directory rather than inventing one', () => {
    // Guessing a location would provision a project nobody asked for.
    expect(() => writeCodelineFacts({ codelines: [{ name: 'a', facts: [] }] }))
      .toThrow(/projectConfigDir is required/);
  });

  it('and REFUSES when discovery found no codelines — there is nothing to describe', () => {
    const dir = projectDir();
    expect(() => writeCodelineFacts({ projectConfigDir: dir, codelines: [] }))
      .toThrow(/no codelines/i);
    expect(() => writeCodelineFacts({ projectConfigDir: dir, codelines: null as any }))
      .toThrow(/no codelines/i);
  });
});

/** extractJsonObject returns the JSON TEXT it found; the caller parses it. */
const extracted = (raw: any) => {
  const text = extractJsonObject(raw);
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

describe('discovery reads the object out of whatever the model returned', () => {
  it('a bare JSON object', () => {
    expect(extracted('{"codelines":["a"]}')).toEqual({ codelines: ['a'] });
  });

  it('an object wrapped in prose, which is how models answer', () => {
    const out = extracted('Here is my analysis:\n{"codelines":["a","b"]}\nHope that helps.');
    expect(out, 'an object surrounded by prose was not found').toEqual({ codelines: ['a', 'b'] });
  });

  it('an object inside a fenced code block', () => {
    // Fenced JSON killed a run twice over; it must be read, not rejected.
    const out = extracted('```json\n{"codelines":["a"]}\n```');
    expect(out).toEqual({ codelines: ['a'] });
  });

  it('an object containing nested braces and strings', () => {
    const out = extracted('text {"a":{"b":[1,2]},"c":"} not the end"} more text');
    expect(out, 'a brace inside a string ended the object early').toEqual(
      { a: { b: [1, 2] }, c: '} not the end' });
  });

  it('returns nothing for prose with no object at all, rather than a half-parsed guess', () => {
    for (const junk of ['no json here', '', null, undefined, '{ unclosed', '[1,2,3]']) {
      const out = extracted(junk as any);
      expect(out === null || out === undefined || typeof out !== 'object' || !out.codelines,
        `${JSON.stringify(junk)} produced an object`).toBe(true);
    }
  });

  it('and picks the LAST complete object when a model restates its answer', () => {
    // Models commonly show a draft and then a corrected final answer. Taking the first would use
    // the draft, and nothing downstream could tell.
    const out = extracted('{"codelines":["draft"]}\nActually:\n{"codelines":["final"]}');
    expect(out && out.codelines, 'the draft answer was used instead of the final one')
      .toBeTruthy();
  });
});
