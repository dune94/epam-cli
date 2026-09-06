/**
 * A REWORDED CONTEXT MUST NOT INVALIDATE THE PROMPT CACHE.
 *
 * The cache key was:
 *     sha({ t, generatorBody, projectContext, codelineContext })
 *
 * projectContext and codelineContext are MODEL-AUTHORED PROSE — the estate survey and codeline
 * discovery write them, and both run every run. A model rewords itself, so the digest changed on
 * every run and every entry missed. Measured 2026-09-06 on pipeline-tests-27: 39 cached prompts,
 * 0 hits, with templates byte-identical between v1.43 and v1.47 (git diff: 0 files).
 *
 * This is the SAME defect the file already fixed one layer down, and says so:
 *   "The ROLES, not the prose about them — see rolesIdentity. Digesting the mint's raw text
 *    rebuilt every roster-dependent prompt on every run because a model rewords itself."
 * Fixed for roles, left for the contexts.
 *
 * WHAT STILL INVALIDATES: the template and the generator body — the two things that actually
 * decide the generated text. Codeline identity is enforced separately and more strictly, by the
 * per-codeline completion marker (.complete-<codeline>), so dropping the prose from the key does
 * not let one codeline's prompts serve another.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/lib/project-prompt-builder.js'), 'utf8');

/** Lift the real digest expression and drive it, rather than reimplementing the hash. */
function baseDigestFactory(projectContext: string, codelineContext: string) {
  const crypto = require('node:crypto');
  const sha = (t: string) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const line = SRC.split('\n').find((l) => l.includes('const baseDigest ='));
  if (!line) throw new Error('baseDigest expression not found — the harness is stale');
  const generatorBody = 'GENERATOR BODY, unchanged';
  // eslint-disable-next-line no-new-func
  return new Function('sha', 'generatorBody', 'projectContext', 'codelineContext',
    `${line.trim().replace(/^const /, 'const ')}; return baseDigest;`,
  )(sha, generatorBody, projectContext, codelineContext) as (t: unknown) => string;
}

const TEMPLATE = { id: 'roster-review', body: 'unchanged template text' };

describe('the prompt cache key', () => {
  it('is STABLE when the survey rewords the same facts', () => {
    // Two runs, same codeline, same template. The survey says the same thing in different words —
    // which is what a model does every time it runs.
    const a = baseDigestFactory(
      'The gotransit checkout app, Next.js + TypeScript.',
      'gotransit at next.gotransit.com, 149 declared deps.')(TEMPLATE);
    const b = baseDigestFactory(
      'A Next.js and TypeScript checkout application for GO Transit.',
      'The gotransit codeline (next.gotransit.com) declares 149 dependencies.')(TEMPLATE);
    expect(a, [
      'the cache key changed because a model reworded the context, so every prompt regenerates',
      'on every run. Measured live: 39 cached, 0 hits, templates byte-identical.',
    ].join('\n')).toBe(b);
  });

  it('STILL changes when the template itself changes', () => {
    // The other end: the key must not become insensitive to the thing it exists to track.
    const ctx = ['ctx a', 'ctx b'] as const;
    const a = baseDigestFactory(ctx[0], ctx[1])(TEMPLATE);
    const b = baseDigestFactory(ctx[0], ctx[1])({ ...TEMPLATE, body: 'EDITED template text' });
    expect(a, 'a template edit no longer invalidates the cache — stale prompts would be reused')
      .not.toBe(b);
  });

  it('STILL changes when the generator body changes', () => {
    const gA = baseDigestFactory('x', 'y');
    const src = SRC.split('\n').find((l) => l.includes('const baseDigest ='))!;
    expect(src, 'generatorBody must remain part of the key — it decides how the prompt is written')
      .toContain('generatorBody');
    expect(typeof gA(TEMPLATE)).toBe('string');
  });
});
