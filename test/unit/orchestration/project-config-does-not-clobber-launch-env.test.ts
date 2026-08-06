/**
 * A documented bypass that the config file silently overrides is not a bypass.
 *
 * Live AMSD-2041 2026-07-30. The run was launched with
 * SKIP_REGRESSION_GUARD=true, explicitly, to get past two genuinely failing
 * tests on the client's own `develop`. The guard failed the lane anyway, and
 * the run's own banner said why:
 *
 *   SKIP bypass env vars active: ... SKIP_REGRESSION_GUARD=false
 *
 * The guard code was never at fault — run-agent-orchestration.sh reads the flag
 * correctly. tier3-metrolinx-run.sh sources the project's config.env AFTER the
 * launch environment is already set, and config.env assigns the flag
 * unconditionally:
 *
 *   SKIP_REGRESSION_GUARD=false
 *
 * so the project default overwrote the operator's explicit instruction. The
 * error message the guard prints on failure — "Bypass with:
 * SKIP_REGRESSION_GUARD=true" — was untrue for this project. It told the
 * operator to do something that could not work.
 *
 * THE RULE: a project config file supplies DEFAULTS. Anything already set in
 * the launch environment wins. `VAR="${VAR:-default}"` is the whole fix, and it
 * changes nothing when the variable is unset — the default still applies.
 *
 * Scoped deliberately to the bypass flags. The rest of config.env (models,
 * ladders, timeouts) is authoritative project configuration that SHOULD beat a
 * stray inherited value; these flags are different because their entire purpose
 * is to be set at launch time, and the pipeline advertises them as such.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');

/**
 * EVERY env file the launcher may source, discovered by walking — not a list.
 *
 * The first version of this test looked only at orchestrations/projects/&#42;/config.env.
 * It went green while the run was still broken, because a SECOND unconditional
 * assignment sat in orchestrations/jira/metrolinx.env, and a third in
 * orchestrations/jira/.env. The launcher sources all of them, last one wins.
 *
 * Scoping a search to the directory where the bug was first seen is how the
 * same bug survives its own fix.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name.startsWith('.git')) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name.endsWith('.env')) out.push(p);
  }
  return out;
}

// TRACKED files only. An untracked .env is an operator's own machine config,
// not something this repo ships and not something a test may quietly rewrite.
// (Untracked files can still carry the unsupported `${VAR:-default}` idiom —
// the data loader takes values LITERALLY, so such a line yields the string
// "${VAR:-default}". That is reported to the operator, not silently fixed.)
const TRACKED = new Set(
  execFileSync('git', ['-C', join(__dirname, '../../../'), 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((f) => join(__dirname, '../../../', f)),
);
const CONFIGS = walk(ORCH).filter((f) => TRACKED.has(f));

/**
 * Load the config the way the launcher ACTUALLY does and report what the
 * variable ends up as.
 *
 * 2026-08-06: this used to run `set -a; source <config>` — but a config file is
 * DATA and the launchers no longer execute one (this repo's own .env begins with
 * a bare `cd`, which relocated every sourcing script to $HOME). Loading is now
 * `load_env_file_safe <file> preserve`, where "preserve" means an already-set,
 * non-empty value is not overwritten — the same semantics the old
 * `VAR="${VAR:-default}"` idiom provided, without evaluating the file.
 *
 * This still EXECUTES the real loader against the real config file; it does not
 * pattern-match the assignment, so a fix that looks right but behaves wrong
 * still fails here.
 */
function sourced(config: string, name: string, launchEnv?: string): string {
  const LOADER = join(__dirname, '../../../orchestrations/scripts/lib/env-file.sh');
  const r = spawnSync(
    'bash',
    ['-c', `. ${JSON.stringify(LOADER)}; load_env_file_safe ${JSON.stringify(config)} preserve >/dev/null 2>&1; printf '%s' "\${${name}-<unset>}"`],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: launchEnv === undefined
        ? { ...process.env, [name]: undefined } as NodeJS.ProcessEnv
        : { ...process.env, [name]: launchEnv },
    },
  );
  return (r.stdout || '').trim();
}

/** The bypass flags the pipeline tells operators to set at launch time. */
const BYPASS_FLAGS = ['SKIP_REGRESSION_GUARD'];

describe('a launch-time bypass survives the project config', () => {
  for (const config of CONFIGS) {
    const project = config.split('/').slice(-2).join('/');

    for (const flag of BYPASS_FLAGS) {
      const declared = readFileSync(config, 'utf8').match(new RegExp(`^\\s*${flag}=`, 'm'));
      if (!declared) continue; // the project does not set it — nothing to clobber

      it(`${project}: ${flag}=true set at launch is not overwritten`, () => {
        expect(
          sourced(config, flag, 'true'),
          `${project}/config.env overwrote an explicit launch-time ${flag}=true. ` +
          'The guard then blocked the run while its own error message advised ' +
          'setting exactly this variable.',
        ).toBe('true');
      });

      it(`${project}: ${flag}=false set at launch is not overwritten`, () => {
        // The clobber is symmetric: a project that defaults the flag ON would
        // equally ignore an operator turning it OFF.
        expect(sourced(config, flag, 'false')).toBe('false');
      });

      it(`${project}: still applies its own default when nothing is set`, () => {
        // The fix must not delete the project's configured default — an unset
        // launch environment has to keep reading exactly what the file declares.
        const literal = readFileSync(config, 'utf8')
          .match(new RegExp(`^\\s*${flag}=(.*)$`, 'm'))![1];
        const want = (literal.match(/:-([^}"']*)/) || [, literal.replace(/["']/g, '')])[1];
        expect(
          sourced(config, flag),
          'the project default was lost — a config that supplies nothing is not a config',
        ).toBe(want.trim());
      });
    }
  }
});

describe('the composed launch environment, not one file at a time', () => {
  // Per-file assertions missed the live defect once already: config.env was
  // clean and the run still ignored the flag, because a different file sourced
  // later reset it. The launcher sources several in sequence and the last write
  // wins, so the property that actually matters is about the WHOLE chain.
  //
  // Order-independent by construction: sourcing every discovered file together
  // fails if ANY one of them clobbers, whatever the real sequence turns out to
  // be — so this keeps holding when a launcher adds or reorders its sources.
  for (const flag of BYPASS_FLAGS) {
    it(`${flag}=true survives sourcing every env file together`, () => {
      // Loaded the way the launchers now do: as DATA, in preserve mode. A
      // config file is never executed (this repo's own .env starts with a bare
      // `cd`). Preserve mode is what makes an already-set launch value win.
      const LOADER = join(__dirname, '../../../orchestrations/scripts/lib/env-file.sh');
      const script = CONFIGS.map((c) => `load_env_file_safe ${JSON.stringify(c)} preserve >/dev/null 2>&1 || true`).join('\n');
      const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LOADER)}\n${script}\nprintf '%s' "\${${flag}-<unset>}"`], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, [flag]: 'true' },
      });
      expect(
        (r.stdout || '').trim(),
        `some env file under orchestrations/ overwrote an explicit ${flag}=true. ` +
        'Run: grep -rn --include="*.env" "^\\s*' + flag + '=" orchestrations/ | grep -v ":-"',
      ).toBe('true');
    });
  }
});

describe('the discovery itself is sound', () => {
  it('found at least one project config to check', () => {
    // A test that silently checks nothing passes forever. This is the guard.
    expect(CONFIGS.length, 'no project config.env files were discovered').toBeGreaterThan(0);
  });

  it('found at least one project that declares a bypass flag', () => {
    const declaring = CONFIGS.filter((c) => {
      const src = readFileSync(c, 'utf8');
      return BYPASS_FLAGS.some((f) => new RegExp(`^\\s*${f}=`, 'm').test(src));
    });
    expect(declaring.length, 'every per-flag assertion above was skipped').toBeGreaterThan(0);
  });
});
