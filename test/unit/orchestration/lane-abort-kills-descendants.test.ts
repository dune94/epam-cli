/**
 * Aborting a lane must stop the work, not just the shell that launched it.
 *
 * Live AMSD-2041 2026-07-30. `gotransit` failed at 21:16. The halt rule fired
 * and did what it says:
 *
 *   HALT: a codeline failed after its retries and self-heal completed.
 *     Aborting the codeline(s) still running — recovery is exhausted, so
 *     letting them finish would spend on a run already decided.
 *
 * It then ran `kill "$_pid"` over the lane subshell PIDs. Each lane subshell has
 * a descendant doing the actual work — `bash "$0"` re-executing the
 * orchestration, which in turn runs node LLM calls. Killing the subshell orphans
 * them; it does not stop them.
 *
 * So `metrolinx` kept running for another ten minutes, spending on a run that
 * had already been decided — the exact outcome the halt exists to prevent. It
 * finally died not from the abort but by tripping over a file the parent's
 * cleanup had already deleted:
 *
 *   [ERROR] PRD file not found at /tmp/orch-metrolinx-prd-3294358.json
 *
 * which is why the abort looked like a crash instead of a halt.
 *
 * THE RULE (see also: no silent failure mechanisms): a kill that does not stop
 * the process is a no-op that reports success. Descendants are killed first, so
 * nothing is orphaned into a parentless state where it keeps working and keeps
 * billing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in run-agent-orchestration.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * Build the live shape: a lane subshell whose GRANDCHILD is the thing doing the
 * work. Kill the lane the way the abort does, then check what is still alive.
 *
 * The grandchild writes a marker file every 200ms, so "still running" is
 * observed rather than inferred from a PID that may have been recycled.
 */
function abortLane(killer: string) {
  const d = mkdtempSync(join(tmpdir(), 'abort-'));
  dirs.push(d);
  const beat = join(d, 'beat.txt');
  const lanePid = join(d, 'lane.pid');
  const grandPid = join(d, 'grand.pid');

  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
${fnText('_kill_lane_tree') || ''}
# The lane: a subshell that backgrounds the real worker, exactly as the parallel
# branch does (worker = the re-executed orchestration + its node calls).
(
  (
    echo $BASHPID > ${JSON.stringify(grandPid)}
    while :; do echo tick >> ${JSON.stringify(beat)}; sleep 0.2; done
  ) &
  wait
) &
_pid=$!
echo "$_pid" > ${JSON.stringify(lanePid)}
# Let the grandchild come up and start beating.
while [ ! -s ${JSON.stringify(grandPid)} ]; do sleep 0.1; done
sleep 0.4

${killer}

# Give the signal time to land, then stop watching and see if it is still beating.
sleep 0.6
cp ${JSON.stringify(beat)} ${JSON.stringify(join(d, 'before.txt'))} 2>/dev/null || true
sleep 1.0
cp ${JSON.stringify(beat)} ${JSON.stringify(join(d, 'after.txt'))} 2>/dev/null || true
# Never leave a stray loop behind if the assertion is about to fail.
kill -9 "$(cat ${JSON.stringify(grandPid)} 2>/dev/null)" 2>/dev/null || true
echo "SELF_ALIVE=yes"
`);

  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const lines = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean).length : 0);
  return {
    stillWorking: lines('after.txt') > lines('before.txt'),
    selfSurvived: /SELF_ALIVE=yes/.test(r.stdout || ''),
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

describe('the descendant doing the work is stopped', () => {
  it('a bare kill of the lane shell leaves the worker running', () => {
    // The live defect, reproduced. This is what the abort did.
    const { stillWorking } = abortLane('kill "$_pid" 2>/dev/null || true');
    expect(stillWorking,
      'the reproduction no longer reproduces — if a bare kill now stops the ' +
      'grandchild, this test proves nothing about the fix')
      .toBe(true);
  });

  it('the real abort helper stops the worker', () => {
    const { stillWorking } = abortLane('_kill_lane_tree "$_pid"');
    expect(stillWorking,
      'the lane was "aborted" but its worker kept running — it keeps spending ' +
      'on a run already decided, which is the whole reason the halt exists')
      .toBe(false);
  });
});

describe('it does not kill the run that called it', () => {
  it('the caller survives aborting a lane', () => {
    // A group kill that includes our own process group takes the orchestrator
    // down with the lane — previously seen when a kill helper matched its own
    // process group and killed the runner.
    expect(abortLane('_kill_lane_tree "$_pid"').selfSurvived,
      'aborting a lane killed the process doing the aborting').toBe(true);
  });

  it('refuses its own PID outright', () => {
    const d = mkdtempSync(join(tmpdir(), 'self-'));
    dirs.push(d);
    const script = join(d, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
${fnText('_kill_lane_tree')}
_kill_lane_tree "$$" || true
echo "SURVIVED"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout || '', 'the helper killed itself when handed its own PID').toMatch(/SURVIVED/);
  });

  it('tolerates a PID that has already exited', () => {
    // Lanes finish on their own; aborting a already-dead one must not error out
    // of the halt loop and skip the lanes that ARE still running.
    const d = mkdtempSync(join(tmpdir(), 'dead-'));
    dirs.push(d);
    const script = join(d, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
${fnText('_kill_lane_tree')}
sleep 0.1 & _p=$!
wait "$_p" 2>/dev/null || true
_kill_lane_tree "$_p"
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout || '').toMatch(/RC=0/);
  });
});

describe('the halt actually calls it', () => {
  it('the abort loop uses the tree kill, not a bare kill', () => {
    // The behavioural tests above prove the helper works. This proves it is
    // wired into the path that failed live — a correct helper nobody calls is
    // the same outcome.
    const i = SRC.indexOf('Aborting the codeline(s) still running');
    expect(i, 'the halt message is gone — this assertion is anchored to nothing').toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 600);
    expect(block, 'the halt still kills only the lane shell, orphaning its worker')
      .toMatch(/_kill_lane_tree/);
    expect(block, 'a bare `kill "$_pid"` remains in the abort loop')
      .not.toMatch(/kill\s+"\$_pid"/);
  });
});
