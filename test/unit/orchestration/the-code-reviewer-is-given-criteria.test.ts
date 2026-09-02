/**
 * A REVIEWER WITH NO CRITERIA IS NOT A REVIEWER.
 *
 * code-review-cycle judged the diff against __STORY_ACS__. Brownfield supplies no acceptance
 * criteria, so that input was removed — and removing it left the seam with NOTHING to judge
 * against: description, diff, file list, prior context. No criteria at all. Worse, the body still
 * said "Review the implementation against each acceptance criterion", an instruction pointing at
 * an input that no longer exists, which the empty-value guard cannot catch because there is no
 * placeholder left to be empty.
 *
 * Brownfield judges on VERIFICATION CRITERIA. team-lead-review already receives them as
 * __VC_BLOCK__, built from the story's verificationCriteria in the PRD. code-review-cycle has the
 * same STORY_ID and PRD_FILE and simply never asked for them.
 *
 * ONE BUILDER, TWO CALLERS. The block text was inline in team-lead-review.sh. Copying it into
 * code-review-cycle.sh would put the same sentence in two files, and the moment they drift the two
 * reviewers judge against differently-worded criteria while both look correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const TPL = join(REPO, 'orchestrations/prompts/templates/code-review-cycle.json');
const CRC = join(REPO, 'orchestrations/scripts/code-review-cycle.sh');
const TLR = join(REPO, 'orchestrations/scripts/team-lead-review.sh');
const LIB = join(REPO, 'orchestrations/scripts/lib/review-criteria.sh');

const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
const body = String(tpl.body || '');

describe('the code reviewer is given criteria', () => {
  it('the template is real and still carries the diff it must judge', () => {
    expect(tpl.placeholders, 'no placeholders').toBeTruthy();
    expect(body, 'the diff is gone — there would be nothing to review')
      .toContain('__STORY_DIFF__');
  });

  it('IT RECEIVES VERIFICATION CRITERIA', () => {
    expect(tpl.placeholders,
      'code-review-cycle declares no VC input, so it reviews a diff against nothing')
      .toContain('__VC_BLOCK__');
    expect(body, '__VC_BLOCK__ is declared but never placed in the body')
      .toContain('__VC_BLOCK__');
  });

  it('AND NO LONGER INSTRUCTS THE MODEL TO USE CRITERIA IT IS NOT GIVEN', () => {
    // The orphaned instruction. It survives an input removal silently, because there is no
    // placeholder left for the empty-value guard to refuse.
    expect(body, 'the body still tells the reviewer to judge against acceptance criteria')
      .not.toMatch(/against each acceptance criterion/i);
  });

  it('THE CALLER SUPPLIES IT — a declared input nothing provides refuses the render', () => {
    const sh = readFileSync(CRC, 'utf8');
    expect(sh, 'code-review-cycle.sh does not pass __VC_BLOCK__, so the prompt will not render')
      .toContain('__VC_BLOCK__');
  });

  it('ONE BUILDER, NOT A COPY IN EACH REVIEWER', () => {
    expect(existsSync(LIB), 'lib/review-criteria.sh does not exist').toBe(true);
    const lib = readFileSync(LIB, 'utf8');
    expect(lib, 'the shared builder does not define the VC block function')
      .toMatch(/review_vc_block\s*\(\)/);
    for (const [name, p] of [['code-review-cycle.sh', CRC], ['team-lead-review.sh', TLR]] as const) {
      // THE SOURCE LINE, not any mention. The first version matched /review-criteria\.sh/ and
      // passed on the COMMENT beside the call, while team-lead-review.sh never sourced the lib at
      // all — `review_vc_block: command not found` at runtime, in a green suite.
      expect(readFileSync(p, 'utf8'), `${name} calls review_vc_block but never sources the lib`)
        .toMatch(/^\s*\.\s+"\$SCRIPT_DIR\/lib\/review-criteria\.sh"/m);
    }
  });

  it('the criteria wording lives in ONE place', () => {
    // If both scripts still spell out the heading themselves, they can drift.
    const heading = 'VERIFICATION CRITERIA (the observable checks';
    const inCrc = readFileSync(CRC, 'utf8').includes(heading);
    const inTlr = readFileSync(TLR, 'utf8').includes(heading);
    expect([inCrc, inTlr].filter(Boolean).length,
      'the VC heading text appears in a reviewer script instead of only the shared builder')
      .toBe(0);
  });
});
