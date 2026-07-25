/**
 * B27 — the reviewer died silently whenever its KB was empty.
 *
 * team-lead-review.sh ends the REVIEW_PROMPT assignment with:
 *
 *     $([ -n "$_review_kb" ] && printf '\nLEARNED REVIEW RULES...' "$_review_kb")
 *
 * Under `set -euo pipefail`, when _review_kb is EMPTY the `[ -n "" ]` test returns
 * 1, so the command substitution returns 1, so the ASSIGNMENT returns 1, and set -e
 * kills the script — right before `Invoking review-agent`. Because it is the LAST
 * substitution in the assignment, its status becomes the assignment's status.
 *
 * pre-run-reset.sh clears the KB scratchpad before every run (deliberately — stale
 * diagnoses contaminate future attempts). So the reviewer died on EVERY run that did
 * not inherit a KB from a previous one.
 *
 * Live signature (metrolinx, three runs): "Reviewing story: AMSD-1820" printed,
 * "Invoking review-agent" never did, no review-agent log was written, no thrash
 * message appeared, and the caller read the non-zero exit as "changes requested" —
 * burning two re-implementation cycles on a story whose fix and gate-verified
 * reproducing test were already correct.
 *
 * Four mechanism claims were wrong before this was read from the code: reviewer
 * thrash at 20 iterations (stale log), iteration budget too low (agent never ran),
 * death in prompt construction generally (right region, wrong cause), and a
 * `git diff | head -1` SIGPIPE — which was a REAL bug, but one I had just
 * introduced while hunting this one. Same defect class both times: a non-zero exit
 * inside an assignment under set -e.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const RAW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');

/** Does a bash snippet survive under set -euo pipefail? */
function survives(snippet: string): boolean {
  try {
    execFileSync('bash', ['-c', `set -euo pipefail\n${snippet}\necho OK`],
      { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch { return false; }
}

describe('B27 — an empty KB must not kill the reviewer', () => {
  it('the KB substitution cannot return non-zero', () => {
    // Every `[ -n ... ] && printf` inside a prompt assignment needs a || true tail.
    // Line-based: the printf format contains its own parentheses ("(from prior
    // runs ...)"), so a [^)]* regex stops early and never sees the guard at the end.
    const line = RAW.split('\n').find(l => l.includes('$([ -n "$_review_kb" ]'));
    expect(line, 'KB substitution not found').toBeTruthy();
    expect(line!, 'must not be able to return non-zero').toMatch(/\|\| *(true|:)\)\s*$/);
  });

  it('PROOF: the old form aborts under set -e, the new form does not', () => {
    const oldForm = `_kb=""\nX="p\n$([ -n "$_kb" ] && printf 'R:%s' "$_kb")"`;
    const newForm = `_kb=""\nX="p\n$([ -n "$_kb" ] && printf 'R:%s' "$_kb" || true)"`;
    expect(survives(oldForm), 'old form should abort').toBe(false);
    expect(survives(newForm), 'new form must survive').toBe(true);
  });

  it('no OTHER prompt substitution can abort the same way', () => {
    // Any `$( [ ... ] && ... )` with no || tail is the same latent bug.
    const risky = RAW.split('\n')
      .filter(l => /\$\(\[ -n "\$[A-Za-z_]+" \] &&/.test(l))
      .filter(l => !/\|\| *(true|:)\)\s*$/.test(l))
      .map(l => l.slice(0, 60));
    expect(risky, 'unguarded conditional substitutions remain').toEqual([]);
  });

  it('the diff check added during this investigation is also safe', () => {
    // `git diff | head -1` under pipefail: head closes the pipe, git takes SIGPIPE,
    // the assignment returns non-zero, set -e kills it. Same class.
    const m = RAW.match(/_story_changed=\$\([^)]*\)/);
    expect(m).toBeTruthy();
    expect(m![0]).not.toMatch(/\|\s*head/);
    expect(m![0]).toMatch(/\|\| *true/);
  });
});
