/**
 * THE TICKET DESCRIPTION MUST REACH THE MODEL WHOLE.
 *
 * It was cut at FIVE different lengths across two files — 400, 1000, 1500, 2000 and 4000
 * characters. Five numbers for one field is the tell that nobody chose any of them.
 *
 * In brownfield the description is not decoration: acceptance criteria do not apply, and
 * the verification criteria are derived FROM THE DESCRIPTION. Cutting it removes the only
 * source of the contract, silently, and the agent then invents the rest — which is exactly
 * the failure mode this pipeline keeps producing.
 *
 * The models in play carry 200K-400K context windows. A 2000-character cap is meaningless
 * on a large model and destructive on a small one, and it relates to neither: not to a
 * token budget, not to the model, not to the content. Where a genuine bound is needed it is
 * the model's own context window, which is derivable — never a constant written down.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const FILES = [
  'orchestrations/scripts/lib/ac-gate.js',
  'orchestrations/scripts/spec-mode-runner.js',
];

/** Lines that truncate a DESCRIPTION before it reaches a prompt. */
function descriptionTruncations(rel: string): string[] {
  return readFileSync(join(REPO, rel), 'utf8')
    .split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .filter(({ l }) => /description[^\n]*\.slice\(0,\s*\d{2,}\)/i.test(l))
    .map(({ l, n }) => `${rel}:${n}: ${l.trim()}`);
}

describe('the ticket description is not truncated on its way to a model', () => {
  it.each(FILES)('%s truncates no description', (rel) => {
    const hits = descriptionTruncations(rel);
    expect(
      hits,
      'the description is the ONLY source of verification criteria in brownfield — cutting ' +
        `it removes the contract and the agent invents the rest:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('and no two places disagree about how much of it to keep', () => {
    const all = FILES.flatMap(descriptionTruncations);
    const limits = new Set(all.map((l) => /\.slice\(0,\s*(\d+)\)/.exec(l)?.[1]));
    expect(
      limits.size,
      `five different caps for one field means none was chosen: ${[...limits].join(', ')}`,
    ).toBe(0);
  });
});
