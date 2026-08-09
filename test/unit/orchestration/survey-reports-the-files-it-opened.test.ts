/**
 * THE SURVEY WAS FORBIDDEN FROM NAMING THE FILES IT READ.
 *
 * Three places told it to report directories and not files — the `surfaces` schema field
 * ("Areas of the repository involved: directories or modules. NOT specific files ... Breadth
 * only"), the prohibition in the prompt ("Name directories and modules, never a file"), and the
 * JSON example ("<directory or module>").
 *
 * That rule exists for a good reason: a fix site chosen from outside a repository is how one
 * codeline's file ends up in another's work, and choosing it belongs to the per-codeline
 * investigator. But the wording forbids two different things at once:
 *
 *   EVIDENCE     — "I opened src/hooks/useContent.ts and it fetches through the Stack client."
 *                  An observation. Verifiable. What makes a brief groundable.
 *   PRESCRIPTION — "edit src/hooks/useContent.ts." A fix site. The investigator's to choose.
 *
 * Live 2026-08-09 the survey obeyed literally and reported `src/context/`, `src/hooks/` for
 * two of three codelines. Their investigators were then briefed on directories, and the
 * brief-grounding check that verifies cited paths is nearly vacuous against a directory —
 * `src/context/` exists in every codeline and proves nothing about any of them. Weak evidence
 * in, weak verification out. (gotransit's entry named real files and was the useful one, in
 * violation of the instruction it was given.)
 *
 * `filesRead` is a separate field rather than a loosening of `surfaces`, so evidence and
 * breadth cannot blur back together: one records what was opened, the other what area is
 * involved, and the prohibition on prescribing a change is untouched.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { TOOL_ESTATE_SURVEY, sanitizeSurvey } = spec;

const CODELINES = [{ name: 'one', path: '/e/one' }, { name: 'two', path: '/e/two' }];
const props = () =>
  TOOL_ESTATE_SURVEY.parameters.properties.codelines.items.properties;

describe('the schema asks for the files that were opened', () => {
  it('filesRead exists', () => {
    expect(
      props().filesRead,
      'the survey has no field in which to report what it actually read',
    ).toBeTruthy();
  });

  it('it is a list of strings', () => {
    expect(props().filesRead.type).toBe('array');
    expect(props().filesRead.items.type).toBe('string');
  });

  it('its description asks for files OPENED, as evidence — not files to change', () => {
    const d = String(props().filesRead.description).toLowerCase();
    expect(d).toMatch(/open|read/);
    expect(d).toMatch(/evidence|observ/);
  });

  it('surfaces still means breadth, and still refuses to prescribe a change', () => {
    const d = String(props().surfaces.description).toLowerCase();
    expect(d).toMatch(/director|module|area/);
    expect(d, 'the prohibition on choosing a fix was lost').toMatch(/not a fix|investigator/);
  });
});

describe('the sanitizer keeps what was read', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    codelines: [{
      codeline: 'one', state: 'in_scope', evidence: 'listed the directory',
      surfaces: ['src/hooks/'], filesRead: ['src/hooks/useContent.ts', 'src/services/client.ts'],
      ...over,
    }],
  });

  it('filesRead survives sanitisation', () => {
    const out = sanitizeSurvey(payload(), CODELINES);
    expect(out.codelines[0].filesRead).toEqual(['src/hooks/useContent.ts', 'src/services/client.ts']);
  });

  it('non-strings are dropped rather than carried through', () => {
    const out = sanitizeSurvey(payload({ filesRead: ['ok.ts', null, 42, ''] }), CODELINES);
    expect(out.codelines[0].filesRead).toEqual(['ok.ts']);
  });

  it('a missing filesRead becomes an empty list, never undefined', () => {
    const p: any = payload(); delete p.codelines[0].filesRead;
    expect(sanitizeSurvey(p, CODELINES).codelines[0].filesRead).toEqual([]);
  });

  it('a codeline that was never reported still gets the field', () => {
    // "Silence is not a state" — an unreported codeline is synthesised as not_investigated.
    const out = sanitizeSurvey(payload(), CODELINES);
    const two = out.codelines.find((c: any) => c.codeline === 'two');
    expect(two.state).toBe('not_investigated');
    expect(two.filesRead).toEqual([]);
  });

  it('surfaces are unaffected', () => {
    expect(sanitizeSurvey(payload(), CODELINES).codelines[0].surfaces).toEqual(['src/hooks/']);
  });
});

describe('the prompt asks for it, and still forbids prescribing a change', () => {
  const prompt = () => spec.buildSurveyPrompt({
    codelines: CODELINES, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
    referencedDocs: [], declaredDependencies: ['some-dep'],
  });

  it('it renders', () => {
    expect(prompt().length).toBeGreaterThan(400);
  });

  it('it asks for the exact files opened', () => {
    expect(prompt().toLowerCase()).toMatch(/files you (actually )?opened|exact files/);
  });

  it('THE DEFECT: it no longer forbids naming a file outright', () => {
    expect(
      prompt(),
      'the prompt still says never name a file, so the survey reports directories and its ' +
      'evidence cannot be verified',
    ).not.toMatch(/never a file\b/i);
  });

  it('choosing what to change is still the investigator\'s', () => {
    const p = prompt().toLowerCase();
    expect(p).toMatch(/not.*(choosing|choose).*files to change|do not say which file to edit/);
    expect(p).toMatch(/investigator/);
  });

  it('the cross-codeline warning is preserved — it is why the rule exists', () => {
    expect(prompt().toLowerCase()).toMatch(/one codeline'?s file ends up|swept from the outside/);
  });

  it('every codeline in scope is still named', () => {
    for (const c of CODELINES) expect(prompt()).toContain(c.name);
  });
});

describe('the minter is actually SHOWN the files — a collected field nobody renders is inert', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    codeline: 'one', state: 'in_scope', evidence: 'opened them',
    surfaces: ['src/hooks/'], filesRead: ['src/hooks/useContent.ts'], ...over,
  });

  it('the rendered line names the files that were opened', () => {
    expect(spec.surveyLineFor(entry())).toContain('src/hooks/useContent.ts');
  });

  it('files and areas are distinguishable, not merged into one list', () => {
    const line = spec.surveyLineFor(entry());
    expect(line).toMatch(/areas:/);
    expect(line).toMatch(/files it opened:/);
  });

  it('an entry with no files renders without an empty section', () => {
    const line = spec.surveyLineFor(entry({ filesRead: [] }));
    expect(line).not.toMatch(/files it opened:/);
    expect(line).toContain('evidence:');
  });

  it('the evidence and state are still rendered', () => {
    const line = spec.surveyLineFor(entry());
    expect(line).toContain('in_scope');
    expect(line).toContain('opened them');
  });
});
