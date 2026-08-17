/**
 * THE SURVEY COULD ONLY EVER RECOMMEND PEOPLE TO LOOK, NEVER PEOPLE TO WRITE.
 *
 * TOOL_ESTATE_SURVEY required ['codelines', 'recommendedInvestigators'] and had no field of any
 * kind for the roles that do the work. Those recommendations are iterated straight into the mint's
 * context, so the mint saw N investigator recommendations and zero for anyone who writes code.
 *
 * Live 2026-08-17, run 20260817T171347Z:
 *
 *     minted: transit-fare-engineer      kind: investigator  codeline: mocka
 *     minted: transit-schedule-engineer  kind: investigator  codeline: mockb
 *     projectRoles: []
 *     roster review (cycle 1): sound — 0 finding(s), 0 blocking
 *     FAILED: [assign] no project implementation roles are registered
 *
 * Two stories to fix, two agents to look at them, nobody to write a line of code.
 *
 * THE COUPLING IS PERVERSE, WHICH IS WHY IT SURFACED ONLY AFTER THE SURVEY WAS FIXED. Run 4's
 * survey partially failed, so the investigator signal was weak and the mint guessed 'implementer'
 * for some roles. Run 6's survey was CORRECT and richly investigator-focused, so the mint labelled
 * everything 'investigator'. Improving the survey made the roster worse.
 *
 * The survey may still never name a fix site — that constraint is what stops one codeline's
 * evidence contaminating another's writer manifest. "This codeline needs someone who can write X"
 * names no file and leaks nothing; it belongs exactly where recommendedInvestigators already sits,
 * which the schema comment carves out as a recommendation about the TEAM rather than a finding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const codelines = [{ name: 'mocka', path: '/tmp/mock-a' }, { name: 'mockb', path: '/tmp/mock-b' }];

const payload = (over: Record<string, unknown> = {}) => ({
  codelines: [
    { codeline: 'mocka', state: 'in_scope', evidence: 'read it', filesRead: ['src/a.ts'], surfaces: [] },
  ],
  recommendedInvestigators: [{ codeline: 'mocka', focus: 'the boundary', why: 'saw it' }],
  recommendedWriters: [{ codeline: 'mocka', focus: 'TypeScript fare logic', why: 'the fix lands here' }],
  ...over,
});

describe('the survey only ever staffs for looking', () => {
  it('the schema ASKS for writer recommendations', () => {
    const t = spec.TOOL_ESTATE_SURVEY;
    expect(t, 'the survey schema is not exported, so its contract cannot be asserted').toBeTruthy();
    const props = Object.keys(t.parameters.properties);
    expect(props, 'the survey still cannot recommend anyone who writes code')
      .toContain('recommendedWriters');
    expect(t.parameters.required,
      'writer recommendations are optional, so a model will keep omitting them')
      .toContain('recommendedWriters');
  });

  it('a writer recommendation SURVIVES the sanitizer', () => {
    // recommendedInvestigators survives; if the new field were stripped the mint would see
    // exactly what it saw before and nothing would change.
    const out = spec.sanitizeSurvey(payload(), codelines);
    expect(out.recommendedWriters, 'writer recommendations were discarded on the way out')
      .toHaveLength(1);
    expect(out.recommendedWriters[0].codeline).toBe('mocka');
    expect(out.recommendedWriters[0].focus).toMatch(/fare logic/);
  });

  it('IT STILL MAY NOT CARRY A FIX SITE — the contamination rule applies equally', () => {
    // The whole reason the survey is forbidden from naming files. A new field must not become
    // the fourth contamination route.
    const dirty = payload({
      recommendedWriters: [{
        codeline: 'mocka', focus: 'fix it', why: 'because',
        file: 'src/fares.ts', function: 'fareFor', fix: 'change > to >=', locationHint: 'line 10',
      }],
    });
    const w = spec.sanitizeSurvey(dirty, codelines).recommendedWriters[0];
    for (const k of ['file', 'function', 'fix', 'locationHint']) {
      expect(w[k], `a fix site leaked out of the survey via recommendedWriters.${k}`).toBeUndefined();
    }
    expect(w.focus, 'the legitimate recommendation was thrown away with the fix site').toBeTruthy();
  });

  it('a recommendation for a codeline not in scope is dropped', () => {
    const out = spec.sanitizeSurvey(
      payload({ recommendedWriters: [{ codeline: 'ghost', focus: 'x', why: 'y' }] }), codelines);
    expect(out.recommendedWriters, 'a writer was recommended for a codeline nobody declared')
      .toHaveLength(0);
  });

  it('an absent field is an empty list, never a crash', () => {
    const out = spec.sanitizeSurvey(payload({ recommendedWriters: undefined }), codelines);
    expect(Array.isArray(out.recommendedWriters)).toBe(true);
    expect(out.recommendedWriters).toHaveLength(0);
  });

  it('THE PROPOSAL PROMPT DEMANDS AT LEAST ONE WRITER, and explains kind', () => {
    // The prompt declared {name, systemPrompt, rationale} while the schema required
    // [name, kind, codeline, systemPrompt, rationale] — so the model had to invent values for two
    // fields it was never told about, and guessed 'investigator' for all of them.
    const p = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/agent-proposal.json'), 'utf8'));
    const body: string = p.body;
    expect(body, 'the prompt never mentions the kind field the schema forces it to emit')
      .toMatch(/\bkind\b/);
    expect(body, 'the prompt never names the two kinds').toMatch(/implementer/);
    expect(body, 'the prompt never names the two kinds').toMatch(/investigator/);
    expect(body, 'the prompt never mentions codeline, which the schema always requires')
      .toMatch(/codeline/);
    expect(body, 'nothing requires at least one role that actually writes code')
      .toMatch(/at least one implementer/i);
  });

  it('the prompt\'s declared JSON shape matches the schema it is validated against', () => {
    const p = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/agent-proposal.json'), 'utf8'));
    // Every field the schema requires must appear in the shape the prompt shows the model.
    for (const field of ['name', 'kind', 'codeline', 'systemPrompt', 'rationale']) {
      expect(p.body, `the prompt's example output omits '${field}', which the schema requires`)
        .toMatch(new RegExp(`"${field}"`));
    }
  });
});
