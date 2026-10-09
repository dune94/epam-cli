/**
 * THE LAUNCHER FINISHES WHAT A PHASE HANDS BACK — a completed phase is validated, a paused one says so, a failed one
 * fails.
 *
 * Found 2026-10-09 rehearsing a fresh AMSD-2974 run: orchestrate.sh runs under `set -euo pipefail`, and run_phase ended
 * `[ "$phase_exit" -ne 0 ] && fail ...`. On a phase that SUCCEEDED that last test is false, the function returns 1, and
 * set -e ended the launcher there — silently, exit 1, before its spend report and its story-completion validation. No
 * live run's log ever shows "Validating story completion". And a phase that paused (EPAM_PAUSE_BEFORE_WRITER in every
 * lane) was indistinguishable from one that completed: the lanes recorded their pause in their own log dirs only and the
 * run printed "Pipeline complete".
 *
 * EXECUTED: the real orchestrate.sh, launched as the `pipeline` wrapper launches it, in a shadow install whose scripts
 * are the real ones except run-agent-orchestration.sh — a stub that completes the story, pauses (recording the pause as
 * lib/checkpoints.sh record_run_pause does), or fails.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Outcome = 'complete' | 'pause' | 'fail';

function launch(outcome: Outcome) {
  const d = mkdtempSync(join(tmpdir(), 'launcher-')); dirs.push(d);
  const orch = join(d, 'orchestrations'); mkdirSync(orch);
  // COPIED, NEVER SYMLINKED. The launcher and pre-run-reset resolve their own location with readlink -f, so a symlinked
  // script finds the REAL repository and resets it (this test's first draft archived the repo's logs and restored its
  // profiles.json). Every directory the launcher may write is this run's own.
  const skip = /\/scripts\/(\.venv|tools)(\/|$)/;
  for (const e of ['scripts', 'agents', 'config', 'prompts', 'plugins', 'ecosystems']) {
    if (existsSync(join(ORCH, e))) cpSync(join(ORCH, e), join(orch, e), { recursive: true, filter: (src) => !skip.test(src) });
  }
  mkdirSync(join(orch, 'dashboards'));
  for (const f of readdirSync(join(ORCH, 'dashboards'), { withFileTypes: true })) if (f.isFile()) cpSync(join(ORCH, 'dashboards', f.name), join(orch, 'dashboards', f.name));
  cpSync(join(ROOT, 'orchestrations-installer/lib'), join(d, 'orchestrations-installer/lib'), { recursive: true });
  const scripts = join(orch, 'scripts');
  rmSync(join(scripts, 'run-agent-orchestration.sh'));
  mkdirSync(join(orch, 'logs'));
  mkdirSync(join(orch, 'projects'));
  cpSync(join(ORCH, 'projects/hello-dolly'), join(orch, 'projects/demo'), { recursive: true, filter: (s) => !/\/(runs|seed|stand-in|kb)(\/|$)/.test(s) });
  writeFileSync(join(d, '.env'), '');
  const codelines = join(d, 'codelines'); mkdirSync(codelines);
  // The phase. Its outcome is what the launcher must report; the PRD is the launcher's own (PRD_FILE).
  writeFileSync(join(scripts, 'run-agent-orchestration.sh'), `#!/usr/bin/env bash
set -u
echo "STUB phase: ${outcome}"
case "${outcome}" in
  complete) printf '%s' '{"project":{"name":"demo"},"implementationOrder":{"core":["S-1"]},"stories":[{"id":"S-1","phase":"core","status":"completed","completed":true}]}' > "$PRD_FILE"; exit 0 ;;
  pause) . "$(dirname "$0")/lib/checkpoints.sh" 2>/dev/null; ORCH_RUN_ID=R-1 PHASE=core LOG_DIR="\${LOG_DIR:-$(dirname "$0")/../logs}" record_run_pause pre-writer; exit 0 ;;
  fail) exit 1 ;;
esac
`);
  chmodSync(join(scripts, 'run-agent-orchestration.sh'), 0o755);
  const bin = join(d, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nexit 1\n'); chmodSync(join(bin, 'docker'), 0o755);
  const r = spawnSync('bash', [join(scripts, 'orchestrate.sh'), '--project', 'demo', '--yes'], {
    cwd: d, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EPAM_PROVIDER_SET: 'mockserver', EPAM_FREE_RUN: '1',
      JIRA_CODELINE_ROOT: codelines, JIRA_TICKET: 'DEMO-1', NODE_BIN: process.execPath, LOG_DIR: join(orch, 'logs') },
  });
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (process.env.LAUNCHER_DEBUG) console.log(out.slice(-3000));
  return { out, status: r.status, logs: join(orch, 'logs') };
}

describe('the launcher reports what the phase handed back', () => {
  it('the harness reached the phase (the stub ran)', () => {
    const r = launch('complete');
    expect(r.out, r.out.slice(-2000)).toContain('STUB phase: complete');
  });

  it('a completed phase: the launcher goes on to validate the stories, and passes with exit 0', () => {
    const r = launch('complete');
    expect(r.out, r.out.slice(-2000)).toContain('Validating story completion');
    expect(r.out).toMatch(/Project 'demo' PASSED/);
    expect(r.status).toBe(0);
  });

  it('a paused phase: the launcher says the run is paused and how to resume, exit 0, and does not judge it failed', () => {
    const r = launch('pause');
    expect(r.out, r.out.slice(-2000)).toMatch(/paused at pre-writer/i);
    expect(r.out).toContain('EPAM_RESUME_RUN=R-1');
    expect(r.out).not.toMatch(/Project 'demo' (FAILED|PASSED)/);
    expect(r.status).toBe(0);
  });

  it('a failed phase: the launcher aborts with exit 1', () => {
    const r = launch('fail');
    expect(r.out, r.out.slice(-2000)).toMatch(/Phase 'core' failed \(exit 1\) — aborting pipeline/);
    expect(r.status).toBe(1);
    expect(existsSync(join(r.logs, 'paused-run.json'))).toBe(false);
  });
});
