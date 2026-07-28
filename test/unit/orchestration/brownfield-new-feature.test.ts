/**
 * Brownfield is not only defects. A small NEW FEATURE must be able to run.
 *
 * Live AMSD-2041 ("[GO, UP, MX] Live Preview of Content in CMS"), 2026-07-28.
 * The spec pass succeeded — three grounded codelines, a grounded detective
 * answer after one escalation, 7 verification criteria — and then:
 *
 *   ⚠ No relevant KB sources for CMS, live preview, or content management
 *   ⚠ Target files don't exist; no integration context available
 *   ⚠ Story references GO, UP, MX — unclear if separate sub-tasks or markets
 *   [CPA ERR] 1 story/stories in BLOCK gate
 *   [orch] Phase 'core' for 'gotransit' failed (exit 3)
 *
 * The gate was right to stop, and wrong about why. `storyKind` and `issueType`
 * appear ZERO times in contextualize-stories.sh: CPA gates purely on confidence
 * (`conf < 0.35 -> block`), and confidence was low BECAUSE the target files do
 * not exist. For a defect that is correct — a bug must live in existing code, so
 * a missing target is a genuine red flag. For a new feature it is backwards: the
 * absence of the target is the EXPECTED state, and the story is being penalised
 * for being what it is.
 *
 * The pipeline already knows the difference. The archaeology block classifies
 * `storyKind` as "defect" or "novel", anchored to the Jira issue type, and
 * already asks for `locationHint` "for both kinds". What it does NOT do is ask a
 * kind-appropriate question — the schema says "why this is the fix site", which
 * is meaningless for work that has no fix site — or let CPA see the answer.
 *
 * So:
 *   A. CPA becomes story-kind aware. A missing target stops driving a novel
 *      story to BLOCK; what must exist instead is an ATTACHMENT POINT.
 *   B. The detective asks the right question per kind: "where is the bug?" for a
 *      defect, "where does this attach and what already exists to reuse?" for a
 *      feature.
 *   C. The RED->GREEN gate needs no new machinery — a test for new behaviour
 *      that fails before and passes after is the same mechanism, so this only
 *      verifies the framing does not exclude features.
 *
 * A missing attachment point still BLOCKS (user decision, 2026-07-28): if the
 * detective cannot find where a feature plugs in, that is the same quality of
 * signal as a missing fix site for a defect, and the honest place to stop.
 *
 * "Smallest change possible" is unchanged and still enforced by the reviewer —
 * for a feature it means reuse what exists and add the minimum new surface.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CPA = readFileSync(join(ROOT, 'orchestrations/scripts/contextualize-stories.sh'), 'utf8');
const SPEC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');

/** The brownfield archaeology block the spec agent receives. */
function archaeology(): string {
  const i = SPEC.indexOf('function buildBrownfieldArchaeologyBlock');
  const j = SPEC.indexOf('\nfunction ', i + 1);
  return SPEC.slice(i, j > i ? j : i + 6000);
}

// ── A. CPA knows what kind of story it is judging ────────────────────────────

describe('A. the estimate gate distinguishes a feature from a defect', () => {
  it('reads the story kind at all', () => {
    // It read neither storyKind nor issueType, so every story was judged by the
    // same rule — the one written for defects.
    expect(CPA, 'CPA cannot tell a new feature from a bug')
      .toMatch(/storyKind|issueType/);
  });

  it('does not block a feature merely because its target does not exist', () => {
    const i = CPA.search(/storyKind|issueType/);
    expect(i, 'no story-kind handling exists').toBeGreaterThan(-1);
    expect(CPA, 'nothing distinguishes the novel case in the gate decision')
      .toMatch(/novel/i);
  });

  it('still blocks a feature with no attachment point', () => {
    // The user's decision: a feature nobody can place is as unimplementable as a
    // defect nobody can locate. Absence of a fix site and absence of an
    // attachment point are the same signal.
    expect(CPA, 'a feature with nowhere to attach would pass the gate')
      .toMatch(/attachment|locationHint|integration point/i);
  });

  it('leaves the defect rule intact — a missing fix site still blocks', () => {
    // Relaxing the gate for everything would discard the signal that makes it
    // worth having.
    expect(CPA, 'the defect path lost its missing-target block')
      .toMatch(/defect/i);
  });
});

// ── B. The detective asks a question the story can answer ────────────────────

describe('B. the detective asks what a feature actually needs', () => {
  it('no longer calls every location a "fix site"', () => {
    // A feature has no fix site. Asking for one invites the model to invent a
    // plausible file — which is exactly what it did on attempt 1 of this run,
    // quoting code that was not in the file it named.
    const schemaLine = archaeology().slice(archaeology().indexOf('schemaLine'));
    expect(schemaLine, 'the schema still asks only for a fix site')
      .toMatch(/attach|integrat|why this location/i);
  });

  it('asks for the attachment point when the story is novel', () => {
    expect(archaeology(), 'a novel story is still asked to locate a bug')
      .toMatch(/attach|integrat/i);
  });

  it('asks what already exists to reuse', () => {
    // This is what keeps "smallest change" meaningful for a feature: you cannot
    // reuse what you have not found.
    expect(archaeology(), 'nothing directs a feature toward existing code to reuse')
      .toMatch(/reuse|already exists|existing (helper|pattern|component)/i);
  });

  it('still asks a defect for the causal fix site', () => {
    expect(archaeology(), 'the defect framing was lost').toMatch(/defect/i);
  });
});

// ── C. RED->GREEN already generalises; verify it is not defect-only ──────────

describe('C. the proof-by-execution gate is not defect-only', () => {
  it('the repro-test writer is reachable for a novel story', () => {
    // For a defect: fails on baseline, passes with the fix. For a feature: the
    // same, on new behaviour. Same machinery — this asserts nothing gates it
    // behind storyKind === "defect".
    const writer = readFileSync(
      join(ROOT, 'orchestrations/scripts/brownfield-repro-test-writer.sh'), 'utf8');
    const defectOnlyGuard = /storyKind[^\n]*!=[^\n]*defect[^\n]*(exit|return|skip)/i.test(writer);
    expect(defectOnlyGuard,
      'the RED->GREEN gate is skipped for anything that is not a defect, so a ' +
      'feature ships with no executable proof')
      .toBe(false);
  });
});
