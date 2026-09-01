/**
 * A GATE MUST HANDLE EVERY VALUE ITS PRODUCER'S SCHEMA PERMITS.
 *
 * A gate is brittle in exactly one way: it handles fewer values than its producer can emit. It
 * looks correct in review, passes its unit tests on the values the author had in mind, and fails
 * the first time the model returns another legal one — mid-run, after the money is spent.
 *
 * This is not hypothetical and it is not rare. It is the same defect three times in one week:
 *
 *   The roster review agent is bound to enum ['sound','defects_found','nothing_to_review'] at
 *   spec-mode-runner.js:4242. The API enforces it, so those three are the complete set of things
 *   that can come back. reviewProjectRoster translates them to 'approved'. The gate matched on
 *   'approved' only; I read a transcript, saw 'sound', and rewrote the gate to match THAT instead —
 *   swapping which half of the vocabulary was unhandled. Runs died both ways.
 *
 *   Every seam declared a ladder tier of base/mid/top. Every provider set defines
 *   medium/high/highest. Forty seams resolved no model.
 *
 * THE AUTHORITY IS THE SCHEMA, NEVER A TRANSCRIPT AND NEVER THE PROSE. The enum is what the
 * provider enforces on the reply. A gate that handles it completely cannot be surprised by a legal
 * answer; a gate handling anything less is counting on the model's habits.
 *
 * TWO DIRECTIONS, BOTH REQUIRED:
 *
 *   COMPLETE — every enum member reaches a real outcome, never 'unrecognised'.
 *   DISCRIMINATING — the members do not all collapse to the same outcome. A classifier answering
 *   'approved' to everything is complete and useless, and would pass the first check alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');
const ROSTER = join(REPO, 'orchestrations/scripts/lib/project-roster.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyReviewVerdict } = require(ROSTER);
const src = readFileSync(RUNNER, 'utf8').split('\n');

/**
 * Every enum the schemas bind to a verdict-shaped field, read from the schema itself.
 *
 * Discovered rather than listed: a new verdict enum added tomorrow appears here with no edit, and
 * the coverage assertion below then demands a consumer for it.
 */
function verdictEnums(): Array<{ line: number; values: string[] }> {
  const out: Array<{ line: number; values: string[] }> = [];
  src.forEach((l, i) => {
    const m = l.match(/enum:\s*\[([^\]]+)\]/);
    if (!m) return;
    const context = src.slice(Math.max(0, i - 3), i + 1).join(' ');
    if (!/verdict/i.test(context)) return;
    const values = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (values.length) out.push({ line: i + 1, values });
  });
  return out;
}

/** The roster reviewer's own enum — located by content, so a line move does not break this. */
function rosterEnum(): string[] {
  const hit = verdictEnums().find((e) => e.values.includes('defects_found'));
  return hit ? hit.values : [];
}

describe('a gate handles every value its schema permits', () => {
  it('the schemas are readable and bind at least one verdict enum', () => {
    // Non-vacuity. If the discovery returns nothing, every assertion below passes on an empty set —
    // which is how the ladder-tier defect survived a green suite.
    expect(verdictEnums().length, 'no verdict-bearing enum found; the checks below prove nothing')
      .toBeGreaterThan(0);
    expect(rosterEnum(), 'the roster review enum was not located by content')
      .toContain('defects_found');
  });

  it('COMPLETE: every verdict the roster schema permits reaches a real outcome', () => {
    const unhandled = rosterEnum()
      .map((v) => ({ v, outcome: classifyReviewVerdict({ verdict: v, findings: [] }).outcome }))
      .filter((r) => r.outcome === 'unrecognised' || !r.outcome);
    expect(unhandled, 'the API permits these verdicts and the gate does not recognise them: '
      + unhandled.map((u) => u.v).join(', ')).toEqual([]);
  });

  it('COMPLETE: and the translated vocabulary the gate is actually handed', () => {
    // reviewProjectRoster does not pass the agent's word through; it returns its own. Both layers
    // are real, and reading only one of them is precisely how I broke this gate twice.
    for (const v of ['approved', 'changes_requested', 'review_failed', 'nothing_to_review']) {
      expect(classifyReviewVerdict({ verdict: v, findings: [] }).outcome,
        `the gate does not recognise '${v}', which reviewProjectRoster returns`)
        .not.toBe('unrecognised');
    }
  });

  it('DISCRIMINATING: the verdicts do not all collapse to one outcome', () => {
    // A classifier that approves everything satisfies COMPLETE perfectly and gates nothing.
    const outcomes = new Set([
      classifyReviewVerdict({ verdict: 'approved', findings: [] }).outcome,
      classifyReviewVerdict({ verdict: 'changes_requested', findings: [] }).outcome,
      classifyReviewVerdict({ verdict: 'review_failed', findings: [] }).outcome,
    ]);
    expect(outcomes.size, 'every verdict maps to the same outcome — the gate does not discriminate')
      .toBeGreaterThan(1);
  });

  it('SEVERITY DECIDES, NOT THE WORD: defects_found is advisory unless something blocks', () => {
    // The live case on 2026-09-01: "defects_found — 1 finding(s), 0 blocking". Treating the word as
    // a rejection discards a sound roster over an advisory note, which killed a run at 37 minutes.
    const advisory = classifyReviewVerdict({
      verdict: 'defects_found',
      findings: [{ severity: 'advisory', detail: 'a note' }],
    });
    const blocking = classifyReviewVerdict({
      verdict: 'defects_found',
      findings: [{ severity: 'blocking', detail: 'a real defect' }],
    });
    expect(advisory.outcome, 'an advisory-only finding rejected the roster').toBe('approved');
    expect(blocking.outcome, 'a BLOCKING finding was approved — the gate is inert')
      .not.toBe('approved');
  });

  it('AN UNKNOWN VERDICT IS NOT A PASS', () => {
    // The other failure direction. A value outside the enum means the reply did not come back in
    // the shape the schema demands, and "I do not understand this" must never read as approval.
    for (const junk of ['warn', '', 'APPROVED_MAYBE', 'ok']) {
      expect(classifyReviewVerdict({ verdict: junk, findings: [] }).outcome,
        `'${junk}' was treated as an approval`).not.toBe('approved');
    }
  });
});
