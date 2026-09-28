/**
 * A SET'S DECLARED PYTHON ENVIRONMENT, FOR A FIXTURE INSTALL.
 *
 * install.sh builds `pythonEnv` (config/provider-sets.json) at its declared path under the install:
 * `python3 -m venv` + `pip install <packages>`. A fixture install is extracted, not installed, so the
 * same declaration is built here — once per package list, cached — and linked in at the declared
 * path, where the runner reads it. Nothing is named here: no set, no package.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../integration/lib/fixture-install';

/** The set's declaration, built once into the cache; returns [declared path, built env] or null when none is declared. */
export function builtPythonEnv(install: string, set: string): { path: string; env: string } | null {
  const reg = JSON.parse(readFileSync(join(install, 'orchestrations/config/provider-sets.json'), 'utf8'));
  const decl = reg.sets?.[set]?.pythonEnv;
  if (!decl?.path) return null;
  const pkgs: string[] = decl.packages || [];
  const cache = join(ROOT, 'test-results/.python-envs', createHash('sha256').update(pkgs.join('\n')).digest('hex').slice(0, 16));
  if (!existsSync(join(cache, 'bin/python'))) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(dirname(cache), { recursive: true });
    execFileSync('python3', ['-m', 'venv', cache], { stdio: 'ignore' });
    if (pkgs.length) execFileSync(join(cache, 'bin/python'), ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', ...pkgs], { stdio: 'ignore', timeout: 600_000 });
  }
  return { path: decl.path, env: cache };
}

/** Build the set's declared environment and link it in at its declared path under the install. */
export function provisionPythonEnv(install: string, set: string): string | null {
  const b = builtPythonEnv(install, set);
  if (!b) return null;
  const at = join(install, b.path);
  mkdirSync(dirname(at), { recursive: true });
  if (!existsSync(at)) symlinkSync(b.env, at);
  return at;
}
