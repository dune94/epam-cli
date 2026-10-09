/**
 * EVERY PROMPT-REVIEW VERDICT IS KEPT, AND THE BUILDER IS TOLD WHAT THE REVIEWER FOUND.
 *
 * Live AMSD-2974 run 3 (2026-10-09): code-review-cycle and tc-writer were rejected four times each and passed on
 * the fifth. The review log is rewritten per attempt, so the four rejections' reasoning was gone; and the builder
 * was handed only the struck claim's text, never the reviewer's evidence, so it could not tell a wrong fact from a
 * true one that does not belong in a reusable prompt — and repeated it.
 *
 * EXECUTED: the real makePromptReviewer (lib/prompt-review.js); only the model is stood in.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makePromptReviewer } = require(join(__dirname, '../../../orchestrations/scripts/lib/prompt-review.js'));

const VERDICT = { falseClaims: [{ claim: 'Five thin Toast call sites', checked: 'src/', found: 'six call sites, and they are this ticket\'s, not the repository\'s' }] };
function reviewer(answer: string, recorded: unknown[]) {
  return makePromptReviewer({
    render: () => 'REVIEW THIS',
    invoke: async () => answer,
    values: () => ({}),
    warn: () => {},
    recordVerdict: (r: unknown) => recorded.push(r),
  });
}

describe('every prompt-review verdict is kept and explained', () => {
  it('a rejection is recorded whole, and the builder is told what the reviewer found', async () => {
    const recorded: any[] = [];
    const r = await reviewer(`<PROMPT_REVIEW>${JSON.stringify(VERDICT)}</PROMPT_REVIEW>`, recorded)({ id: 'code-review-cycle', template: {}, generated: { body: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Five thin Toast call sites');
    expect(r.reason).toContain('the reviewer found: six call sites');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ id: 'code-review-cycle', verdict: VERDICT });
  });

  it('an approval is recorded too — the record is every verdict, not only the rejections', async () => {
    const recorded: any[] = [];
    const r = await reviewer('<PROMPT_REVIEW>{"falseClaims": []}</PROMPT_REVIEW>', recorded)({ id: 'tc-writer', template: {}, generated: { body: 'x' } });
    expect(r.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].verdict.falseClaims).toEqual([]);
  });

  it('a claim given as a bare string is passed on unchanged', async () => {
    const r = await reviewer('<PROMPT_REVIEW>{"falseClaims": ["no such file src/x.ts"]}</PROMPT_REVIEW>', [])({ id: 'p', template: {}, generated: { body: 'x' } });
    expect(r.reason).toBe('no such file src/x.ts');
  });
});
