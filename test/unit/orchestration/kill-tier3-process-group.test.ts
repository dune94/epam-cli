/**
 * Fix for a live incident (2026-07-07): killing tier3-travel-app-run.sh's
 * top-level launched PID left several descendants (run-agent-orchestration.sh
 * invocations, live ai-run.sh calls still billing the gate model) running
 * independently, because `bash foo.sh | tee` pipeline components and
 * phase-retry re-invocations are not necessarily direct children of the PID
 * that was signaled — required manually hunting down orphans across several
 * pgrep/kill rounds while the run kept accumulating cost.
 *
 * tier3-travel-app-run.sh now re-execs itself under `setsid` (making itself
 * the leader of a new process group) and writes its own PID to
 * TIER3_PID_FILE. orchestrations/scripts/kill-tier3-run.sh sends the signal
 * to the NEGATIVE of that PID, which the kernel delivers to every process in
 * the group at once, regardless of how deep the descendant tree has grown.
 *
 * This test builds a real nested process tree (setsid leader -> child ->
 * grandchild, mimicking tier3 -> run-agent-orchestration.sh -> ai-run.sh) and
 * proves kill-tier3-run.sh actually reaps the whole tree, and that a stale
 * pidfile pointing at an already-dead PID doesn't error out or prevent the
 * orphan-sweep fallback from running.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync, spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const KILL_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/kill-tier3-run.sh');
const TIER3_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitUntil(fn: () => boolean, timeoutMs = 3000, stepMs = 50): void {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    execSync(`sleep ${stepMs / 1000}`);
  }
}

describe('kill-tier3-run.sh — REAL process-group kill', () => {
  const spawned: ReturnType<typeof spawn>[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('setsid leader + nested child/grandchild sleepers are ALL killed via the process-group signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kill-tier3-test-'));
    dirs.push(dir);
    const pidFile = join(dir, 'tier3.pid');

    // Mimic the real tree: setsid leader (tier3) -> child (run-agent-orchestration.sh)
    // -> grandchild (ai-run.sh), each just sleeping to stand in for real work.
    const treeScript = join(dir, 'tree.sh');
    writeFileSync(
      treeScript,
      `#!/usr/bin/env bash
echo "$$" > "${pidFile}"
bash -c 'bash -c "sleep 300" & wait' &
wait
`,
    );
    chmodSync(treeScript, 0o755);

    const child = spawn('setsid', ['bash', treeScript], { detached: true, stdio: 'ignore' });
    spawned.push(child);

    waitUntil(() => {
      try {
        return readFileSync(pidFile, 'utf8').trim().length > 0;
      } catch {
        return false;
      }
    });
    const leaderPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(pidAlive(leaderPid)).toBe(true);

    // Confirm there really is a nested tree alive under this process group
    // before we kill it (otherwise the test would trivially pass).
    const psTreeBefore = execSync(`ps -o pid,ppid,pgid,cmd -g ${leaderPid} 2>/dev/null || true`, {
      encoding: 'utf8',
    });
    const aliveCountBefore = psTreeBefore.split('\n').filter((l) => l.includes('sleep 300')).length;
    expect(aliveCountBefore).toBeGreaterThanOrEqual(1);

    execFileSync('bash', [KILL_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TIER3_PID_FILE: pidFile },
    });

    waitUntil(() => !pidAlive(leaderPid), 3000);
    expect(pidAlive(leaderPid)).toBe(false);

    const psTreeAfter = execSync(`ps -o pid,cmd -g ${leaderPid} 2>/dev/null || true`, { encoding: 'utf8' });
    expect(psTreeAfter).not.toContain('sleep 300');
  }, 10000);

  it('a stale pidfile pointing at an already-dead PID does not error, and the orphan sweep still runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kill-tier3-stale-'));
    dirs.push(dir);
    const pidFile = join(dir, 'stale.pid');
    // A PID that is astronomically unlikely to be alive.
    writeFileSync(pidFile, '999999\n');

    const output = execFileSync('bash', [KILL_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TIER3_PID_FILE: pidFile },
    });
    expect(output).toMatch(/Sweeping for orphaned orchestration processes/);
    expect(output).not.toMatch(/Traceback|command not found/);
  });

  it('when nothing is running and no pidfile exists, reports "Nothing was running" without error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kill-tier3-empty-'));
    dirs.push(dir);
    const pidFile = join(dir, 'does-not-exist.pid');

    const output = execFileSync('bash', [KILL_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TIER3_PID_FILE: pidFile },
    });
    expect(output).toContain('Nothing was running.');
  });
});

describe('tier3-travel-app-run.sh — setsid self-relaunch and pidfile wiring (structural)', () => {
  const src = readFileSync(TIER3_SCRIPT, 'utf8');

  it('guards the setsid re-exec with an idempotency env var so it does not loop forever', () => {
    expect(src).toMatch(/TIER3_SETSID_DONE/);
    const guardIdx = src.indexOf('TIER3_SETSID_DONE:-');
    const execIdx = src.indexOf('exec setsid');
    expect(execIdx).toBeGreaterThan(guardIdx);
  });

  it('writes its own PID to TIER3_PID_FILE before doing any real work', () => {
    expect(src).toMatch(/TIER3_PID_FILE="\$\{TIER3_PID_FILE:-\/tmp\/tier3-travel-app-run\.pid\}"/);
    expect(src).toMatch(/echo "\$\$" > "\$TIER3_PID_FILE"/);
  });

  it('cleans up the pidfile on exit via a trap', () => {
    expect(src).toMatch(/trap 'rm -f "\$TIER3_PID_FILE"' EXIT/);
  });

  it('the pidfile write happens BEFORE the first run_phase() invocation', () => {
    const pidWriteIdx = src.indexOf('echo "$$" > "$TIER3_PID_FILE"');
    const runPhaseCallIdx = src.indexOf('run_phase "scaffold"');
    expect(pidWriteIdx).toBeGreaterThan(-1);
    expect(runPhaseCallIdx).toBeGreaterThan(pidWriteIdx);
  });
});
