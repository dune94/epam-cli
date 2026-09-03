/**
 * THE GATE MUST HANDLE EVERY WORD ITS CALLER CAN SEND — AND THE CALLER IS NOT THE MODEL.
 *
 * A correction is recorded here because the first version of this file asserted the opposite and
 * cost a run.
 *
 * WHAT I BELIEVED: project-roster.js approved on `verdict === 'approved'`; the captured model
 * output says `sound` / `defects_found`; therefore the gate waited on a word nothing produces. I
 * rewrote it to accept the model's words and asserted here that `approved` must NOT be an approval.
 *
 * WHAT IS TRUE: the gate is not handed the model's verdict. reviewProjectRoster aggregates the
 * review batches and returns its OWN vocabulary — `approved`, `changes_requested`, `review_failed`.
 * The original check was correct. My change made the gate recognise none of its caller's words, so
 * a clean review returned `approved`, fell to the unrecognised branch, and the mint failed three
 * attempts running. Live 2026-09-01: a killed metrolinx run.
 *
 * Both vocabularies are accepted now, because this boundary has been crossed in both directions and
 * neither spelling should be able to fail silently again.
 *
 * THE TEST THAT WOULD HAVE CAUGHT ME is at the bottom: it reads the verdicts out of
 * reviewProjectRoster's own return statements and asserts the gate handles each one. Reading the
 * caller is the check; reading a transcript is how I got it wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/project-roster.js');
const TEMPLATE = join(REPO, 'orchestrations/prompts/templates/project-roster-review.json');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyReviewVerdict } = require(LIB);

const blocking = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, severity: 'blocking', claim: `c${i}` }));
const advisory = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, severity: 'advisory', claim: `c${i}` }));

describe('the roster gate reads the verdict the reviewer emits', () => {
  it('is exported at all', () => {
    expect(typeof classifyReviewVerdict, 'classifyReviewVerdict is not exported').toBe('function');
  });

  it('THE DEFECT: `sound` is an approval', () => {
    // batch5 returned exactly this on 2026-09-01 and the roster was discarded.
    expect(classifyReviewVerdict({ verdict: 'sound', findings: [] }).outcome).toBe('approved');
  });

  it('`defects_found` with a blocking finding is a rejection', () => {
    const r = classifyReviewVerdict({ verdict: 'defects_found', findings: blocking(1) });
    expect(r.outcome).toBe('rejected');
    expect(r.reason, 'the rejection carries nothing for the next attempt to act on').toBeTruthy();
  });

  it('`defects_found` with only advisory findings is an APPROVAL', () => {
    // Advisory findings are notes, not blockers — the mint already proceeds past them elsewhere.
    // Treating them as rejections would fail a roster nobody objected to.
    expect(classifyReviewVerdict({ verdict: 'defects_found', findings: advisory(3) }).outcome)
      .toBe('approved');
  });

  it('`nothing_to_review` blames the JUDGE, not the roster', () => {
    // The reviewer did not look. Deleting the roster over that destroys work the review never
    // examined; the judge is what needs retrying.
    expect(classifyReviewVerdict({ verdict: 'nothing_to_review', findings: [] }).outcome)
      .toBe('review_failed');
  });

  it('an unrecognised verdict is never silently treated as approval', () => {
    // The failure that made this test necessary was a vocabulary mismatch. If it drifts again the
    // gate must say so, not guess in either direction.
    // 'approved' is NOT in this list: it is what reviewProjectRoster returns for a clean review.
    // Asserting it here was my wrong diagnosis written down as a test, and it passed while the
    // pipeline could not approve a roster at all.
    for (const v of ['yes', 'maybe_ok', '', undefined, null]) {
      const r = classifyReviewVerdict({ verdict: v as any, findings: [] });
      expect(r.outcome, `"${String(v)}" was treated as an approval`).not.toBe('approved');
      expect(r.reason, `"${String(v)}" produced no explanation`).toBeTruthy();
    }
  });

  it('a missing verdict object is not an approval', () => {
    for (const v of [null, undefined, {}]) {
      expect(classifyReviewVerdict(v as any).outcome).not.toBe('approved');
    }
  });

  it('THE ANTI-DRIFT CHECK: every verdict the template declares is handled', () => {
    // Read the vocabulary out of the prompt the reviewer is actually given. Anything it is told to
    // emit that this gate does not recognise is the original defect, returning.
    const declared = [...new Set(
      (JSON.stringify(JSON.parse(readFileSync(TEMPLATE, 'utf8')))
        .match(/\b(sound|defects_found|nothing_to_review)\b/g) || []),
    )];
    expect(declared.length, 'no verdict vocabulary found in the template — this proves nothing')
      .toBeGreaterThan(0);
    for (const v of declared) {
      const r = classifyReviewVerdict({ verdict: v, findings: [] });
      expect(r.outcome, `the reviewer is told it may answer "${v}" and the gate does not handle it`)
        .not.toBe('unrecognised');
    }
  });
});

/**
 * THE VOCABULARY THAT MATTERS IS THE CALLER'S.
 *
 * I read the gate (approved) and the captured model output (sound), concluded the gate expected a
 * word nothing produces, and rewrote it to accept the MODEL's words. But the gate is not handed the
 * model's verdict — reviewProjectRoster aggregates the batches and returns its OWN: approved,
 * changes_requested, review_failed. My change made the gate recognise none of them, so a clean
 * review came back approved, fell to the unrecognised branch, and the mint failed three attempts
 * running. Live 2026-09-01, a killed run.
 *
 * These assertions are taken from the RETURN STATEMENTS of reviewProjectRoster, so the gate is held
 * to what its caller actually sends rather than to what a transcript happens to show.
 */
describe('the gate handles the vocabulary its CALLER returns', () => {
  const RUNNER = readFileSync(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('every verdict reviewProjectRoster can return is handled', () => {
    // Read them out of the function rather than listing them here, so a new return value that
    // nothing downstream understands fails this test the day it is added.
    const start = RUNNER.indexOf('async function reviewProjectRoster({');
    expect(start, 'reviewProjectRoster is missing').toBeGreaterThan(-1);
    const body = RUNNER.slice(start, start + 20000);
    const emitted = [...new Set(
      [...body.matchAll(/verdict:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]),
    )];
    expect(emitted.length, 'no verdicts parsed from the caller — this proves nothing')
      .toBeGreaterThan(1);
    for (const v of emitted) {
      expect(classifyReviewVerdict({ verdict: v, findings: [] }).outcome,
        `reviewProjectRoster can return '${v}' and the gate does not recognise it`)
        .not.toBe('unrecognised');
    }
  });

  it('THE REGRESSION: approved is an approval', () => {
    expect(classifyReviewVerdict({ verdict: 'approved', findings: [] }).outcome).toBe('approved');
  });

  it('changes_requested is a rejection that carries its reason', () => {
    const r = classifyReviewVerdict({
      verdict: 'changes_requested',
      reason: 'agent-x: the brief names a path that does not exist',
      findings: [{ agent: 'agent-x', severity: 'blocking', claim: 'bad path' }],
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason, 'the next attempt is told nothing to fix').toMatch(/does not exist|bad path/);
  });
});
