/**
 * THE DETECTIVE MUST RUN ON A BROWNFIELD DEFECT, WHICH HAS NO ACs.
 *
 * Operator rule, restated many times: brownfield judges on VERIFICATION CRITERIA, not acceptance
 * criteria. A thin or empty acceptanceCriteria field is EXPECTED on a brownfield defect and is
 * never itself a defect — the VCs come from the ticket description.
 *
 * code-graph-detective.json declares mayBeEmpty ["__DETECTIVE_PROFILE__", "__SURVEY_HYPOTHESIS__"]
 * and NOT __STORY_ACS__. The engine-prompt guard therefore refuses to render the prompt whenever
 * the ACs are empty — which, on brownfield, is always:
 *
 *   spec-mode: brownfield — ignoring 8 AC(s) speckit produced for AMSD-1919;
 *              ACs are out of scope and VCs come from the description
 *   spec-mode: code-graph-detective unavailable for AMSD-1919
 *              (prompt 'code-graph-detective' was given EMPTY values for: __STORY_ACS__)
 *   spec-mode: ⛔ DEFECT AMSD-1919 has NO fixSiteAnalysis after the spec pass —
 *              the implementer gets symptom ACs with no root cause.
 *
 * So the ONE agent whose whole job is finding the cause before any code is written cannot run on
 * the exact ticket class this pipeline exists to serve. The missing fixSiteAnalysis is the symptom;
 * this contract is the cause. Live 2026-09-01, run 20260901T224029Z, story AMSD-1919.
 *
 * THE GUARD ITSELF IS RIGHT and must stay: an empty placeholder silently produces a prompt missing
 * a section the agent was told to rely on. What is wrong is the DECLARATION — this template treats
 * ACs as mandatory input when its own subject matter never has them. The detective works from the
 * description and the survey hypothesis, which brownfield does supply.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const TPL = join(REPO, 'orchestrations/prompts/templates/code-graph-detective.json');
const tpl = JSON.parse(readFileSync(TPL, 'utf8'));

describe('the detective runs on a brownfield defect', () => {
  it('the template is real and still has its own inputs', () => {
    // Non-vacuity: an emptied template would satisfy every "does not contain" below while
    // proving nothing.
    expect(tpl.placeholders, 'the detective template declares no placeholders').toBeTruthy();
    expect(tpl.placeholders.length, 'the template lost its inputs').toBeGreaterThan(5);
    expect(String(tpl.body || '').length, 'the template body is empty').toBeGreaterThan(2000);
  });

  it('ACs ARE OUT OF SCOPE FOR THIS TEMPLATE — not optional, ABSENT', () => {
    // Operator ruling: a brownfield detective must not take acceptance criteria as an input at
    // all. Declaring them mayBeEmpty would keep a field in the contract that has no business
    // being there, and would leave the prompt carrying an empty "Acceptance criteria:" heading.
    expect(tpl.placeholders, '__STORY_ACS__ is still a declared input to the detective')
      .not.toContain('__STORY_ACS__');
    expect(String(tpl.body || ''), '__STORY_ACS__ is still substituted into the body')
      .not.toContain('__STORY_ACS__');
    expect(String(tpl.body || ''),
      'the "Acceptance criteria:" heading survives with nothing under it')
      .not.toMatch(/Acceptance criteria:/i);
  });

  it('the inputs the detective ACTUALLY works from stay mandatory', () => {
    // The fix must not weaken the contract generally. Description and repo path are what a
    // brownfield detective reasons over; if those may be empty, it can render with nothing.
    const mayBeEmpty = tpl.mayBeEmpty || [];
    for (const required of ['__STORY_DESCRIPTION__', '__REPO_PATH__']) {
      expect(mayBeEmpty,
        `${required} was made optional — the detective could then render with no subject at all`)
        .not.toContain(required);
    }
  });

  it('the guard still exists — this is a declaration change, not a disabled check', () => {
    const guard = readFileSync(join(REPO, 'orchestrations/scripts/lib/engine-prompt.js'), 'utf8');
    expect(guard, 'the empty-placeholder guard was removed instead of the declaration corrected')
      .toMatch(/was given EMPTY values for/);
  });
});
