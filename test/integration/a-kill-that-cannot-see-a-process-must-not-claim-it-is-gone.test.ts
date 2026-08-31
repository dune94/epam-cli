/**
 * A KILL THAT CANNOT SEE A PROCESS MUST NOT REPORT THAT NONE REMAIN.
 *
 * Live 2026-08-31, metrolinx AMSD-1919. kill-tier3-run.sh reported:
 *
 *     [kill-tier3] ✓ Done — verified no orchestration processes remain.
 *
 * Five processes were still alive, carrying ORCH_RUN_ID=20260831T022433Z, including a live
 * `claude --print --model claude-opus-5` on the roster-specialiser seam. They had been reparented
 * to /init when their parent died, so a process-group kill missed them, and they kept SPENDING
 * after the operator had been told the run was stopped.
 *
 * The check itself is sound — list_survivors would have failed the kill. It could not see them:
 * `orphan_pattern` is a hand-maintained list of launcher script names, and llm-handler.sh — the
 * hub EVERY model call goes through — is not in it.
 *
 * A run identifies itself. ORCH_RUN_ID is in the environment of every process the run spawned, and
 * it does not depend on anyone remembering to add a script name to a regex.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const KILLER = join(REPO, 'orchestrations/scripts/kill-tier3-run.sh');

/** list_survivors, spliced out and executed with a run id to look for. */
function survivorsSeenBy(runId: string): string {
  const src = readFileSync(KILLER, 'utf8');
  const start = src.indexOf('list_survivors() {');
  expect(start, 'list_survivors is gone — the shape has changed').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start) + 2);
  const patternLine = src.split('\n').find((l) => l.startsWith('orphan_pattern=')) || '';
  const r = spawnSync('bash', ['-c', `
    ${patternLine}
    MATCH_ROOT=""
    ORCH_RUN_ID=${JSON.stringify(runId)}
    ${body}
    list_survivors
  `], { encoding: 'utf8', timeout: 60000, cwd: REPO });
  return (r.stdout ?? '').trim();
}

describe('a kill that cannot see a process must not claim it is gone', () => {
  it('the survivor check exists and runs', () => {
    expect(typeof survivorsSeenBy('no-such-run')).toBe('string');
  }, 60_000);

  it('sees a process carrying the run id, whatever it is called', async () => {
    // The defect, reproduced: a sleeping process whose command matches NO launcher pattern, but
    // which belongs to the run by its own environment. This is exactly what survived.
    const runId = `TEST-RUN-${process.pid}-${Date.now()}`;
    const child = spawn('bash', ['-c', 'sleep 25'], {
      env: { ...process.env, ORCH_RUN_ID: runId },
      detached: true, stdio: 'ignore',
    });
    child.unref();
    await new Promise((r) => { setTimeout(r, 700); });
    try {
      const seen = survivorsSeenBy(runId);
      expect(seen, `a process carrying ORCH_RUN_ID=${runId} was invisible to the survivor check, `
        + 'so the kill would report "no orchestration processes remain" while it kept running')
        .toContain(String(child.pid));
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 60_000);

  it('and does not report processes from a DIFFERENT run', async () => {
    // The negative half: matching on a run id must not sweep in someone else's work, or the killer
    // becomes the thing that takes down a neighbouring run.
    const mine = `TEST-RUN-A-${process.pid}-${Date.now()}`;
    const theirs = `TEST-RUN-B-${process.pid}-${Date.now()}`;
    const child = spawn('bash', ['-c', 'sleep 25'], {
      env: { ...process.env, ORCH_RUN_ID: theirs }, detached: true, stdio: 'ignore',
    });
    child.unref();
    await new Promise((r) => { setTimeout(r, 700); });
    try {
      expect(survivorsSeenBy(mine), "another run's process was reported as this run's survivor")
        .not.toContain(String(child.pid));
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 60_000);
});
