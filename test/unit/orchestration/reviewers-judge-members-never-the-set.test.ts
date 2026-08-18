/**
 * THE ROSTER REVIEWER JUDGES BRIEFS, AND THE SURVEY IS JUDGED BY NOBODY.
 *
 * #2 — roster-review opens "THE ROSTER JUST MINTED FOR THIS PROJECT — review every BRIEF below"
 * and its inputs are __BRIEF_BLOCK__, __CODELINE_BLOCK__, __TICKET_BLOCK__. It contains no mention
 * of coverage, missing, or absent. It is structurally per-member, so it cannot see that the SET
 * lacks anyone able to do the work — which is why it returned "sound — 0 finding(s), 0 blocking"
 * on a roster of two investigators and no implementer, live 2026-08-17 run 20260817T171347Z, and
 * the run then died at assignment.
 *
 * The answer is NOT a gate downstream of the reviewer — one was written, blocked a healthy run on
 * a false positive, and has been removed. The reviewer must be able to SEE the question. It is
 * given what the registry already declares: which artefacts this run requires, which seam produces
 * each, and which roster member resolves to which seam. Then "nobody here can produce X" is a
 * finding it can make, not a condition someone checks for afterwards.
 *
 * #3 — the survey is consumed by NOTHING that reviews it:
 *
 *     seams consuming a survey: NONE
 *     estate-survey produces:   "estate-survey"
 *     who consumes that:        NOBODY DECLARED
 *
 * Its claims flow straight into the mint's context and become investigator briefs. That is how
 * "mockb contains src/fares.ts" — a file that codeline does not have — became a brief. A validator
 * that silently rewrote the survey was written for this and has been removed; the survey needs
 * what a generated prompt already gets: an adversarial reviewer that falsifies its claims against
 * the repositories BEFORE anything inherits them.
 *
 * prompt-review is the pattern both follow: read-only tools, ground truth as a required input,
 * findings that must carry the check that was run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));
const template = (id: string) => JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));
const bodyOf = (j: any) => (typeof j.body === 'string'
  ? j.body
  : Object.values(j.bodies || {}).filter((v) => typeof v === 'string').join('\n'));

describe('reviewers judge members, never the set', () => {
  describe('#2 the roster reviewer can see whether the team can do the work', () => {
    it('is GIVEN the coverage picture, not just the briefs', () => {
      const t = template('roster-review');
      expect(t.placeholders, 'the reviewer is handed no coverage information at all')
        .toContain('__COVERAGE_BLOCK__');
      expect(bodyOf(t), 'the prompt never renders what it was given').toMatch(/__COVERAGE_BLOCK__/);
    });

    it('is ASKED the question — a per-brief reviewer cannot see an absence', () => {
      const b = bodyOf(template('roster-review'));
      expect(b, 'nothing asks whether the roster can produce what the run requires')
        .toMatch(/produce|cover/i);
      // Absence is the specific thing a member-by-member review cannot see.
      expect(b, 'the reviewer is not told that a missing role is itself a defect')
        .toMatch(/absent|missing|nobody|no one/i);
    });

    it('the coverage block is DERIVED from the registry, naming no role', () => {
      // Which artefacts are required, and which seam produces each, is already declared. A literal
      // list of roles here would be the hardcoding the derivation exists to avoid.
      const b = bodyOf(template('roster-review'));
      expect(b, 'the prompt names a kind directly instead of being handed the derivation')
        .not.toMatch(/\bimplementer\b.*\bmust\b|\bat least one implementer\b/i);
    });

    it('its seam still declares what it consumes, with the roster required', () => {
      const p = registry().profiles['roster-review'];
      expect(p, 'roster-review is no longer a seam').toBeTruthy();
      expect((p.consumes || []).some((c: any) => c.kind === 'roster' && c.required),
        'the reviewer no longer requires the roster it reviews').toBe(true);
    });
  });

  describe('#3 the survey is reviewed before anything inherits it', () => {
    it('a survey-review seam exists', () => {
      const p = registry().profiles['survey-review'];
      expect(p, 'nothing reviews the survey; its claims reach the mint unchallenged').toBeTruthy();
      expect(p.template).toBe('survey-review');
      expect(p.produces, 'the review produces no verdict anything could consume').toBeTruthy();
    });

    it('it reads the repositories — a claim is falsified against ground truth, not opinion', () => {
      const p = registry().profiles['survey-review'];
      expect(p.toolGrant, 'a reviewer that cannot open a file reviews from imagination')
        .toMatch(/read/);
      const consumes = (p.consumes || []).map((c: any) => c.kind);
      expect(consumes, 'the review does not receive the survey it is reviewing')
        .toContain('estate-survey');
    });

    it('the template exists and asks for falsification, not improvement', () => {
      expect(existsSync(join(TEMPLATES, 'survey-review.json')),
        'the seam names a template that does not exist').toBe(true);
      const b = bodyOf(template('survey-review'));
      expect(b, 'the reviewer is not told to check claims against the repositories')
        .toMatch(/exist|check|verif|falsif/i);
      // The survey's own hard constraint must survive into its reviewer.
      expect(b, 'the reviewer is not told the survey may never name a fix site')
        .toMatch(/fix site|which file to edit|not yours/i);
    });

    it('the template declares every placeholder its body uses, and no more', () => {
      const t = template('survey-review');
      const used = [...new Set((bodyOf(t).match(/__[A-Z_]+__/g) || []))].sort();
      expect((t.placeholders || []).slice().sort(),
        'declared placeholders and the body disagree, which the renderer refuses')
        .toEqual(used);
    });
  });
});
