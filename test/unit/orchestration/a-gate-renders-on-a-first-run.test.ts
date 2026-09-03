/**
 * A GATE MUST BE ABLE TO RUN THE FIRST TIME.
 *
 * The renderer refuses a placeholder that is empty and undeclared, and it is right to: a blank
 * section makes the agent answer about silence, and it cannot tell a failed lookup from a genuine
 * absence. But some absences are ordinary. On a first cycle there are no prior reviews; with the KB
 * cleared per run there are no learned rules; a clean story has no uncovered verification criteria;
 * a role may simply have no skill notes.
 *
 * None of those were declared, so on 2026-08-28 the team-lead reviewer could not render at all:
 *
 *   [prompt-library] prompt 'team-lead-review' was given EMPTY values for:
 *                    __LEARNED_RULES_BLOCK__, __PRIOR_REVIEW__, __UNCOVERED_VC_BLOCK__
 *   [team-lead-review] FATAL: could not render the review prompt
 *
 * It emitted a synthetic phase-level changes_requested, no per-story feedback existed, the loop
 * re-ran the review eight times and halted the run — with two CORRECT one-line fixes sitting on
 * their branches, unreviewed. The failure analyst, whose job is to diagnose exactly that, died on
 * the same fault (__SKILL_ADDENDUM__).
 *
 * Declaring is not blanket permission: each of these has a producer with a deliberate empty branch,
 * and the one that can also fail (prior-reviews.py) WARNS on failure, so declaring it hides nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const tpl = (n: string) =>
  JSON.parse(readFileSync(join(ROOT, `orchestrations/prompts/templates/${n}.json`), 'utf8'));

/** The placeholders each gate legitimately renders empty, with why. */
const ORDINARY_ABSENCES: Record<string, Record<string, string>> = {
  'team-lead-review': {
    __LEARNED_RULES_BLOCK__: 'the KB is cleared per run, so a first review has learned nothing yet',
    __PRIOR_REVIEW__: 'the first cycle has no earlier review of its own to read',
    __UNCOVERED_VC_BLOCK__: 'every verification criterion covered is the GOOD outcome, not an error',
    __FIX_ANALYSIS_BLOCK__: 'a story with no root-cause analysis is ordinary — greenfield work, or a '
      + 'story the detective did not analyse. Undeclared, the reviewer REFUSED TO RENDER for it and '
      + 'the phase could not proceed: the producer is `[ -n "$STORY_FIX_ANALYSIS" ] && ... || true`, '
      + 'a deliberate empty, exactly like the uncovered-VC block above',
    __TEST_FILES__: 'the producer is a git diff filtered to test-file paths, so a story that changed '
      + 'no test file yields nothing — ordinary for a greenfield story, and for any change whose '
      + 'tests have not been written yet. Undeclared, the reviewer would refuse to render for '
      + 'exactly those stories',
    __PROJECT_TOOLS_BLOCK__: 'the producer is `--arg tools "${_review_project_tools_block:-}"`, an '
      + 'explicit `:-` default and therefore a deliberate empty: a project that declares no tools '
      + 'has nothing to say here, which is not the same as a failed lookup',
  },
  'failure-analyst': {
    __SKILL_ADDENDUM__: 'a role may carry no accumulated skill notes',
  },
  'prd-change-reviewer': {
    __BEFORE__: 'an ac_patch on a story whose acceptanceCriteria were absent is an ADDITION, so the '
      + 'caller passes "" deliberately — __AFTER__ stays undeclared, because an empty after-state '
      + 'means the change itself is missing',
  },
};

describe('THE GATES CAN RENDER ON A FIRST RUN', () => {
  for (const [name, absences] of Object.entries(ORDINARY_ABSENCES)) {
    for (const [ph, why] of Object.entries(absences)) {
      it(`${name} declares ${ph} — ${why}`, () => {
        const doc = tpl(name);
        expect(doc.mayBeEmpty ?? [],
          `${ph} is empty on an ordinary run and undeclared, so ${name} cannot render at all`)
          .toContain(ph);
      });
    }
  }
});

describe('DECLARING IS NOT BLANKET PERMISSION', () => {
  it('the gates declare only the absences that are ordinary', () => {
    // The renderer's refusal is the thing that catches a failed lookup. A template that declared
    // everything would render a prompt full of blank sections and never say a word.
    for (const [name, absences] of Object.entries(ORDINARY_ABSENCES)) {
      const doc = tpl(name);
      const declared: string[] = doc.mayBeEmpty ?? [];
      const extra = declared.filter((p) => !(p in absences));
      expect(extra, `${name} declares placeholders beyond the ordinary absences; each one silences `
        + 'the check that catches a failed lookup').toEqual([]);
    }
  });

  it('every declared placeholder is one the template actually uses', () => {
    for (const name of Object.keys(ORDINARY_ABSENCES)) {
      const doc = tpl(name);
      const body = Array.isArray(doc.body) ? doc.body.join('\n') : String(doc.body ?? '');
      const orphans = (doc.mayBeEmpty ?? []).filter((p: string) =>
        !body.includes(p) && !(doc.placeholders ?? []).includes(p));
      expect(orphans, `${name} declares a placeholder it does not use — the declaration is stale`)
        .toEqual([]);
    }
  });
});
