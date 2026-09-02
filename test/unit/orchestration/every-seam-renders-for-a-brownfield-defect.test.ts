/**
 * EVERY SEAM'S PROMPT MUST RENDER FOR THE TICKET CLASS THIS PIPELINE SERVES.
 *
 * Brownfield judges on VERIFICATION CRITERIA. Acceptance criteria are out of scope: the ticket has
 * none, the spec pass discards any a spec agent invents ("brownfield — ignoring 8 AC(s) ... ACs are
 * out of scope and VCs come from the description"), and that is correct behaviour, not a defect.
 *
 * 5f3995f2 added a fail-closed guard — an empty placeholder value refuses the render, "all 39 seams
 * held to it". bb98b5ce then declared mayBeEmpty for the blocks that are absent by design. It
 * missed __STORY_ACS__, which on brownfield is ALWAYS absent. So four live seams could not render
 * on the only ticket class this pipeline runs:
 *
 *   code-graph-detective   the agent whose whole job is finding the cause before code is written
 *   team-lead-review       the reviewer
 *   code-review-cycle      the review loop
 *   failure-analyst        the diagnostician
 *
 * Live 2026-09-01, AMSD-1919:
 *   code-graph-detective unavailable (prompt was given EMPTY values for: __STORY_ACS__)
 *   ⛔ DEFECT AMSD-1919 has NO fixSiteAnalysis — the implementer gets symptom ACs with no root cause
 *
 * WHY THE EXISTING TESTS MISSED IT, which is the point of this file. They asserted the GUARD FIRES
 * on an empty value — mechanism, not outcome. Nothing asserted that a seam can actually render with
 * the values a real brownfield ticket supplies. A guard held over 39 seams that none of them can
 * satisfy is not coverage; it is a run that dies later.
 *
 * THIS TEST ASSERTS THE OUTCOME: for every template a seam actually runs, no placeholder is
 * mandatory that brownfield cannot supply. It is derived from the registry, so a seam added
 * tomorrow is covered with no edit here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const TPL_DIR = join(REPO, 'orchestrations/prompts/templates');
const registry = JSON.parse(
  readFileSync(join(REPO, 'orchestrations/agents/invocation-profiles.json'), 'utf8'),
);

/** Templates a SEAM actually runs. A template no seam names cannot block a run. */
const liveTemplates = [...new Set(
  Object.values<any>(registry.profiles || {}).map((p) => p && p.template).filter(Boolean),
)].filter((t) => existsSync(join(TPL_DIR, `${t}.json`)));

/**
 * Inputs a brownfield defect ticket CANNOT supply.
 *
 * Acceptance criteria in every spelling the templates have used. Matched by shape, not by an
 * enumerated list of names, so a template introducing __ACCEPTANCE_CRITERIA__ tomorrow is caught
 * without editing this file — the failure mode here was precisely an exemption list that had to be
 * remembered and was not.
 */
const ABSENT_ON_BROWNFIELD = /(^|_)(ACS|ACCEPTANCE_CRITERIA|CURRENT_ACS|EXISTING_ACS)(_|$)/;

function templateDoc(id: string) {
  return JSON.parse(readFileSync(join(TPL_DIR, `${id}.json`), 'utf8'));
}

describe('every seam renders for a brownfield defect', () => {
  it('there are live seam templates to check — otherwise this proves nothing', () => {
    expect(liveTemplates.length, 'no seam names a template that exists on disk')
      .toBeGreaterThan(20);
  });

  it('the detector recognises an acceptance-criteria placeholder', () => {
    // Positive control. A pattern that matches nothing would make every assertion below pass.
    for (const name of ['__STORY_ACS__', '__ACCEPTANCE_CRITERIA__', '__CURRENT_ACS__']) {
      expect(ABSENT_ON_BROWNFIELD.test(name), `${name} is not recognised as an AC input`).toBe(true);
    }
    expect(ABSENT_ON_BROWNFIELD.test('__VC_BLOCK__'), 'a VC input was mistaken for an AC input')
      .toBe(false);
  });

  it('NO LIVE SEAM REQUIRES ACCEPTANCE CRITERIA — brownfield supplies none', () => {
    const blocking: string[] = [];
    for (const id of liveTemplates) {
      const doc = templateDoc(id);
      const mayBeEmpty = new Set<string>(Array.isArray(doc.mayBeEmpty) ? doc.mayBeEmpty : []);
      const bad = (doc.placeholders || [])
        .filter((p: string) => ABSENT_ON_BROWNFIELD.test(p) && !mayBeEmpty.has(p));
      if (bad.length) blocking.push(`${id} -> ${bad.join(', ')}`);
    }
    expect(blocking, `${blocking.length} live seam(s) cannot render on a brownfield defect, because `
      + 'they demand acceptance criteria the ticket class never has:\n' + blocking.join('\n'))
      .toEqual([]);
  });

  it('and the AC token is gone from their BODIES, not merely undeclared', () => {
    // Undeclaring it while leaving __STORY_ACS__ in the body would render the literal token into
    // the prompt — worse than the refusal, because nothing would report it.
    const leaked: string[] = [];
    for (const id of liveTemplates) {
      const doc = templateDoc(id);
      const body = String(doc.body || JSON.stringify(doc.bodies || ''));
      const declared = new Set<string>(doc.placeholders || []);
      for (const tok of body.match(/__[A-Z0-9_]+?__/g) || []) {
        if (ABSENT_ON_BROWNFIELD.test(tok) && !declared.has(tok)) leaked.push(`${id} -> ${tok}`);
      }
    }
    expect(leaked, `an AC token survives in a body with no declaration: ${leaked.join(', ')}`)
      .toEqual([]);
  });

  it('THE GUARD IS INTACT — this is a contract correction, not a disabled check', () => {
    // The guard is right: an empty payload renders a blank section and the agent answers about
    // silence. What was wrong was demanding an input this ticket class cannot produce.
    const guard = readFileSync(join(REPO, 'orchestrations/scripts/lib/engine-prompt.js'), 'utf8');
    expect(guard, 'the empty-value guard was removed instead of the contracts corrected')
      .toMatch(/was given EMPTY values for/);
  });
});
