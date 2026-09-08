/**
 * THE ROSTER SPECIALISER IS GIVEN WHAT THE SURVEY SAW.
 *
 * The specialiser writes the paragraph of project facts that is baked into EVERY persona in the
 * roster. It was handed codeline NAMES, PATHS and DEPENDENCY LISTS and nothing else — no
 * observation of the repositories at all — and then asked to write briefs saying things like
 * "you colocate .spec.tsx files beside the component AS THIS REPO ALREADY DOES".
 *
 * Live 2026-09-08, pipeline-tests-44. It guessed, and the roster review refuted it:
 *
 *   368 total .spec.tsx files exist, 338 (92%) live in __tests__/ subdirectories, not beside
 *   the component ... This is repeated verbatim as established fact in the shared project-facts
 *   paragraph baked into nearly every agent in this batch.
 *
 * Three attempts, escalating sonnet -> opus-4-8: $8.23 for the specialiser plus $3.47 of roster
 * review to refute it — 52% of that run — spent guessing at a fact `find` answers instantly.
 *
 * The estate survey had already opened those repositories. spec-mode-runner.js says so itself:
 * "This is the only input here derived from opening the repositories. Everything else ... is a
 * claim about the code rather than an observation of it, which is how briefs came to name modules
 * that do not exist." But `estateSurvey` is consumed only by mintProjectAgents, so it reached the
 * seam that chooses WHICH agents to make and never the one that decides WHAT THEY BELIEVE.
 *
 * The same defect was already fixed one seam over — surveyHypothesisBlock exists because the
 * detective "spent a top-ladder call with an iteration budget rediscovering" what the survey held.
 *
 * THE WARNING TRAVELS WITH THE EVIDENCE. A survey line handed over bare is worse than none: it is
 * exactly what got restated as established fact. The block must carry its own "these are leads"
 * caveat, because a brief is inherited whole and re-checked by nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const TEMPLATE = join(REPO_ROOT, 'orchestrations/prompts/templates/roster-specialisation.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(RUNNER);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const SURVEY = {
  ran: true,
  codelines: [
    { codeline: 'gotransit.web', state: 'in_scope', surfaces: ['src/components/CheckoutForm.tsx'],
      filesRead: ['src/components/CheckoutForm.tsx'],
      evidence: 'tests live under __tests__/ subdirectories, not beside the component' },
    { codeline: 'api.stations', state: 'no_work_found', surfaces: [], evidence: 'nothing matched' },
  ],
  recommendedInvestigators: [],
};

describe('the survey reaches the roster specialiser', () => {
  it('EXPOSES THE OBSERVATIONS as a reusable block', () => {
    expect(typeof mod.surveyLeadsBlock,
      'surveyLeadsBlock is not exported, so the observations the survey made cannot be handed to '
      + 'any seam but the mint').toBe('function');
    const b = mod.surveyLeadsBlock(SURVEY);
    expect(b, 'the block omits what the survey actually observed')
      .toContain('__tests__/ subdirectories');
    expect(b).toContain('gotransit.web');
  });

  it('CARRIES THE WARNING WITH IT — evidence handed over bare is what got restated as fact', () => {
    const b = mod.surveyLeadsBlock(SURVEY);
    expect(b, 'the block hands over survey claims without the caveat that they are leads — which '
      + 'is precisely how "as this repo already does" ended up in every persona')
      .toMatch(/lead|not settled|do not restate/i);
  });

  it('IS EMPTY WHEN THERE IS NOTHING TRUSTWORTHY — never a fabricated block', () => {
    expect(mod.surveyLeadsBlock(null)).toBe('');
    expect(mod.surveyLeadsBlock({ ran: false })).toBe('');
    expect(mod.surveyLeadsBlock({ ran: true, codelines: [] })).toBe('');
  });

  it('THE TEMPLATE DECLARES A SLOT FOR IT, so the wiring cannot be silently absent', () => {
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    expect(t.placeholders, 'roster-specialisation declares no survey slot, so the specialiser '
      + 'still writes project facts from names and paths alone')
      .toContain('__SURVEY_LEADS__');
    expect(t.mayBeEmpty, 'a run with no survey must still render — the slot has to be allowed empty')
      .toContain('__SURVEY_LEADS__');
    expect(t.body).toContain('__SURVEY_LEADS__');
  });

  it('THE RENDERED PROMPT CARRIES THE OBSERVATIONS — the artefact, not the plumbing', () => {
    const values: Record<string, string> = {
      __CANONICAL_COPY_PATH__: '/tmp/canonical.json',
      __OUT_PATH__: '/tmp/roster.json',
      __PROJECT_CONTEXT__: 'ctx',
      __CODELINE_CONTEXT__: '- gotransit.web (/repo)',
      __STACK__: 'node',
      __PREVIOUS_REFUSAL__: '',
      __DECLARED_SEAMS__: '- spec-agent',
      __SURVEY_LEADS__: mod.surveyLeadsBlock(SURVEY),
    };
    const rendered = renderEngineTemplate('roster-specialisation', values);
    expect(rendered.length, 'nothing rendered — the assertions below would be vacuous')
      .toBeGreaterThan(200);
    expect(rendered, 'the specialiser prompt does not carry what the survey observed')
      .toContain('__tests__/ subdirectories');
  });

  it('A RUN THAT SUPPLIES NO SURVEY SLOT IS REFUSED — wiring cannot rot silently', () => {
    const values: Record<string, string> = {
      __CANONICAL_COPY_PATH__: '/tmp/c.json', __OUT_PATH__: '/tmp/r.json',
      __PROJECT_CONTEXT__: 'ctx', __CODELINE_CONTEXT__: '- x (/repo)',
      __STACK__: 'node', __PREVIOUS_REFUSAL__: '', __DECLARED_SEAMS__: '- spec-agent',
    };
    expect(() => renderEngineTemplate('roster-specialisation', values),
      'the renderer accepted a prompt with no survey slot supplied, so a future edit could drop '
      + 'the wiring and nothing would notice').toThrow(/missing values for/i);
  });
});
