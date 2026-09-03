/**
 * THE EXTERNAL-CLI PATH GETS THE BUDGETS IT WAS NEVER GIVEN.
 *
 * `ai-run` receives EPAM_MAX_ITERATIONS, EPAM_AUTO_COMPRESS_AT, EPAM_MAX_OUTPUT_TOKENS and
 * EPAM_MAX_TOOL_CALLS as environment. The external-CLI branch received only --model and
 * permissions, so every cap was INERT there — measured: one seam ran 1,486 generations in
 * 44 continuous minutes, and nothing in the pipeline could stop it.
 *
 * apply_runner_settings closes that. It reads the runner's DECLARATION and exports/appends
 * whatever it names. The engine knows no knob names, so this is proven with a FIXTURE runner
 * the engine has never heard of — if it works for that, it works for any.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/runner-settings.sh');
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scaffold(runners: any) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-')); tmps.push(dir);
  const cfg = join(dir, 'config'); mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'provider-sets.json'), JSON.stringify({
    defaultSet: 'only',
    sets: { only: { settingsFile: 'stack.only.json', projectEnvSuffix: 'only' } },
    projectEnv: { base: 'config.env', overlay: 'config.{set}.env' },
  }));
  writeFileSync(join(cfg, 'llm-defaults.json'), JSON.stringify({}));
  writeFileSync(join(cfg, 'stack.only.json'), JSON.stringify({ runners }));
  const project = join(dir, 'proj'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'llm-settings.json'), JSON.stringify({}));
  return { dir, cfg, project };
}

/** Run apply_runner_settings for real and report what it exported and appended. */
function run(runnerName: string, runners: any, seed: Record<string, string> = {}) {
  const { cfg, project } = scaffold(runners);
  const r = spawnSync('bash', ['-c', `
    . "${LIB}"
    RUNNER_FLAGS=()
    apply_runner_settings "${runnerName}" "${project}"
    rc=$?
    for _k in $(compgen -e); do printf 'ENV %s=%s\\n' "$_k" "\${!_k}"; done
    for _f in "\${RUNNER_FLAGS[@]}"; do printf 'FLAG %s\\n' "$_f"; done
    printf 'RC %s\\n' "$rc"
  `], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_PROVIDER_SETS_FILE: join(cfg, 'provider-sets.json'),
           NODE_BIN: process.execPath, ...seed },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const env: Record<string, string> = {};
  const flags: string[] = [];
  let rc = -1;
  for (const line of out.split('\n')) {
    if (line.startsWith('ENV ')) { const kv = line.slice(4); const i = kv.indexOf('='); env[kv.slice(0, i)] = kv.slice(i + 1); }
    else if (line.startsWith('FLAG ')) flags.push(line.slice(5));
    else if (line.startsWith('RC ')) rc = Number(line.slice(3));
  }
  return { env, flags, rc, out };
}

const FIXTURE = {
  'a-fixture-runner': {
    alwaysFlags: ['-s'],
    env: { SOME_TOOL_MAX_TURNS: 'maxIterations', SOME_TOOL_MAX_OUT: 'maxOutputTokens' },
    flags: { '--timeout': 'timeoutSeconds' },
  },
};

describe('the CLI path gets its budgets', () => {
  it('exports every env the declaration names, with the resolved value', () => {
    const r = run('a-fixture-runner', FIXTURE, {
      EPAM_RUNNER_VALUE_maxIterations: '250', EPAM_RUNNER_VALUE_maxOutputTokens: '64000',
    });
    expect(r.rc).toBe(0);
    expect(r.env.SOME_TOOL_MAX_TURNS).toBe('250');
    expect(r.env.SOME_TOOL_MAX_OUT).toBe('64000');
  });

  it('appends alwaysFlags — a correctness requirement, not a preference', () => {
    const r = run('a-fixture-runner', FIXTURE, { EPAM_RUNNER_VALUE_maxIterations: '250' });
    expect(r.flags).toContain('-s');
  });

  it('appends a declared flag WITH its value', () => {
    const r = run('a-fixture-runner', FIXTURE, { EPAM_RUNNER_VALUE_timeoutSeconds: '1800' });
    expect(r.flags).toContain('--timeout');
    expect(r.flags).toContain('1800');
  });

  it('a knob the declaration does NOT name is never exported — over-inclusion is the untested direction', () => {
    const r = run('a-fixture-runner', FIXTURE, { EPAM_RUNNER_VALUE_maxIterations: '250' });
    expect(r.env.SOME_TOOL_UNDECLARED).toBeUndefined();
    expect(r.env.CLAUDE_CODE_MAX_TURNS).toBeUndefined();
  });

  it('a setting with NO resolved value is SKIPPED, not exported empty', () => {
    // Exporting an empty cap is worse than exporting none: a tool reading "" may treat it as
    // zero or as invalid, and either way the operator sees a knob that looks set.
    const r = run('a-fixture-runner', FIXTURE, {});
    expect(r.env.SOME_TOOL_MAX_TURNS).toBeUndefined();
    expect(r.rc).toBe(0);
  });

  it('an UNDECLARED runner changes nothing and succeeds — the other path is untouched', () => {
    const r = run('some-other-runner', FIXTURE, { EPAM_RUNNER_VALUE_maxIterations: '250' });
    expect(r.rc).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.env.SOME_TOOL_MAX_TURNS).toBeUndefined();
  });
});
