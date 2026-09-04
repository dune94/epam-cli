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

describe('a project default yields to the launch that already decided', () => {
  const configs = projectConfigs();

  it('there are project configs to check', () => {
    expect(configs.length, 'no project config.env found — the cases below would be vacuous')
      .toBeGreaterThan(0);
  });

  // THE RECEIVER, NOT THE CALLER: execute the real config.env with the variable already exported,
  // exactly as the launcher does, and read back what survived.
  it.each(configs)('$project/config.env keeps a value the launch already set', ({ file }) => {
    const declared = PAUSE_VARS.filter((v) =>
      new RegExp(`^\\s*(export\\s+)?${v}=`, 'm').test(readFileSync(file, 'utf8')));
    if (declared.length === 0) return;   // this project states no opinion; nothing to override

    const dir = mkdtempSync(join(tmpdir(), 'pause-default-'));
    try {
      const probe = join(dir, 'probe.sh');
      writeFileSync(probe, [
        '#!/bin/bash',
        // The operator said NO. The project file must not talk them out of it.
        ...declared.map((v) => `export ${v}=0`),
        `set -a; . ${JSON.stringify(file)} >/dev/null 2>&1 || true; set +a`,
        ...declared.map((v) => `printf '%s=%s\\n' ${v} "\${${v}:-<unset>}"`),
      ].join('\n'));

      const out = execFileSync('bash', [probe], {
        encoding: 'utf8', timeout: 30_000,
        // config.env may reference the run's own environment; give it a sane cwd and nothing else.
        cwd: dir, env: { ...process.env },
      });

      for (const v of declared) {
        expect(out, [
          `${v} was reset by this project's config.env after the launch had already set it to 0.`,
          'A project default must be a DEFAULT — `VAR="${VAR:-1}"`, not `VAR=1`. As written, the',
          'dashboard can turn a pause ON and can never turn it OFF, which is the live 2026-09-04',
          'report: "I set neither yet the run paused".',
        ].join('\n')).toContain(`${v}=0`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
