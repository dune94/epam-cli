/**
 * A BLOCKER THE WRITER CANNOT SATISFY IS NOT A REVIEW FINDING. IT IS AN UNWINNABLE GATE.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * The reviewer IS given the prescription — file, function, reason and prescribed minimal fix,
 * rendered as "the plan of record the implementer was given". It is not flying blind. Two
 * things are missing, and both were live on 2026-08-12:
 *
 * 1. changeRequired IS NEVER SHOWN TO IT. Zero occurrences in team-lead-review.sh. That is the
 *    field saying "this file is part of the fix and needs NO edit". The reviewer sees
 *    useContent.ts and contentstack.ts listed as prescribed sites, with reasons and fixes
 *    attached, and cannot tell they are exempt. This is the SAME defect that made this story
 *    unwinnable three runs ago — the writer rejected for not editing a file whose own
 *    prescription reads "No edit required" — fixed then on the WRITER's side only.
 *
 * 2. NOTHING BOUNDS A BLOCKER TO THE PRESCRIPTION, and the reviewer is told:
 *
 *        "The correct implementation is the minimal fix above. Judge the diff against BOTH."
 *
 *    "Both" is where pageService.ts came from. It appears nowhere in the prescription; the
 *    acceptance criteria describe behaviour that looks like it needs changing; so the reviewer
 *    demanded it and called the demand "prescribed". The writer then changed 402 lines there.
 *    The same review demanded @contentstack/live-preview-sdk — A PACKAGE THAT DOES NOT EXIST.
 *
 * The writer looks like it is going rogue. It is following orders from an authority nobody
 * reconciled against the plan.
 *
 * THE RULE: a blocker must name a file the prescription names, must not demand an edit to a
 * site marked changeRequired:false, and must be something the writer can actually do. A
 * finding failing any of those is ADVISORY — or a SPEC finding, if the reviewer believes the
 * prescription itself is wrong. It is never a rejection of the writer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const REVIEW_SH = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const src = () => readFileSync(REVIEW_SH, 'utf8');
// THE REVIEWER PROMPT MOVED TO A DOCUMENT (2026-08-13):
// orchestrations/prompts/templates/team-lead-review.json. Asserting prompt text against the
// SCRIPT proved nothing even before the move — a grep passes on a comment — and now the text is
// not there at all. These read the TEMPLATE BODY, which is what the model is sent.
const REVIEW_PROMPT_BODY: string = JSON.parse(
  readFileSync(join(__dirname, '../../../orchestrations/prompts/templates/team-lead-review.json'), 'utf8'),
).body;

const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('the harness is anchored', () => {
  it('the reviewer still renders a prescription', () => {
    expect(code()).toMatch(/STORY_FIX_ANALYSIS/);
  });
});

describe('THE REVIEWER SEES WHICH SITES NEED NO EDIT', () => {
  it('THE DEFECT: changeRequired reaches the reviewer at all', () => {
    expect(code(), 'the reviewer cannot tell an exempt site from a required one')
      .toMatch(/changeRequired/);
  });

  it('an exempt site is rendered as exempt, not as a normal fix site', () => {
    // Rendering it identically to a required site is what lets a reviewer demand an edit the
    // prescription explicitly says is unnecessary.
    const i = code().indexOf('STORY_FIX_ANALYSIS=');
    const block = code().slice(i, i + 900);
    expect(block, 'the prescription rendering does not distinguish exempt sites')
      .toMatch(/changeRequired/);
  });

  it('ABSENT is not treated as exempt', () => {
    // Only an explicit boolean false exempts. Absent means "not yet investigated" — the same
    // reading the writer's enforcement gate and the reset guard already use. A build-config
    // candidate is added with the field absent by design.
    const i = code().indexOf('STORY_FIX_ANALYSIS=');
    const block = code().slice(i, i + 900);
    expect(block).toMatch(/== false|"boolean"/);
  });
});

describe('A BLOCKER IS BOUNDED BY THE PRESCRIPTION', () => {
  it('the reviewer is told a blocker must name a prescribed file', () => {
    expect(REVIEW_PROMPT_BODY, 'nothing stops a blocker demanding work on a file nobody prescribed')
      .toMatch(/blocker[\s\S]{0,400}(prescrib|plan of record)/i);
  });

  it('it is told to raise a SPEC finding when it believes the prescription is wrong', () => {
    // The legitimate escape hatch. Without it, "the plan is incomplete" has nowhere to go
    // except into a blocker against the writer, who cannot change the plan.
    expect(code()).toMatch(/spec/i);
  });

  it('it must NOT demand an edit to a site the prescription exempts', () => {
    expect(code()).toMatch(/no edit|needs no|changeRequired[\s\S]{0,200}false/i);
  });
});

describe('A BLOCKER MUST BE SOMETHING THE WRITER CAN DO', () => {
  // These assert the POLICY TEXT, which lives in the prompt template by design — not in the
  // script, which only renders it. Grepping the script would pass on a comment and fail on a
  // correctly-externalised rule, i.e. exactly backwards.
  const policy = () => JSON.parse(
    readFileSync(join(ROOT, 'orchestrations/prompts/templates/blocker-discipline.json'), 'utf8'),
  ).bodies.reviewer;

  it('the reviewer is told to verify a claimed-missing dependency exists', () => {
    // Live: "@contentstack/live-preview-sdk and @contentstack/live-preview-utils are ABSENT".
    // The first is not a real package. Nothing checked, so the blocker was unsatisfiable and
    // would have repeated forever.
    expect(policy(), 'a blocker can still demand a package that does not exist')
      .toMatch(/CONFIRM IT|does not exist/i);
  });

  it('it is told not to raise a blocker it cannot expect to be satisfied', () => {
    expect(policy()).toMatch(/can never be resolved|exhaust its attempts/i);
  });

  it('and the script actually renders that policy', () => {
    expect(code()).toMatch(/blocker-discipline/);
    expect(code(), 'a policy that fails to render must abort, not silently vanish')
      .toMatch(/BLOCKER_DISCIPLINE_BLOCK[\s\S]{0,400}exit 1/);
  });

  it('THE POLICY REACHES THE PROMPT, not just a shell variable', () => {
    // Caught by mutation: deleting ${BLOCKER_DISCIPLINE_BLOCK} from the prompt body left every
    // other assertion green. Rendering a policy into a variable nobody interpolates is the
    // "computed but never used" defect — correct code, zero effect, and it looks wired.
    // The prescription HEADING is inside the block the caller computes (__FIX_ANALYSIS_BLOCK__),
    // so it lives in the script; the POLICY placeholder lives in the template. Assert each where
    // it actually is, rather than expecting both in one artefact.
    expect(code(), 'the caller no longer builds a prescription block')
      .toMatch(/ROOT CAUSE ANALYSIS & PRESCRIBED MINIMAL FIX/);
    const after = REVIEW_PROMPT_BODY;
    // The placeholder the library fills. A policy rendered into a shell variable nobody
    // interpolates is the "computed but never used" defect; in a document the equivalent is a
    // placeholder the body never names.
    expect(after, 'the policy placeholder is absent from the prompt the model sees')
      .toMatch(/__BLOCKER_DISCIPLINE__/);
  });
});

describe('THE RULE IS DECLARED ONCE, IN THE PROMPT LAYER', () => {
  it('it is not a heredoc rule invented in this script', () => {
    // Same lesson as test-ownership: a rule that binds the reviewer and describes what the
    // WRITER may be asked for is shared policy, not one script's private belief.
    const tpl = join(ROOT, 'orchestrations/prompts/templates/blocker-discipline.json');
    const proj = join(ROOT, 'orchestrations/projects/metrolinx/prompts/blocker-discipline.json');
    expect(() => readFileSync(tpl, 'utf8'), 'no generic template').not.toThrow();
    expect(() => readFileSync(proj, 'utf8'), 'this project has no version of it').not.toThrow();
  });

  it('the reviewer renders it from there', () => {
    expect(code()).toMatch(/blocker-discipline/);
  });

  it('the template carries no project or stack fact', () => {
    const t = readFileSync(join(ROOT, 'orchestrations/prompts/templates/blocker-discipline.json'), 'utf8')
      .toLowerCase();
    for (const leak of ['metrolinx', 'gotransit', 'contentstack', 'pageservice']) {
      expect(t, `'${leak}' is a project fact in a generic template`).not.toContain(leak);
    }
  });
});
