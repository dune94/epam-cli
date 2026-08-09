/**
 * THE SURVEY WAS GIVEN EIGHT TOOL CALLS TO CHARACTERISE AN ENTIRE ESTATE.
 *
 * Live 2026-08-08, AMSD-2041. The estate survey reported, for all three codelines:
 *
 *   "Searched for live_preview, live-preview, livePreview, onEntryChange,
 *    ContentstackLivePreview, Contentstack.Stack, and case-insensitive 'contentstack'
 *    — all returned zero matches. No existing live preview infrastructure was found,
 *    meaning this is greenfield work."
 *
 * `grep -ri contentstack src/` returns 243 files in the first of those codelines alone. The
 * survey concluded GREENFIELD about a brownfield estate, and wrote that into
 * estate-survey.json — which the investigators and the detective read next.
 *
 * The budget is why. specAgentEnv pinned EPAM_MAX_TOOL_CALLS to 8 for every spec-mode agent
 * regardless of how much ground it had to cover, and the survey's own prompt orders it to
 * "For EVERY codeline above, OPEN IT" — seven distinct search patterns against three separate
 * repositories, plus any listing or reading, against a ceiling of eight calls.
 *
 * A single-story agent looking at one codeline and an estate survey looking at N are not the
 * same job and cannot share one ceiling. The budget scales with the ground to cover, from the
 * codeline list the caller already has — nothing about any estate's size is written here.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { specAgentEnv } = spec;

const codelines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `cl${i}`, path: `/estate/cl${i}` }));

beforeEach(() => {
  delete process.env.SPEC_MODE_MAX_TOOL_CALLS;
  delete process.env.EPAM_SURVEY_TOOL_CALLS_PER_CODELINE;
});

describe('the single-codeline default is unchanged', () => {
  it('an ordinary spec-mode agent still gets the established ceiling', () => {
    expect(specAgentEnv({}, '/estate/cl0').EPAM_MAX_TOOL_CALLS).toBe('8');
  });

  it('an explicit SPEC_MODE_MAX_TOOL_CALLS still wins', () => {
    expect(specAgentEnv({ SPEC_MODE_MAX_TOOL_CALLS: '25' }, '/x').EPAM_MAX_TOOL_CALLS).toBe('25');
  });
});

describe('THE DEFECT: a survey over N codelines gets a budget for N codelines', () => {
  const budget = (n: number, env: any = {}) =>
    parseInt(spec.surveyToolBudget(codelines(n), env), 10);

  it('one codeline is not penalised — it gets at least the ordinary ceiling', () => {
    expect(budget(1)).toBeGreaterThanOrEqual(8);
  });

  it('three codelines get strictly more than one codeline', () => {
    expect(
      budget(3),
      'the survey had the same eight calls for three repositories as for one',
    ).toBeGreaterThan(budget(1));
  });

  it('the budget grows with the estate, not in fixed steps', () => {
    expect(budget(6)).toBeGreaterThan(budget(3));
    expect(budget(3)).toBeGreaterThan(budget(2));
  });

  it('three codelines can afford the seven patterns the survey actually runs, in each', () => {
    // The live survey ran 7 distinct searches per codeline. Anything less than that cannot
    // complete the sweep it is instructed to perform, which is how it "found" nothing.
    expect(budget(3)).toBeGreaterThanOrEqual(21);
  });

  it('nothing about a particular estate size is baked in — it is per-codeline times N', () => {
    const one = budget(1, { EPAM_SURVEY_TOOL_CALLS_PER_CODELINE: '10' });
    const four = budget(4, { EPAM_SURVEY_TOOL_CALLS_PER_CODELINE: '10' });
    expect(four).toBe(one * 4);
  });

  it('the per-codeline rate is configurable', () => {
    expect(budget(2, { EPAM_SURVEY_TOOL_CALLS_PER_CODELINE: '3' }))
      .toBeLessThan(budget(2, { EPAM_SURVEY_TOOL_CALLS_PER_CODELINE: '30' }));
  });

  it('an empty or missing codeline list does not produce a nonsense budget', () => {
    expect(parseInt(spec.surveyToolBudget([], {}), 10)).toBeGreaterThan(0);
    expect(parseInt(spec.surveyToolBudget(null as any, {}), 10)).toBeGreaterThan(0);
  });

  it('an explicit SPEC_MODE_MAX_TOOL_CALLS still overrides the computed budget', () => {
    expect(spec.surveyToolBudget(codelines(5), { SPEC_MODE_MAX_TOOL_CALLS: '11' })).toBe('11');
  });
});
