/**
 * run_story_with_watchdog()'s timeout must be driven by project config
 * (llm-settings.json, loaded via _load_timeout_config() in
 * lib/story-guards.sh), not only the previously-hardcoded per-effort case
 * statement (low=600/medium=1200/high=2400/default=900).
 *
 * Root cause this fixes (found live, 2026-08-02, gotransit/upexpress digging):
 * load_llm_settings_json() (claude.sh) already exported EPAM_STORY_TIMEOUT_SECS
 * from a project's llm-settings.json, but run_story_with_watchdog() read the
 * unprefixed STORY_TIMEOUT_SECS — the two never connected (a naming mismatch).
 * Worse, load_llm_settings_json() only runs INSIDE claude.sh, which
 * run_story_with_watchdog() invokes AS A SUBPROCESS of itself — by the time
 * claude.sh could export anything, the watchdog's own `timeout` wrapper
 * around that exact invocation had already been computed and applied. A
 * child process's env can never propagate back to its own parent, so no
 * env-var renaming alone could ever have fixed this — config must be loaded
 * in run-agent-orchestration.sh itself, before the call.
 *
 * These tests prove the actual VALUE run_story_with_watchdog() passes to the
 * real `timeout` command, by shadowing `timeout` with a recording wrapper
 * that still delegates to the real one (so the invoked process still runs
 * and completes normally — no double-invocation or command semantics are
 * mocked away, only the duration argument is observed).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractWatchdogFunction(): string {
  const start = orchSrc.indexOf('run_story_with_watchdog() {');
  const endMarker = 'return $_rc\n}';
  const endIdx = orchSrc.indexOf(endMarker, start);
  return orchSrc.slice(start, endIdx + endMarker.length);
}

// run_story_with_watchdog() calls resolve_role_timeout_multiplier() on the
// effort-based (non-flat-override) path — must be included in the same
// extracted script or that call fails with "command not found".
function extractRoleMultiplierFunction(): string {
  const start = orchSrc.indexOf('resolve_role_timeout_multiplier() {');
  const endIdx = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, endIdx);
}

function runWatchdogAndCaptureTimeout(opts: {
  storyEffort?: string;
  agentRole?: string;
  extraEnv?: Record<string, string>;
}): number {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-cfg-timeout-'));
  const prdPath = join(dir, 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({
      stories: [
        {
          id: 'AMSD-2041',
          status: 'pending',
          effort: opts.storyEffort ?? 'medium',
          agentRole: opts.agentRole ?? '',
          technicalNotes: {},
        },
      ],
    }),
  );

  const stubPath = join(dir, 'claude-stub.sh');
  writeFileSync(stubPath, ['#!/usr/bin/env bash', 'exit 0'].join('\n'));
  chmodSync(stubPath, 0o755);

  const logDir = mkdtempSync(join(tmpdir(), 'watchdog-cfg-timeout-log-'));
  const captureLog = join(dir, 'timeout-capture.log');

  const fn = extractWatchdogFunction();
  const roleMultiplierFn = extractRoleMultiplierFunction();
  const envLines = Object.entries(opts.extraEnv ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  const script = [
    'set -euo pipefail',
    'error() { echo "[ERROR] $1" >&2; }',
    'warning() { echo "[WARNING] $1" >&2; }',
    'log() { echo "[LOG] $1" >&2; }',
    `PRD_FILE=${JSON.stringify(prdPath)}`,
    `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    `CLAUDE_SH=${JSON.stringify(stubPath)}`,
    'PHASE=core',
    ...envLines,
    // Shadow `timeout` to record its duration argument, then delegate to the
    // real binary so the wrapped command still actually runs.
    `timeout() { echo "$1" >> ${JSON.stringify(captureLog)}; command timeout "$@"; }`,
    roleMultiplierFn,
    fn,
    'run_story_with_watchdog "AMSD-2041" "' + join(logDir, 'main-AMSD-2041.log') + '"',
    'echo "RC=$?"',
  ].join('\n');

  try {
    execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  } catch {
    // best-effort; we only care about the capture log
  }
  let capturedSecs = -1;
  try {
    const lines = readFileSync(captureLog, 'utf8').trim().split('\n').filter(Boolean);
    capturedSecs = parseInt(lines[0], 10);
  } catch {
    capturedSecs = -1;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  return capturedSecs;
}

describe('run_story_with_watchdog — timeout config wiring', () => {
  it('uses the hardcoded per-effort default (medium=1200) when no config env vars are set', () => {
    const secs = runWatchdogAndCaptureTimeout({ storyEffort: 'medium' });
    expect(secs).toBe(1200);
  });

  it('uses EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS (config-driven) instead of the hardcoded 600 for a low-effort story', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'low',
      extraEnv: { EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS: '300' },
    });
    expect(secs).toBe(300);
  });

  it('uses EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS (config-driven) instead of the hardcoded 2400 for a high-effort story', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'high',
      extraEnv: { EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS: '3600' },
    });
    expect(secs).toBe(3600);
  });

  it('uses EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS for an unrecognized effort value', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'unrecognized-tier',
      extraEnv: { EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS: '111' },
    });
    expect(secs).toBe(111);
  });

  it('EPAM_STORY_TIMEOUT_SECS (the config-loaded flat override) is honored, skipping effort-based scaling entirely', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'high',
      extraEnv: { EPAM_STORY_TIMEOUT_SECS: '42', EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS: '9999' },
    });
    expect(secs).toBe(42);
  });

  it('the manual STORY_TIMEOUT_SECS env var still wins over the config-loaded EPAM_STORY_TIMEOUT_SECS', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'high',
      extraEnv: { STORY_TIMEOUT_SECS: '7', EPAM_STORY_TIMEOUT_SECS: '42' },
    });
    expect(secs).toBe(7);
  });

  it('applies a config-driven role multiplier (EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP) on top of the effort-tier base', () => {
    const secs = runWatchdogAndCaptureTimeout({
      storyEffort: 'medium',
      agentRole: 'writer',
      extraEnv: {
        EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS: '1000',
        EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP: 'writer=1.5',
      },
    });
    expect(secs).toBe(1500);
  });
});
