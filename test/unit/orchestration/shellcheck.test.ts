/**
 * Shell script static analysis — runs shellcheck on every .sh file under
 * orchestrations/scripts/.  A failing test means a shell script has an error
 * (syntax, quoting, bad substitution, etc.) that shellcheck classifies as
 * severity=error.  Warnings are intentionally excluded to keep signal high.
 *
 * shellcheck binary: ~/.local/bin/shellcheck  (installed via curl from GitHub)
 */

import { execSync, spawnSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../');
const SCRIPTS_DIR = join(REPO_ROOT, 'orchestrations/scripts');
const SHELLCHECK = resolve(process.env.HOME ?? '/root', '.local/bin/shellcheck');

describe('shellcheck — orchestrations/scripts/', () => {
  beforeAll(() => {
    if (!existsSync(SHELLCHECK)) {
      throw new Error(
        `shellcheck not found at ${SHELLCHECK}. ` +
        'Install with: curl -sL https://github.com/koalaman/shellcheck/releases/download/stable/shellcheck-stable.linux.x86_64.tar.xz | tar -xJ --strip-components=1 -C ~/.local/bin shellcheck-stable/shellcheck'
      );
    }
  });

  const scripts = existsSync(SCRIPTS_DIR)
    ? readdirSync(SCRIPTS_DIR)
        .filter(f => f.endsWith('.sh'))
        .map(f => join(SCRIPTS_DIR, f))
    : [];

  it('should find shell scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const script of scripts) {
    it(`${script.replace(REPO_ROOT + '/', '')} has no shellcheck errors`, () => {
      const result = spawnSync(SHELLCHECK, ['--severity=error', script], {
        encoding: 'utf8',
        timeout: 10_000,
      });

      if (result.status !== 0) {
        const output = (result.stdout ?? '') + (result.stderr ?? '');
        throw new Error(
          `shellcheck errors in ${script.replace(REPO_ROOT + '/', '')}:\n${output}`
        );
      }
    });
  }
});
