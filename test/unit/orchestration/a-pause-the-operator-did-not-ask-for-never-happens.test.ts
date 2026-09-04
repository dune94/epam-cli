/**
 * A PAUSE THE OPERATOR DID NOT ASK FOR MUST NOT HAPPEN.
 *
 * Live 2026-09-04, pipeline-tests-19. The operator ticked NEITHER pause box on the launch
 * dashboard and the run paused anyway, after the roster mint. Verbatim: "there are two pause
 * settings in the fe flutter screen I set neither yet the run paused - so the controls on the fe
 * are not being passed to the pipeline properly".
 *
 * TWO defects compose, and neither is visible from its own side:
 *
 *   1. buildLaunchEnv (runner-args.js) sets EPAM_PAUSE_* only when the box is TICKED. Its comment
 *      argues "Absent means absent — never '0'". But absent is not absent to the pipeline: the
 *      launcher sources the project's config.env, which...
 *   2. ...assigns EPAM_PAUSE_AFTER_AGENT_MINT=1 UNCONDITIONALLY (metrolinx config.env:255-256).
 *
 * So an unticked box is silently overwritten by the project default, and the dashboard's controls
 * can express "on" and cannot express "off". The operator has no way to say no.
 *
 * THE CONTRACT, both halves, because either alone still fails:
 *   - the request's answer is a DECISION and travels as one: false must reach the pipeline as an
 *     explicit 0, not as silence.
 *   - a project default is a DEFAULT: config.env must yield to a value the launch already set.
 *
 * NOTHING IS HARDCODED. The variables under test are DERIVED by reading which EPAM_* variables
 * buildLaunchEnv actually emits, so a third pause added tomorrow is covered tomorrow — and every
 * project's config.env is discovered by glob, not listed here.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const ARGS_SRC = join(REPO, 'launch-dashboard/backend/src/runner-args.js');
const PROJECTS = join(REPO, 'orchestrations/projects');

/**
 * The pause variables, read from the code that emits them — never typed here.
 * buildLaunchEnv writes them as `env.EPAM_PAUSE_... = '1'`.
 */
function pauseVarsEmittedByTheLauncher(): string[] {
  const src = readFileSync(ARGS_SRC, 'utf8');
  return [...src.matchAll(/env\.(EPAM_PAUSE_[A-Z_]+)\s*=/g)].map((m) => m[1]);
}

/** Every project that declares configuration — discovered, not listed. */
function projectConfigs(): Array<{ project: string; file: string }> {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ project: d.name, file: join(PROJECTS, d.name, 'config.env') }))
    .filter((p) => existsSync(p.file));
}

const PAUSE_VARS = pauseVarsEmittedByTheLauncher();

describe('the launch carries the operator\'s answer, including "no"', () => {
  it('there are pause variables to check — otherwise every case below is vacuous', () => {
    expect(PAUSE_VARS.length,
      'no EPAM_PAUSE_* assignment found in runner-args.js — the derivation broke, not the pipeline')
      .toBeGreaterThan(1);
  });

  it('an UNTICKED box reaches the pipeline as an explicit 0, not as silence', () => {
    // Run the real module. Silence is what config.env then overrides — which is the whole defect.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { buildLaunchEnv } from ${JSON.stringify(ARGS_SRC)};
      const env = buildLaunchEnv(
        { ticket: 'T-1', pauseAfterMint: false, pauseBeforeWriter: false },
        { providerSet: 'claude' });
      process.stdout.write(JSON.stringify(env));
    `], { encoding: 'utf8', timeout: 30_000 });
    const env = JSON.parse(out);

    for (const v of PAUSE_VARS) {
      expect(env[v],
        `${v} was left ABSENT for an unticked box. The project's config.env then sets it to 1 and ` +
        'the run pauses anyway — the operator ticked nothing and got both pauses.')
        .toBe('0');
    }
  });

  it('a TICKED box still reaches it as 1 — the fix does not invert the control', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { buildLaunchEnv } from ${JSON.stringify(ARGS_SRC)};
      process.stdout.write(JSON.stringify(buildLaunchEnv(
        { ticket: 'T-1', pauseAfterMint: true, pauseBeforeWriter: true },
        { providerSet: 'claude' })));
    `], { encoding: 'utf8', timeout: 30_000 });
    const env = JSON.parse(out);
    for (const v of PAUSE_VARS) expect(env[v]).toBe('1');
  });
});

/**
 * THE RECEIVER, NOT THE CALLER — and the first version of this file got that wrong.
 *
 * It executed config.env with `set -a; . file`, which EXPANDS `${VAR:-1}`. The pipeline does not
 * source these files: lib/env-file.sh loads them as DATA, without evaluating, precisely so a bare
 * `cd` or a command substitution in a config file cannot run. So the test passed against a shell
 * feature the real loader does not have, and the `"${VAR:-1}"` form it blessed would have been
 * stored as the literal seven-character string — is_truthy reads that as FALSE, silently removing
 * both pauses from every launch that is not the dashboard.
 *
 * What actually makes the operator's answer win is PRESERVE mode, which the loader already had:
 * a key already set in the environment is skipped entirely. So the project file keeps a plain
 * `=1` and the fix lives where it belongs — buildLaunchEnv exporting the answer, including "no".
 */
describe('a project default yields to the launch that already decided', () => {
  const configs = projectConfigs();
  const LOADER = join(REPO, 'orchestrations/scripts/lib/env-file.sh');

  it('there are project configs to check', () => {
    expect(configs.length, 'no project config.env found — the cases below would be vacuous')
      .toBeGreaterThan(0);
  });

  /** Load a config the way the PIPELINE loads it, and read back what survived. */
  function throughRealLoader(file: string, exported: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'pause-default-'));
    try {
      const probe = join(dir, 'probe.sh');
      writeFileSync(probe, [
        '#!/bin/bash', 'set -uo pipefail',
        `. ${JSON.stringify(LOADER)}`,
        ...Object.entries(exported).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
        // preserve: the mode every launcher actually uses (load_project_env ... preserve).
        `load_env_file_safe ${JSON.stringify(file)} preserve`,
        ...PAUSE_VARS.map((v) => `printf '%s=[%s]\n' ${v} "\${${v}:-<unset>}"`),
      ].join('\n'));
      return execFileSync('bash', [probe], { encoding: 'utf8', timeout: 30_000, cwd: dir });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it.each(configs)('$project keeps the launch\'s answer', ({ file }) => {
    const declared = PAUSE_VARS.filter((v) =>
      new RegExp(`^\\s*(export\\s+)?${v}=`, 'm').test(readFileSync(file, 'utf8')));
    if (declared.length === 0) return;

    const out = throughRealLoader(file, Object.fromEntries(declared.map((v) => [v, '0'])));
    for (const v of declared) {
      expect(out, [
        `${v} did not survive the project config load. The operator said no and the project file`,
        'talked them out of it — the live 2026-09-04 report, "I set neither yet the run paused".',
      ].join('\n')).toContain(`${v}=[0]`);
    }
  });

  it.each(configs)('$project still supplies its own default when the launch says nothing', ({ file }) => {
    // THE HALF THE FIRST VERSION OF THIS FILE BROKE. A `"${VAR:-1}"` form is stored LITERALLY by
    // this loader, so an unset variable became the string "${VAR:-1}" and is_truthy read it as
    // false — both pauses silently gone on every CLI launch.
    const declared = PAUSE_VARS.filter((v) =>
      new RegExp(`^\\s*(export\\s+)?${v}=`, 'm').test(readFileSync(file, 'utf8')));
    if (declared.length === 0) return;

    const out = throughRealLoader(file, {});
    for (const v of declared) {
      expect(out, [
        `${v} was loaded as something other than a usable value with nothing exported.`,
        'A config file is DATA to this loader — it is never evaluated — so a shell-expansion form',
        'is stored verbatim and every truthiness test on it fails.',
      ].join('\n')).toMatch(new RegExp(`${v}=\\[(0|1|true|false)\\]`));
    }
  });
});
