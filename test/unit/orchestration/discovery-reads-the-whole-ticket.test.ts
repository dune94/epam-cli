/**
 * Codeline discovery decides WHICH CLIENT REPOSITORY GETS MODIFIED. It must read the whole
 * ticket to do it.
 *
 * WHAT WAS WRONG
 * --------------
 * The same field was truncated twice, in one file, to two different picked numbers:
 *
 *   scoreRepos()            (i.description || '').slice(0, 500)   -> term extraction
 *   buildDiscoveryPrompt()  (i.description || '').slice(0, 300)   -> the LLM prompt
 *
 * Neither carried a comment. Every other decision in that file is explained — the
 * `components` field gets four lines on why it is the strongest evidence — and the two
 * truncations got nothing, which is what a picked number looks like.
 *
 * 300 characters is about two sentences. In brownfield the description is the ONLY
 * substantive content a ticket has: the AC gate skips acceptance criteria entirely and
 * records "VCs are derived from the description". So the repository-selection decision was
 * being made from a headline plus two sentences, with the requirement itself cut off.
 *
 * Nothing about the prompt's size justified it: discovery sends one small prompt containing
 * a handful of candidate repositories.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');
const SRC = readFileSync(FILE, 'utf8');

/** Non-comment lines that clip the description. */
function descriptionTruncations(): string[] {
  return SRC.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .filter(({ l }) => /description[^\n]*\.slice\(\s*0\s*,\s*\d+\s*\)/i.test(l))
    .map(({ l, n }) => `codeline-discovery.js:${n}: ${l.trim()}`);
}

describe('the ticket description is not clipped on its way to the repository decision', () => {
  it('NO truncation of the description survives anywhere in discovery', () => {
    expect(
      descriptionTruncations(),
      'the description is the only substantive content a brownfield ticket carries, and this ' +
        'decision chooses which client repository gets modified',
    ).toEqual([]);
  });

  it('the LLM prompt is built from the full description', () => {
    const i = SRC.indexOf('function buildDiscoveryPrompt');
    const fn = SRC.slice(i, SRC.indexOf('\n}', i));
    expect(fn).toMatch(/description/);
    expect(fn, 'the prompt still clips the description').not.toMatch(/description[^\n]*\.slice\(\s*0\s*,\s*\d/);
  });

  it('term extraction is built from the full description', () => {
    const i = SRC.indexOf('function scoreRepos');
    const fn = SRC.slice(i, i + 1200);
    expect(fn, 'scoring still clips the description').not.toMatch(/description[^\n]*\.slice\(\s*0\s*,\s*\d/);
  });

  it('no two places disagree about how much of the field to keep', () => {
    const caps = [...SRC.matchAll(/description[^\n]*\.slice\(\s*0\s*,\s*(\d+)\s*\)/gi)].map((m) => m[1]);
    expect(new Set(caps).size, `conflicting caps found: ${[...new Set(caps)].join(', ')}`).toBeLessThanOrEqual(1);
  });
});

describe('the components field — the strongest evidence — is never clipped either', () => {
  it('components reach the prompt whole', () => {
    const i = SRC.indexOf('function buildDiscoveryPrompt');
    const fn = SRC.slice(i, SRC.indexOf('\n}', i));
    expect(fn).toMatch(/components/);
    expect(fn).not.toMatch(/comps[^\n]*\.slice\(\s*0\s*,\s*\d/);
  });
});
