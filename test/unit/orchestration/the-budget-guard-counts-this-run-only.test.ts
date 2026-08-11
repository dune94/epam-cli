/**
 * THE $15 BUDGET GUARD WAS CHARGING THIS RUN FOR EVERY PREVIOUS RUN'S ATTEMPTS.
 *
 * claude.sh sums `task_cost_usd` from phase-cost.jsonl `select(.story_id == $id)` — with no run
 * filter. phase-cost.jsonl is APPENDED across runs and is not reset by pre-run-reset, so a
 * ticket retried over several days accumulates forever. Measured 2026-08-10, before this fix:
 *
 *     gotransit  guard sees $5.46  from 29 records, oldest 2026-08-04
 *     upexpress  guard sees $3.69  from 31 records
 *     metrolinx  guard sees $11.20 from 34 records   <- already 75% of a $15 limit, at run start
 *
 * So the guard was wrong in both directions at once, which is why neither error ever surfaced:
 * it OVER-counted history (a story that had been retried for days started near its ceiling and
 * would abort a healthy run) while UNDER-counting the present (killed attempts recorded no cost
 * at all — see a-killed-attempt-still-reports-what-it-spent.test.ts). The two errors pointed
 * opposite ways and the number looked plausible throughout.
 *
 * A limit that counts spend the operator never authorised for this run is not a limit.
 *
 * Records are now stamped with ORCH_RUN_ID at both writers (the normal cost record and the
 * watchdog's timeout record). Records written before stamping carry no run_id and are excluded,
 * which is exactly right — they belong to runs already paid for.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Runs claude.sh's REAL summation expression over a cost file. */
function sum(records: Record<string, unknown>[], runId: string, storyId = 'AMSD-2041'): number {
  const start = SRC.indexOf('_story_cost_so_far=$(jq -s --arg id');
  expect(start, 'the budget summation moved — re-anchor this test').toBeGreaterThan(-1);
  const block = SRC.slice(start, SRC.indexOf('|| echo 0)', start) + '|| echo 0)'.length);
  const dir = mkdtempSync(join(tmpdir(), 'budget-')); dirs.push(dir);
  const f = join(dir, 'phase-cost.jsonl');
  writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = execFileSync('bash', ['-c',
    `set -u
     _cost_file=${JSON.stringify(f)}
     story_id=${JSON.stringify(storyId)}
     export ORCH_RUN_ID=${JSON.stringify(runId)}
     _budget() {\n${block}\n printf '%s' "$_story_cost_so_far"\n }
     _budget`], { encoding: 'utf8' });
  return Number(out.trim());
}

const rec = (cost: number, runId?: string, storyId = 'AMSD-2041') => ({
  story_id: storyId, task_cost_usd: cost, ...(runId ? { run_id: runId } : {}),
});

const THIS_RUN = '20260810T024709Z';
const OLD_RUN = '20260804T191132Z';

describe('THE DEFECT: only this run counts', () => {
  it('a previous run\'s spend on the same story is excluded', () => {
    expect(
      sum([rec(11.20, OLD_RUN), rec(0.68, THIS_RUN)], THIS_RUN),
      'metrolinx started at $11.20 of someone else\'s spend against a $15 limit',
    ).toBeCloseTo(0.68, 5);
  });

  it('this run\'s own attempts still accumulate across the run', () => {
    expect(sum([rec(0.61, THIS_RUN), rec(0.68, THIS_RUN), rec(0.73, THIS_RUN)], THIS_RUN))
      .toBeCloseTo(2.02, 5);
  });

  it('unstamped legacy records are excluded, not silently counted', () => {
    // Everything written before run stamping. Those runs are already paid for.
    expect(sum([rec(5.46), rec(3.69), rec(0.44, THIS_RUN)], THIS_RUN)).toBeCloseTo(0.44, 5);
  });

  it('another story in the same run does not leak in', () => {
    expect(sum([rec(9.99, THIS_RUN, 'OTHER-1'), rec(0.5, THIS_RUN)], THIS_RUN)).toBeCloseTo(0.5, 5);
  });

  it('a killed attempt in THIS run does count — it spent real money', () => {
    const killed = { story_id: 'AMSD-2041', run_id: THIS_RUN, status: 'timeout', task_cost_usd: 0.813 };
    expect(sum([killed, rec(0.68, THIS_RUN)], THIS_RUN)).toBeCloseTo(1.493, 5);
  });

  it('the real historical file shape is handled — the records that caused this', () => {
    // Exactly the pre-fix situation: days of unstamped history plus one stamped attempt.
    const history = Array.from({ length: 34 }, () => rec(0.33));
    expect(sum([...history, rec(0.68, THIS_RUN)], THIS_RUN)).toBeCloseTo(0.68, 5);
  });
});

describe('a run with no id degrades to the old behaviour rather than counting nothing', () => {
  it('an unset ORCH_RUN_ID sums everything for the story', () => {
    // Counting zero would silently disable the limit, which is worse than over-counting.
    expect(sum([rec(1.0, OLD_RUN), rec(2.0, THIS_RUN), rec(0.5)], '')).toBeCloseTo(3.5, 5);
  });
});

describe('both writers stamp the record, or the filter excludes real spend', () => {
  it('the normal cost record carries run_id', () => {
    expect(SRC).toMatch(/run_id:\$rid/);
    expect(SRC).toMatch(/--arg rid "\$\{ORCH_RUN_ID:-\}"/);
  });

  it('the watchdog timeout record carries run_id too', () => {
    // Missed here, every killed attempt would be filtered out — reintroducing the exact
    // blindness that made the guard useless in the first place.
    const orch = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const i = orch.indexOf('--arg s   "timeout"');
    expect(i).toBeGreaterThan(-1);
    expect(orch.slice(i, i + 500)).toMatch(/run_id:\$rid/);
  });
});
