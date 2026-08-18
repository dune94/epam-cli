// THE ESTATE SURVEY FOUND THE FIX SITE AND THE DETECTIVE RE-DERIVED IT FROM SCRATCH.
//
// The estate survey reads every codeline before the roster is minted, and records per-codeline
// evidence that is often the whole answer. Live 2026-08-18, mocka:
//
//   "src/fares.ts contains the fare logic. fareFor (line 8) checks
//    `if (rider.age > 65) return CONCESSION_FARE_CENTS` on line 10 — the boundary is strictly
//    greater-than, so a rider aged exactly 65 falls through to BASE_FARE_CENTS (350) instead of
//    the concession fare (175). This is MOCK3-1. Tests in test/fares.test.ts cover ages 30, 8 and
//    70 but do not test age 65, so the boundary gap is uncaught."
//
// File, function, line, the defect, and the test-coverage gap. The Code Graph Detective then
// spends a top-ladder call with an iteration budget rediscovering exactly that, because the
// survey's output is consumed only by the mint: `estateSurvey` is a parameter of
// mintProjectAgents and reaches nothing else. The registry records the survey as producing
// `survey-findings` and no seam declares it as an input.
//
// It is handed over as a STARTING HYPOTHESIS, not an answer. The detective still verifies against
// the index — a survey finding is evidence about the estate, gathered before this story's spec
// existed, and the detective is the seam that owns the fix site. What changes is that it starts
// from what the pipeline already knows instead of from nothing.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const SURVEY = {
  ran: true,
  codelines: [
    { codeline: 'mocka', state: 'in_scope',
      evidence: 'src/fares.ts contains the fare logic. fareFor (line 8) checks the age boundary.',
      surfaces: ['src/fares.ts', 'test/fares.test.ts'] },
    { codeline: 'mockb', state: 'in_scope',
      evidence: 'src/schedule.ts loops to stops.length - 1 and drops the final stop.',
      surfaces: ['src/schedule.ts'] },
  ],
};

let dir: string;
function withSurvey(payload: unknown) {
  dir = mkdtempSync(join(tmpdir(), 'survey-hand-'));
  writeFileSync(join(dir, 'estate-survey.json'), JSON.stringify(payload));
  return dir;
}

describe('the survey found the fix site and told nobody', () => {
  it('HANDS THE CODELINE ITS OWN SURVEY EVIDENCE — the live payload', () => {
    const d = withSurvey(SURVEY);
    const block = runner.surveyHypothesisBlock('mocka', d);
    expect(block, 'the detective is given nothing from the survey').toBeTruthy();
    expect(block, "another codeline's evidence leaked into this one").not.toContain('schedule.ts');
    expect(block).toContain('fares.ts');
    rmSync(d, { recursive: true, force: true });
  });

  it('MARKS IT AS A HYPOTHESIS TO VERIFY, not a conclusion to copy', () => {
    const d = withSurvey(SURVEY);
    const block = runner.surveyHypothesisBlock('mocka', d);
    expect(block, 'the block does not tell the detective to verify it')
      .toMatch(/verif|confirm|check|hypoth/i);
    rmSync(d, { recursive: true, force: true });
  });

  it('IS EMPTY WHEN THE SURVEY SAYS NOTHING ABOUT THIS CODELINE — never invents one', () => {
    const d = withSurvey(SURVEY);
    expect(runner.surveyHypothesisBlock('a-codeline-not-surveyed', d)).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('is empty when there is no survey at all, rather than failing the detective', () => {
    const d = mkdtempSync(join(tmpdir(), 'survey-none-'));
    expect(runner.surveyHypothesisBlock('mocka', d)).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('is empty for a survey that did not run, and for an out-of-scope codeline', () => {
    const d1 = withSurvey({ ran: false, codelines: SURVEY.codelines });
    expect(runner.surveyHypothesisBlock('mocka', d1)).toBe('');
    rmSync(d1, { recursive: true, force: true });
    const d2 = withSurvey({ ran: true, codelines: [{ codeline: 'mocka', state: 'out_of_scope', evidence: 'nothing here' }] });
    expect(runner.surveyHypothesisBlock('mocka', d2)).toBe('');
    rmSync(d2, { recursive: true, force: true });
  });

  it('THE DETECTIVE PROMPT CARRIES IT — a block nobody renders is the defect again', () => {
    const tpl = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json'), 'utf8'));
    expect(tpl.placeholders, 'the detective template has no slot for the survey hypothesis')
      .toContain('__SURVEY_HYPOTHESIS__');
    // The VALUE must be the builder's output. Asserting the token appears somewhere passed with
    // the call replaced by an empty string — the same weakness that let a deleted call site slip
    // through earlier today.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const m = src.match(/__SURVEY_HYPOTHESIS__:\s*([^,\n]+)/);
    expect(m, 'nothing supplies __SURVEY_HYPOTHESIS__ to the detective').toBeTruthy();
    expect(m![1], 'the detective is handed a constant instead of the survey evidence')
      .toMatch(/surveyHypothesisBlock\s*\(/);
  });
});
