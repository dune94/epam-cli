/**
 * _load_timeout_config() (lib/story-guards.sh) — loads timeout fallback
 * defaults from EPAM_PROJECT_CONFIG_DIR/llm-settings.json for
 * run-agent-orchestration.sh's run_story_with_watchdog(). See that
 * function's own docstring and run-story-watchdog-timeout-config.test.ts
 * for the end-to-end wiring proof; this file covers the loader in
 * isolation (same "only export if unset" contract as claude.sh's
 * load_llm_settings_json(), which this function deliberately mirrors).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const STORY_GUARDS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const storyGuardsSrc = readFileSync(STORY_GUARDS_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = storyGuardsSrc.indexOf(`${name}() {`);
  const end = storyGuardsSrc.indexOf('\n}', start) + 2;
  return storyGuardsSrc.slice(start, end);
}
const FN_BODY = extractFunctionBody('_load_timeout_config');

const PROBE_VARS = [
  'EPAM_STORY_TIMEOUT_SECS',
  'EPAM_GATE_TIMEOUT_SECS',
  'EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS',
  'EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS',
  'EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS',
  'EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS',
  'EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP',
  'EPAM_WATCHDOG_RETRY_MULTIPLIER',
];

function runLoader(settings: object | null, preExistingEnv: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'timeout-config-'));
  try {
    if (settings !== null) {
      writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(settings));
    }
    const preEnvLines = Object.entries(preExistingEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    const probe = PROBE_VARS.map((v) => `[ -n "\${${v}+x}" ] && echo "${v}=$${v}"`).join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      [
        // set -e matches the real caller (run-agent-orchestration.sh runs
        // under `set -e` from its first line) — found live 2026-08-02: a
        // jq query that errors on a MISSING (not merely absent-value) key
        // (`null | to_entries` is a runtime error, not an empty result)
        // silently passed every test here because they ran WITHOUT set -e,
        // then killed the real orchestration script with exit 5 the moment
        // it was actually invoked. Never test a function meant to run under
        // set -e without set -e in the harness.
        'set -e',
        `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(dir)}`,
        ...preEnvLines,
        FN_BODY,
        '_load_timeout_config',
        probe,
        'exit 0',
      ].join('\n'),
    );
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const result: Record<string, string> = {};
    for (const line of out.split('\n')) {
      if (!line.includes('=')) continue;
      const idx = line.indexOf('=');
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('_load_timeout_config — no-op guards', () => {
  it('is a silent no-op when EPAM_PROJECT_CONFIG_DIR has no llm-settings.json', () => {
    const env = runLoader(null);
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('is a silent no-op when llm-settings.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeout-config-bad-'));
    writeFileSync(join(dir, 'llm-settings.json'), '{ not valid json');
    const probe = PROBE_VARS.map((v) => `[ -n "\${${v}+x}" ] && echo "${v}=$${v}"`).join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      ['set -e', `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(dir)}`, FN_BODY, '_load_timeout_config', probe, 'exit 0'].join(
        '\n',
      ),
    );
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    expect(out.trim()).toBe('');
  });
});

describe('_load_timeout_config — applies JSON as fallback defaults', () => {
  it('exports all timeout fields from a full config', () => {
    const env = runLoader({
      timeouts: {
        storyTimeoutSecs: 1800,
        gateTimeoutSecs: 2400,
        storyEffortTimeoutSecs: { low: 300, medium: 900, high: 1800, default: 600 },
        roleTimeoutMultipliers: { 'test-engineer': 1.5, writer: 1.2 },
        watchdogRetryMultiplier: 2,
      },
    });
    expect(env.EPAM_STORY_TIMEOUT_SECS).toBe('1800');
    expect(env.EPAM_GATE_TIMEOUT_SECS).toBe('2400');
    expect(env.EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS).toBe('300');
    expect(env.EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS).toBe('900');
    expect(env.EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS).toBe('1800');
    expect(env.EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS).toBe('600');
    expect(env.EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP).toBe('test-engineer=1.5|writer=1.2');
    expect(env.EPAM_WATCHDOG_RETRY_MULTIPLIER).toBe('2');
  });

  it('leaves unset fields absent (no fabricated defaults from the loader itself)', () => {
    const env = runLoader({ timeouts: { storyTimeoutSecs: 1800 } });
    expect(env.EPAM_STORY_TIMEOUT_SECS).toBe('1800');
    expect(env.EPAM_GATE_TIMEOUT_SECS).toBeUndefined();
    expect(env.EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS).toBeUndefined();
    expect(env.EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP).toBeUndefined();
  });

  it('serializes an empty roleTimeoutMultipliers object to nothing (not an empty string export)', () => {
    const env = runLoader({ timeouts: { roleTimeoutMultipliers: {} } });
    expect(env.EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP).toBeUndefined();
  });

  it('REPRODUCES the exact live defect: a config with storyTimeoutSecs set but roleTimeoutMultipliers entirely ABSENT (not empty-object) must not crash the caller under set -e', () => {
    // Live 2026-08-02: `null | to_entries` is a jq RUNTIME ERROR (exit 5),
    // not an empty result — `.timeouts.roleTimeoutMultipliers` is `null`
    // when the key is missing (as in the real metrolinx llm-settings.json,
    // which sets storyTimeoutSecs/gateTimeoutSecs but no
    // roleTimeoutMultipliers), and `_v=$(_lt_get ...)` is a simple command
    // whose failing exit status kills the whole script under `set -e` — the
    // real caller's mode (run-agent-orchestration.sh runs under `set -e`
    // from its very first line). This exact settings shape silently killed
    // a real Writer Retest launch with no output and exit code 5.
    const env = runLoader({ timeouts: { storyTimeoutSecs: 1800, gateTimeoutSecs: 2400 } });
    expect(env.EPAM_STORY_TIMEOUT_SECS).toBe('1800');
    expect(env.EPAM_GATE_TIMEOUT_SECS).toBe('2400');
    expect(env.EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP).toBeUndefined();
  });
});

describe('_load_timeout_config — an already-exported env var always wins', () => {
  it('does not override a pre-existing EPAM_STORY_TIMEOUT_SECS', () => {
    const env = runLoader(
      { timeouts: { storyTimeoutSecs: 1800 } },
      { EPAM_STORY_TIMEOUT_SECS: '99' },
    );
    expect(env.EPAM_STORY_TIMEOUT_SECS).toBe('99');
  });

  it('does not override a pre-existing EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP', () => {
    const env = runLoader(
      { timeouts: { roleTimeoutMultipliers: { writer: 3 } } },
      { EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP: 'writer=9' },
    );
    expect(env.EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP).toBe('writer=9');
  });
});
