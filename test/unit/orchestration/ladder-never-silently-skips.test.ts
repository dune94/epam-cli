/**
 * B31 — a ladder that does not escalate must say why.
 *
 * Every ladder lookup in the pipeline resolves EPAM_MODEL_LADDER_HIGH/MEDIUM
 * ("from=to|from=to") and returns the empty string when it finds no successor.
 * The problem is that empty collapses three completely different situations into
 * one indistinguishable outcome:
 *
 *   1. The model is at the TOP of the ladder — legitimate, nothing to do.
 *   2. The model is not ON the ladder at all — a misconfiguration; the model was
 *      renamed or the map was never updated, so escalation silently never happens.
 *   3. The ladder variable is empty/unset — the run has NO escalation whatsoever.
 *
 * Every call site is `if [ -n "$_next" ]; then ...escalate... fi` with no else
 * branch, so cases 2 and 3 produce no log line at all. A run that never escalated
 * because of a typo in a model name looks exactly like a run that correctly
 * stopped at the ceiling. That is the same failure shape as the self-heal analyst
 * (B30) and the kill script (B32): a mechanism that reports nothing when it does
 * nothing, so its absence is invisible.
 *
 * This matters most in exactly the case you need it: the retry ladder is what
 * rescues a failing story, and "the ladder didn't help" is a very different
 * diagnosis from "the ladder never ran".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../orchestrations/scripts/');

/** Every site that resolves a ladder successor and acts on it. */
const LADDER_SITES = [
  { file: 'lib/tc-writer-gate.sh', call: '_tc_ladder_next_model "$_tc_model"' },
  // brownfield-repro-test-writer.sh moved to the shared handler and its private chain walker
  // was deleted; the "why didn't it escalate" reporting it must still do now comes from
  // agent_ladder_exhausted. The requirement is unchanged — a ladder that does not escalate says
  // WHY — only the function providing the answer moved.
  { file: 'brownfield-repro-test-writer.sh', call: 'agent_ladder_exhausted' },
  { file: 'team-lead-review.sh', call: '_ladder_next_model "$_base_model"' },
];

describe('B31 — no ladder site skips escalation silently', () => {
  for (const { file, call } of LADDER_SITES) {
    it(`${file} logs when it does not escalate`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const lines = src.split('\n');
      const i = lines.findIndex(l => l.includes(call) && !l.trim().startsWith('#'));
      expect(i, `ladder call site not found in ${file}`).toBeGreaterThan(-1);

      // The escalation branch plus whatever handles "no successor".
      const window = lines.slice(i, i + 14).join('\n');
      // Intent, not syntax: the no-successor path must SAY something. An else
      // branch and a `[ -z "$next" ] && warning ...` guard are equally fine.
      expect(window,
        `${file} takes the no-escalation path without logging — a model that is ` +
        `not on the ladder, or an unset ladder, produces no log line and is ` +
        `indistinguishable from correctly sitting at the ceiling`)
        .toMatch(/_ladder_skip_reason|NO ladder|no ladder|not escalat/i);
    });
  }

  it('distinguishes "at the top" from "not on the ladder"', () => {
    // At least one site must actually name the misconfiguration case, otherwise
    // the else branch is just a nicer way of saying nothing.
    const all = LADDER_SITES.map(s => readFileSync(join(ROOT, s.file), 'utf8')).join('\n');
    expect(all,
      'no site reports a model missing from the ladder map — a renamed model ' +
      'silently disables escalation for the whole run')
      .toMatch(/not on the ladder|not configured|no ladder|missing from the ladder/i);
  });
});
