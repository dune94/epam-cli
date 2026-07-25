/**
 * B26 — the reviewer gated on `completed`, a HUMAN-owned field.
 *
 * `if [ "$STORY_COMPLETED" != "true" ]; then warning "Story not completed, skipping
 * review"; continue; fi`
 *
 * `completed` is set by a HUMAN marking the story done — it is not a pipeline
 * readiness signal, and the reviewer must not consume it as one. The reviewer's job
 * is to review the CODE and the TEST.
 *
 * Live consequence (metrolinx 21:25 run): the repro-gate resets story status before
 * Step 3.6, so the story reached review as status=pending / completed=false while
 * the branch held two real commits — the 3-line fix and a 125-line reproducing test
 * that the gate had independently verified (fails on baseline, passes with the fix).
 * The reviewer skipped it, reviewed ZERO stories, and returned "approved".
 *
 * Two defects in one:
 *   1. WRONG SIGNAL — gating code review on human bookkeeping that another gate
 *      mutates. Review should key on whether the story CHANGED anything.
 *   2. FAIL-OPEN — reviewing zero stories returned approved. A change nobody looked
 *      at reported as reviewed. Same class as the gates fixed earlier that day; only
 *      the escalation flag caught it, and it caught it as the WRONG diagnosis
 *      ("review requested changes"), costing two empty re-implementation cycles.
 *
 * Three of my own mechanism claims about this failure were wrong before I read the
 * guard: reviewer thrash at 20 iterations (stale log), an iteration budget too low
 * (agent never ran), and death in prompt construction under set -e (an explicit
 * guard, not a crash).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');
const CODE = RAW.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('B26 — review keys on CHANGES, not on human bookkeeping', () => {
  it('does not skip a story merely because completed != true', () => {
    expect(CODE).not.toMatch(/if \[ "\$STORY_COMPLETED" != "true" \]/);
  });

  it('decides from the story diff vs baseline instead', () => {
    expect(CODE).toMatch(/_story_changed|_has_changes|diff --name-only/);
  });

  it('reviews the TEST as well as the fix', () => {
    // Both are the story's output; the reviewer must see both.
    expect(RAW).toMatch(/\.(spec|test)\.|test file|reproducing test/i);
  });
});

describe('B26 — reviewing nothing must never read as approved', () => {
  it('zero reviewed stories does not return approved', () => {
    expect(CODE).toMatch(/_reviewed_count|_stories_reviewed|reviewed=0|no stories were reviewed/i);
  });

  it('says so loudly rather than defaulting silently', () => {
    expect(RAW).toMatch(/reviewed NO stories|no stories were reviewed|nothing was reviewed/i);
  });

  it('the existing never-auto-approve fail-safe still stands', () => {
    expect(CODE).toMatch(/changes_requested/);
    expect(CODE).toMatch(/reviewIncomplete/);
  });
});
