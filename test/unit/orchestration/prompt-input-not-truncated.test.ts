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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
/**
 * EVERY pipeline file, discovered — not a list.
 *
 * This scanned exactly two files. A 2000-character cap sat in lib/jira-adapter.js, at the
 * SOURCE of the description, so every consumer inherited a clipped field no matter what it
 * did downstream — and this guard reported clean the whole time, because that file was not
 * in the list. Scoping a search to where the bug was last seen is how the same bug survives
 * its own fix; the pinned-codeline check and the hardcoding audit failed the same way.
 */
const FILES = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => (f.startsWith('orchestrations/scripts/') || f.startsWith('orchestrations/plugins/') || f.startsWith('src/'))
    && /\.(js|ts|sh)$/.test(f)
    && !/\.test\.|\.spec\./.test(f));

/** Lines that truncate a DESCRIPTION before it reaches a prompt. */
function descriptionTruncations(rel: string): string[] {
  return readFileSync(join(REPO, rel), 'utf8')
    .split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .filter(({ l }) => /description[^\n]*\.slice\(0,\s*\d{2,}\)/i.test(l))
    // A HUMAN-FACING LABEL is not a prompt. SquadRunner clips a description to 60 chars to
    // name a row in the task registry, and passes the FULL description to the agent on the
    // very next line. Clipping a label loses nothing a model needed.
    //
    // Deliberately narrow: only a call that is plainly building a display string qualifies,
    // and only on the same line as the slice. Anything broader would become the escape
    // hatch that lets a real prompt truncation back in — which is exactly how the 2000-char
    // cap at the source survived a guard that already existed.
    .filter(({ l }) => !/(TaskRegistry\.register|console\.(log|warn|error)|\blog\(|\bwarn\(|\binfo\(|label|title:)/i.test(l))
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
