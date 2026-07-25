/**
 * B32 — kill-tier3-run.sh must actually stop the pipeline, and must be loud when
 * it cannot.
 *
 * Found live 2026-07-25 killing a metrolinx run. The script printed "Done." and
 * exited 0 while the pipeline was still executing and still billing LLM calls:
 * fresh ai-run.sh processes appeared on glm-5.2, then glm-5.1, then kimi-k3 in
 * the seconds AFTER the "successful" kill. Three independent defects:
 *
 *   1. PID_FILE defaulted to /tmp/tier3-travel-app-run.pid. metrolinx writes
 *      /tmp/tier3-metrolinx-run.pid, so unless the caller exported
 *      TIER3_PID_FILE the process-group kill — the whole point of the script —
 *      was skipped silently and only the name sweep ran.
 *   2. The sweep pattern listed the runner scripts but not spec-mode-runner.js,
 *      which runs in its OWN process group (so the group kill can't reach it
 *      either) and keeps spawning agents. That is what survived.
 *   3. The sweep was single-pass and unverified: signal, sleep, print "Done.",
 *      exit 0. A parent that spawns a new child after the sweep is simply
 *      missed, and the operator is told the run is dead.
 *
 * Defect 3 is the one that makes the other two dangerous, and it is the same
 * shape as the self-heal and ladder defects: a mechanism reporting success
 * without verifying it. A kill script that cannot be trusted forces hand-killing
 * PIDs, which is exactly what the standing rule forbids.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KILL = join(__dirname, '../../../orchestrations/scripts/kill-tier3-run.sh');
const dirs: string[] = [];

/** A sandbox whose paths match the real orphan patterns, so pgrep -f sees them
 *  exactly as it would see the real thing. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'b32-'));
  dirs.push(root);
  mkdirSync(join(root, 'orchestrations/scripts'), { recursive: true });
  return root;
}

function alive(pattern: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

// Scope every invocation to this test's sandbox. The sweep pattern legitimately
// includes pipeline agents, so an unscoped kill inside a PARALLEL suite reaps
// other tests' children — it was killing the self-heal analyst about 1 run in 3.
function runKill(env: Record<string, string> = {}, root?: string) {
  try {
    const out = execFileSync('bash', [KILL], {
      encoding: 'utf8',
      env: { ...process.env, ...(root ? { KILL_TIER3_MATCH_ROOT: root } : {}), ...env },
    });
    return { out, code: 0 };
  } catch (e: any) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
}

// Track what we spawn and kill exactly those. A pattern-based pkill here is
// actively dangerous: the test-runner's own command line contains these strings
// (they appear in this file's source and in the harness wrapper), so `pkill -f
// spec-mode-runner` matches the runner itself and kills the suite mid-flight.
const spawned: number[] = [];
function launch(script: string) {
  const c = spawn('setsid', ['bash', script], { detached: true, stdio: 'ignore' });
  if (typeof c.pid === 'number') spawned.push(c.pid);
  c.unref();
}

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('B32 — kill-tier3-run.sh reaches every pipeline process', () => {
  it('kills spec-mode-runner.js, which runs in its own process group', async () => {
    const root = sandbox();
    const script = join(root, 'orchestrations/scripts/spec-mode-runner.js');
    writeFileSync(script, 'sleep 120\n');
    // setsid: its own process group, exactly like the real one — this is why the
    // group-targeted kill cannot reach it and the name sweep must.
    launch(script);
    await new Promise(r => setTimeout(r, 600));
    expect(alive(script), 'fixture did not start').toBeGreaterThan(0);

    runKill({}, root);
    await new Promise(r => setTimeout(r, 1500));
    expect(alive(script),
      'spec-mode-runner.js survived the kill — it kept spawning billed LLM calls').toBe(0);
  }, 40000);

  it('honours the metrolinx pidfile without TIER3_PID_FILE being exported', () => {
    const src = execFileSync('cat', [KILL], { encoding: 'utf8' });
    expect(src,
      'PID_FILE defaults to travel-app only, so a metrolinx kill skips the process-group kill entirely')
      .toMatch(/tier3-metrolinx-run\.pid|for .*\.pid|tier3-\*\.pid|glob/);
  });
});

describe('B32 — a kill that did not work must not report success', () => {
  it('exits non-zero and says so when a matching process survives', async () => {
    const root = sandbox();
    // The respawning parent is deliberately NOT a name the sweep matches, so the
    // killer can never win. That is the real-world case — an unknown parent the
    // pattern doesn't know about — and it makes "survivors remain" deterministic
    // rather than a race. The script must notice and say so.
    const child = join(root, 'orchestrations/scripts/ai-run.sh');
    const parent = join(root, 'b32-respawner-not-in-pattern.sh');
    writeFileSync(child, 'sleep 120\n');
    writeFileSync(parent, `while true; do bash ${child} & sleep 0.3; done\n`);
    launch(parent);
    await new Promise(r => setTimeout(r, 800));
    expect(alive(child), 'respawner fixture did not start').toBeGreaterThan(0);

    const { out, code } = runKill({ KILL_TIER3_MAX_ROUNDS: '2' }, root);
    await new Promise(r => setTimeout(r, 1200));

    const survivors = alive(child) + alive(parent);
    if (survivors > 0) {
      expect(code, 'processes survived but the script still exited 0 — "Done." while the run continues')
        .not.toBe(0);
      expect(out).toMatch(/surviv|failed|could not/i);
    } else {
      expect(code).toBe(0);
    }
  }, 40000);
});
