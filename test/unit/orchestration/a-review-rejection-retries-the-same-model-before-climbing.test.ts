/**
 * A REVIEW REJECTION RETRIES THE SAME MODEL BEFORE CLIMBING.
 *
 * AMSD-2974 run 9 (2026-10-10 13:44Z): the writer's FIRST attempt, on Sonnet 5, was rejected by the review and the
 * very next attempt ran on Opus 5.5 — a review rejection jumped a whole rung ((rung + 1) * 2), so the second attempt
 * each rung allows was never used after a review, and the run never came back down. Operator, 2026-10-11 ("Option 2"):
 * a rejection is retried on the same model, with the requirements self-heal derived from it, before the ladder climbs.
 *
 * EXECUTED: the function lib/review-cycle.sh calls when it sends a rejected story back to the writer (read from its
 * re-implementation loop), from lib/story-retry-state.sh, on a real retry-state directory; the rung each next attempt
 * runs on is the real story_ladder_rung. And the review loop's cycle bound must let the ladder run out before it cuts.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const RC = readFileSync(join(S, 'lib/review-cycle.sh'), 'utf8');

/** The retry-advance function the review loop calls for a rejected story, as wired today. */
const ADVANCE = (() => {
  const loop = RC.slice(RC.indexOf('for _entry in "${_review_climbable_stories[@]}"; do'));
  const m = loop.match(/\b(advance_story_retry_\w+)\s+"\$LOG_DIR"/);
  if (!m) throw new Error('the review loop no longer advances the story — the harness is stale');
  return m[1];
})();

function rungsAfterRejections(n: number, max = 7): number[] {
  const d = mkdtempSync(join(tmpdir(), 'review-climb-'));
  const r = spawnSync('bash', ['-c', [
    'set -uo pipefail', `. "${S}/lib/story-retry-state.sh"`,
    `for _ in $(seq 1 ${n}); do ${ADVANCE} "${d}" S-1 ${max}; story_ladder_rung "$(read_story_retry_count "${d}" S-1)"; done`,
  ].join('\n')], { encoding: 'utf8' });
  const rungs = r.stdout.trim().split('\n').filter(Boolean).map(Number);
  if (rungs.length !== n) throw new Error(`no rung reported: ${r.stdout}${r.stderr}`);
  return rungs;
}

describe('a review rejection retries the same model before climbing', () => {
  it('the first rejection on rung 0 is retried on rung 0; the second climbs', () => {
    expect(rungsAfterRejections(3)).toEqual([0, 1, 1]);
  });

  it('the ladder still reaches its top rung, and stops there', () => {
    const r = rungsAfterRejections(9);
    expect(r[r.length - 1]).toBe(3);
    expect(Math.max(...r)).toBe(3);
  });

  it('the review loop allows enough cycles for the ladder to run out before its safety valve cuts', () => {
    const m = RC.match(/_review_max_cycles="\$\{REVIEW_MAX_CYCLES:-\$\(\( (.+?) \)\)\}"/);
    expect(m, 'the cycle bound was not found').toBeTruthy();
    const max = 7;
    const cycles = Number(spawnSync('bash', ['-c', `_review_max_retries=${max}; echo $(( ${m![1]} ))`], { encoding: 'utf8' }).stdout);
    const toExhaust = rungsAfterRejections(12, max).findIndex((x) => x >= 3) + 1;
    expect(cycles).toBeGreaterThan(toExhaust);
  });
});
