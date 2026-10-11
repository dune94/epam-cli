/**
 * THE REVIEWER'S TEST RUNS ARE BOUNDED.
 *
 * AMSD-2974 run 9 (2026-10-11): the team-lead reviewer ran the codeline's whole jest suite itself, as a tool command —
 * 15 workers (one per core), ~4.1 GB, the run scope pinned at its memory throttle with 99% pressure, review calls of
 * 30–100 minutes. The pipeline's own test runs were already bounded (lib/bounded-exec.sh: CPU affinity derived from the
 * tightest cgroup memory limit — the stack-neutral lever every runner sizes its pool from), but the reviewer's agent
 * call was not, so nothing it launched was.
 *
 * EXECUTED: the reviewer's real agent-call block, lifted from team-lead-review.sh, with invoke_agent standing in for the
 * model as a child process that reports the parallelism it was given (os.availableParallelism(), which jest's
 * getMaxWorkers and vitest read). The bound comes from the real resolve_test_workers, held constant by its override.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';

const S = join(__dirname, '../../../orchestrations/scripts');
const SRC = readFileSync(join(S, 'team-lead-review.sh'), 'utf8');

/** The `_review_out=$( … invoke_agent … )` assignment as the reviewer has it. */
function agentCall(): string {
  const start = SRC.indexOf('    _review_out=$(');
  const end = SRC.indexOf('        2>&1)', start);
  if (start < 0 || end < 0) throw new Error('the reviewer\'s agent call was not found — the harness is stale');
  return SRC.slice(start, end + '        2>&1)'.length);
}

const affinityWorks = spawnSync('taskset', ['-c', '0', 'true']).status === 0;

function seenParallelism(availMb: string): number {
  const script = [
    'set -uo pipefail',
    `SCRIPT_DIR=${JSON.stringify(S)}`,
    '. "$SCRIPT_DIR/lib/bounded-exec.sh"',
    // The model, standing in: a child process reporting the parallelism a test runner would size its pool from.
    `invoke_agent(){ cat >/dev/null; ${JSON.stringify(process.execPath)} -e 'process.stdout.write(String(require("os").availableParallelism()))'; }`,
    'prompt_text=x; _model=m; _provider=p; _review_json_result=/dev/null; PROJECT_ROOT=/tmp',
    agentCall(),
    'printf "SEEN=%s\\n" "$_review_out"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', EPAM_TEST_AVAIL_MB_OVERRIDE: availMb },
  });
  const m = `${r.stdout}${r.stderr}`.match(/SEEN=(\d+)/);
  if (!m) throw new Error(`the agent call did not report: ${r.stdout}${r.stderr}`);
  return Number(m[1]);
}

describe.skipIf(!affinityWorks)('the reviewer cannot take every core for its test runs', () => {
  it('GUARD: this host has more cores than the bound below — otherwise the test proves nothing', () => {
    expect(cpus().length).toBeGreaterThan(2);
  });

  it('a tight memory budget gives the reviewer\'s tools one core', () => {
    // 1000 MB available → 60% budget / 700 MB per worker → 0 → floor 1 (resolve_test_workers).
    expect(seenParallelism('1000')).toBe(1);
  });

  it('a larger budget gives more, still derived — never the whole machine', () => {
    // 2400 MB → 1440 / 700 → 2 workers.
    expect(seenParallelism('2400')).toBe(2);
  });
});
