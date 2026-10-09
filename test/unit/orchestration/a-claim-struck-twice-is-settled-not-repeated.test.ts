/**
 * A CLAIM STRUCK TWICE IS SETTLED, NOT REPEATED.
 *
 * AMSD-2974 runs 3 and 4 (2026-10-09) died in the Agents Phase: the prompt reviewer struck project prompts five times,
 * and on a correct prompt nothing could settle the dispute — the generator had to give in or run out of attempts. The
 * reviewer is a model, strict on wording (live harness: it struck "StarWidgetToast component" for being a folder).
 * A claim the reviewer already struck for this prompt now goes to the adjudicator — another agent, on another rung —
 * which checks that one claim in the repositories. Upheld: the strike is withdrawn. Not upheld, or no ruling: it stands.
 *
 * Also here: with no project copy of the reviewer's prompt yet, the bootstrap review rendered the template with
 * substituteOnce(body, values) — keys missing — and judged unfilled template text.
 *
 * EXECUTED: the real makePromptReviewer (lib/prompt-review.js); only the reviewer and adjudicator models are stood in.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makePromptReviewer } = require(join(__dirname, '../../../orchestrations/scripts/lib/prompt-review.js'));

const STRIKE = (claim: string) => `<PROMPT_REVIEW>${JSON.stringify({ falseClaims: [{ claim, found: 'it is a folder' }] })}</PROMPT_REVIEW>`;
function reviewer(answers: string[], ruling: (a: any) => any) {
  const asked: any[] = []; const rec: any[] = [];
  const review = makePromptReviewer({
    render: () => 'REVIEW', invoke: async () => answers.shift() || '<PROMPT_REVIEW>{"falseClaims":[]}</PROMPT_REVIEW>',
    values: () => ({}), warn: () => {}, recordVerdict: (r: any) => rec.push(r),
    adjudicate: async (a: any) => { asked.push(a); return ruling(a); },
  });
  return { review, asked, rec };
}
const call = (r: any, id = 'code-review-cycle') => r({ id, template: {}, generated: { body: 'x' } });

describe('a claim struck twice is settled, not repeated', () => {
  it('a first strike is the reviewer\'s — no adjudication, the prompt is refused', async () => {
    const t = reviewer([STRIKE('cx-shared keeps a StarWidgetToast component')], () => ({ holds: true }));
    const v = await call(t.review);
    expect(v.ok).toBe(false);
    expect(t.asked).toEqual([]);
  });

  it('struck again and UPHELD by the adjudicator: the strike is withdrawn and the prompt passes', async () => {
    const t = reviewer([STRIKE('cx-shared keeps a StarWidgetToast component'), STRIKE('cx-shared keeps a StarWidgetToast component under src/components/StarWidget')], () => ({ holds: true, evidence: 'ls StarWidget/ shows StarWidgetToast/' }));
    expect((await call(t.review)).ok).toBe(false);
    const v = await call(t.review);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].claim).toContain('StarWidgetToast');
    expect(t.asked[0].finding).toBe('it is a folder');
    expect(v.ok).toBe(true);
    expect(t.rec.some((r) => r.adjudication && r.adjudication.ruling && r.adjudication.ruling.holds === true), 'the ruling was not kept').toBe(true);
  });

  it('struck again and NOT upheld: the strike stands — a lie never passes because it was repeated', async () => {
    const t = reviewer([STRIKE('cx-shared has a Snackbar component'), STRIKE('cx-shared has a Snackbar component')], () => ({ holds: false, evidence: 'no Snackbar' }));
    await call(t.review);
    const v = await call(t.review);
    expect(t.asked).toHaveLength(1);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('Snackbar');
  });

  it('no ruling (the adjudicator failed or gave nothing readable): the strike stands', async () => {
    for (const ruling of [() => null, () => { throw new Error('down'); }]) {
      const t = reviewer([STRIKE('a claim'), STRIKE('a claim')], ruling);
      await call(t.review);
      expect((await call(t.review)).ok).toBe(false);
    }
  });

  it('the same words struck for a DIFFERENT prompt are that prompt\'s first strike', async () => {
    const t = reviewer([STRIKE('cx-shared keeps a StarWidgetToast component'), STRIKE('cx-shared keeps a StarWidgetToast component')], () => ({ holds: true }));
    await call(t.review, 'code-review-cycle');
    const v = await call(t.review, 'tc-writer');
    expect(t.asked).toEqual([]);
    expect(v.ok).toBe(false);
  });
});

describe('the bootstrap review judges the generated prompt, not the template text', () => {
  it('with no project copy of the reviewer prompt, the template is rendered WITH the values', async () => {
    let sent = '';
    const review = makePromptReviewer({
      render: () => { throw new Error('project-authority prompt missing: prompt-review.json'); },
      invoke: async (p: string) => { sent = p; return '<PROMPT_REVIEW>{"falseClaims":[]}</PROMPT_REVIEW>'; },
      values: ({ id, generated }: any) => ({
        __ROSTER_BLOCK__: '- none', __PROMPT_ID__: id, __TEMPLATE_BODY__: 'TPL', __GENERATED_BODY__: generated.body,
        __CODELINE_BLOCK__: 'CL', __TICKET_BLOCK__: 'TK', __TOOL_LINE__: 'TOOLS',
      }),
      warn: () => {},
    });
    await review({ id: 'code-review-cycle', template: {}, generated: { body: 'THE GENERATED PROMPT UNDER REVIEW' } });
    expect(sent, 'nothing was sent').not.toBe('');
    expect(sent).toContain('THE GENERATED PROMPT UNDER REVIEW');
    expect(sent).not.toMatch(/__GENERATED_BODY__|__CODELINE_BLOCK__/);
  });
});
