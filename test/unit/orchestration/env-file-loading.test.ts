/**
 * LOADING .env MUST NOT RUN .env.
 *
 * Found 2026-08-05 while making the pre-launch assessment effective. The repo's own .env
 * begins with a bare `cd`, which in bash means "cd to $HOME". Every script that did
 *
 *     set -a; source "$REPO_ROOT/.env"; set +a
 *
 * therefore silently relocated its working directory to the home directory the moment it
 * loaded configuration — claude.sh (the agent invoker), orchestrate.sh, the ingest script,
 * five launchers and preflight-check.sh among them.
 *
 * The visible damage in preflight-check.sh: every check AFTER the .env load resolved its
 * relative paths against $HOME, so it reported LOG_DIR as unwritable, healing-events as
 * absent and snapshot-watch as dead — on a machine where all three were fine. Checks that
 * lie are worse than checks that are missing, and these had been lying in the only two
 * launchers wired to run them.
 *
 * A config file is DATA. Loading it must yield variables and nothing else: no cd, no
 * deletion, no network call, whatever a line happens to say.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/env-file.sh');

/** Load an env file via the shared loader and report the resulting cwd + a variable. */
function load(envContent: string, probe = 'MARKER') {
  const dir = mkdtempSync(join(tmpdir(), 'envf-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, envContent);
  const script = `
    set -euo pipefail
    . '${LIB}'
    cd '${dir}'
    load_env_file_safe '${envFile}'
    echo "CWD=$(pwd -P)"
    echo "VAL=\${${probe}:-<unset>}"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000, cwd: dir });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    dir,
    out,
    status: r.status,
    cwd: (out.match(/CWD=(.*)/) || [])[1],
    val: (out.match(/VAL=(.*)/) || [])[1],
  };
}

describe('the loader loads variables', () => {
  it('a plain assignment reaches the environment', () => {
    const r = load('MARKER=hello\n');
    expect(r.status, r.out).toBe(0);
    expect(r.val).toBe('hello');
  });

  it('quoted values keep their spaces, without the quotes', () => {
    const r = load('MARKER="two words"\n');
    expect(r.val).toBe('two words');
  });

  it('an `export KEY=value` line works — .env files commonly use it', () => {
    const r = load('export MARKER=exported\n');
    expect(r.val).toBe('exported');
  });

  it('a value containing = survives intact (URLs, JWTs, base64)', () => {
    const r = load('MARKER=a=b=c\n');
    expect(r.val).toBe('a=b=c');
  });

  it('comments and blank lines are ignored', () => {
    const r = load('# a comment\n\n  \nMARKER=after\n');
    expect(r.val).toBe('after');
  });

  it('a variable is EXPORTED, not merely set — child processes must see it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envx-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'MARKER=for-the-child\n');
    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail; . '${LIB}'; load_env_file_safe '${envFile}'; bash -c 'echo CHILD=$MARKER'`],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(`${r.stdout}${r.stderr}`).toMatch(/CHILD=for-the-child/);
  });
});

describe('the loader does NOT execute the file', () => {
  it('THE BUG: a bare `cd` does not move the working directory', () => {
    const r = load('cd\nMARKER=still-loaded\n');
    expect(r.status, r.out).toBe(0);
    expect(
      r.cwd,
      'this exact line is line 1 of this repo\'s .env, and it sent every script that ' +
        'loaded configuration to $HOME',
    ).toBe(r.dir);
    expect(r.val, 'variables after the offending line must still load').toBe('still-loaded');
  });

  it('an explicit `cd /` does not move it either', () => {
    const r = load('cd /\nMARKER=x\n');
    expect(r.cwd).toBe(r.dir);
  });

  it('a command line in the file does not run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envr-'));
    const envFile = join(dir, '.env');
    const victim = join(dir, 'must-survive.txt');
    writeFileSync(victim, 'intact');
    writeFileSync(envFile, `rm -f ${victim}\nMARKER=y\n`);
    spawnSync('bash', ['-c', `set -euo pipefail; . '${LIB}'; load_env_file_safe '${envFile}'`], {
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(
      existsSync(victim),
      'a config file that can delete files is a config file that will, eventually',
    ).toBe(true);
  });

  it('command substitution in a value is not evaluated', () => {
    const r = load('MARKER=$(echo executed)\n');
    expect(r.val, 'the literal text is the value; running it is not loading it').not.toBe('executed');
  });
});

describe('it is safe to call on anything', () => {
  it('a missing file is a no-op, not an error', () => {
    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail; . '${LIB}'; load_env_file_safe /nonexistent/.env; echo SURVIVED`],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(`${r.stdout}${r.stderr}`).toMatch(/SURVIVED/);
    expect(r.status).toBe(0);
  });

  it('under `set -euo pipefail`, an empty file does not abort the caller', () => {
    const r = load('');
    expect(r.status, r.out).toBe(0);
  });
});

describe('no loader in the pipeline sources a .env raw', () => {
  it('no script uses `source .env` / `. .env` directly', () => {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `grep -rnE '(^|;|&&|\\{)[[:space:]]*(source|\\.)[[:space:]]+"?[^"[:space:]]*\\.env"?' ` +
          `${join(__dirname, '../../../orchestrations/scripts')} --include='*.sh' ` +
          `| grep -v 'env-file.sh' | grep -vE ':[0-9]+:[[:space:]]*#' || true`,
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(
      (r.stdout || '').trim(),
      'each of these executes the config file. One bare `cd` in it relocates the whole ' +
        'pipeline to $HOME — use load_env_file_safe from lib/env-file.sh',
    ).toBe('');
  });
});
