/**
 * THE RECEIVER, NOT THE CALLER. Does the env a launcher actually ends up with contain the
 * half that moved?
 *
 * Six provider-dependent keys moved out of every config.env into the set overlay. A launcher
 * still loading only the base would lose ALL SIX — no provider map, no fallback model — and
 * nothing would fail: the run would proceed and pick models nobody chose. Asserting the call
 * appears in the source proves nothing; a call site can be commented out, dead, or ordered
 * before the library that defines it.
 *
 * So this EXECUTES the loader and reads the resulting environment.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const REG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const PROJECTS = join(ROOT, 'orchestrations/projects');
const NODE_BIN = process.execPath;

const keysOf = (f: string) =>
  !existsSync(f) ? [] :
  readFileSync(f, 'utf8').split('\n')
    .map((l) => l.replace(/^\s+/, '').replace(/^export /, ''))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => l.slice(0, l.indexOf('=')));

/** Run the real loader and return the environment it produced. */
function loadedEnv(projectDir: string, set?: string): Record<string, string> {
  const r = spawnSync('bash', ['-c', `
    . "${ROOT}/orchestrations/scripts/lib/env-file.sh"
    load_project_env "${projectDir}" >/dev/null 2>&1 || exit 3
    # NOT \`env\`: it yields NOTHING in some sandboxes — even for a variable exported one line
    # earlier — which would make every assertion below pass or fail for the wrong reason.
    # compgen -e enumerates the exported names from the shell itself.
    while IFS= read -r _k; do printf '%s=%s\n' "$_k" "\${!_k}"; done < <(compgen -e)
  `], { encoding: 'utf8', env: { ...process.env, NODE_BIN, ...(set ? { EPAM_PROVIDER_SET: set } : {}) } });
  if (r.status !== 0) return {};
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const projects = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name)
  .filter((p) => existsSync(join(PROJECTS, p, REG.projectEnv.base)));

describe('a launcher gets both halves', () => {
  it('there are projects with a base env — otherwise this suite is vacuous', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  for (const p of projects) {
    const dir = join(PROJECTS, p);
    const suffix = REG.sets[REG.defaultSet].projectEnvSuffix;
    const overlay = join(dir, REG.projectEnv.overlay.replace('{set}', suffix));

    it(`${p}: EVERY key the overlay declares arrives in the loaded env`, () => {
      const declared = keysOf(overlay);
      if (declared.length === 0) return;          // a project may predate the split
      const env = loadedEnv(dir);
      expect(Object.keys(env).length, 'the loader produced no environment at all').toBeGreaterThan(5);
      const missing = declared.filter((k) => !(k in env) || env[k] === '');
      expect(missing, `${p}: these moved keys never arrived — the run would pick models nobody chose`).toEqual([]);
    });

    it(`${p}: the base's keys still arrive too — the split lost nothing`, () => {
      const declared = keysOf(join(dir, REG.projectEnv.base));
      if (declared.length === 0) return;
      const env = loadedEnv(dir);
      const missing = declared.filter((k) => !(k in env));
      expect(missing, `${p}: base keys lost by the split`).toEqual([]);
    });
  }

  it('an unknown set yields NO environment — never a partial one', () => {
    const env = loadedEnv(join(PROJECTS, projects[0]), 'not-a-declared-set');
    expect(Object.keys(env).length, 'a refused set must load nothing at all').toBe(0);
  });
});
