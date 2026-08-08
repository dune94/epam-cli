/**
 * A RUNNING WATCHER WITH NO PID FILE IS STILL A RUNNING WATCHER.
 *
 * Pre-flight refuses to start a run when the dashboard snapshot watcher is dead. The fallback
 * that looks for the live process sat INSIDE the branch guarded by `-f "$SNAP_PID_FILE"`, so
 * it was reachable only when a PID file already existed. Started by hand — precisely what the
 * check's own error message instructs — the watcher writes no PID file, so pre-flight reported
 * it dead while it was polling every ten seconds, and refused to run the pipeline.
 *
 * Found 2026-08-08 by the estate integration harness: the watcher was verified running (PID
 * confirmed, build-info.json 5s old, the very next check passing) and this one still failed.
 *
 * The PID file also moved: the watcher is a machine-level daemon feeding the dashboards, not a
 * per-run artefact, so a run keeping its artefacts elsewhere must not look for it in its own
 * directory.
 *
 * These tests EXECUTE the real block against a stub `pgrep`/`ps` on PATH.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/preflight-check.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real detection block, lifted out of the script. */
function block(): string {
  const start = SRC.indexOf('SNAP_PID_FILE=');
  const endMark = 'fail "snapshot-watch.js is NOT running';
  const end = SRC.indexOf(endMark, start);
  expect(start, 'the watcher detection block is gone').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, SRC.indexOf('fi', end) + 2);
}

/**
 * Runs the block with a stubbed process table.
 * @param running whether a snapshot-watch.js process exists
 * @param pidFile whether a PID file exists (and whether its pid is alive)
 */
function detect(running: boolean, pidFile: 'none' | 'live' | 'stale'): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-snap-')); dirs.push(dir);
  const bin = join(dir, 'bin');
  const logs = join(dir, 'scripts', '..', 'logs');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });

  writeFileSync(join(bin, 'pgrep'), `#!/usr/bin/env bash\nexit ${running ? 0 : 1}\n`);
  chmodSync(join(bin, 'pgrep'), 0o755);
  // `ps -p <pid>` succeeds only for the "live" case.
  writeFileSync(join(bin, 'ps'), `#!/usr/bin/env bash\nexit ${pidFile === 'live' ? 0 : 1}\n`);
  chmodSync(join(bin, 'ps'), 0o755);

  if (pidFile !== 'none') writeFileSync(join(dir, 'logs', 'dashboards-watch.pid'), '424242');

  const sh = join(dir, 'scripts', 'check.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\n` +
    `ok(){ echo "OK: $*"; }\nfail(){ echo "FAIL: $*"; }\n` +
    `${block()}\n`);
  return execFileSync('bash', [sh], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).trim();
}

describe('the fixture is real', () => {
  it('a dead watcher with no pid file is reported dead', () => {
    expect(detect(false, 'none')).toMatch(/^FAIL:/);
  });

  it('a live pid file reports running — the pre-existing happy path', () => {
    expect(detect(true, 'live')).toMatch(/^OK:/);
  });
});

describe('THE DEFECT: a hand-started watcher writes no pid file', () => {
  it('a running watcher with NO pid file is reported RUNNING', () => {
    expect(
      detect(true, 'none'),
      'pre-flight refuses to start the pipeline while the watcher is polling every 10s — and ' +
      'starting it by hand, as the error message instructs, never creates a pid file',
    ).toMatch(/^OK:/);
  });

  it('a running watcher with a STALE pid file is reported running', () => {
    // The process was restarted; the old pid is gone but the watcher is alive.
    expect(detect(true, 'stale')).toMatch(/^OK:/);
  });

  it('a stale pid file with NO process is still reported dead', () => {
    expect(detect(false, 'stale'), 'a dead watcher must not pass on a leftover pid file')
      .toMatch(/^FAIL:/);
  });
});

describe('the pid file is machine-scoped, not run-scoped', () => {
  it('it is not read from LOG_DIR — a run keeping artefacts elsewhere would never find it', () => {
    const start = SRC.indexOf('SNAP_PID_FILE=');
    expect(SRC.slice(start, start + 200)).not.toMatch(/LOG_DIR_DEFAULT/);
  });
});
