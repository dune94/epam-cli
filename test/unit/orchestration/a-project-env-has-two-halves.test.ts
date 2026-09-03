/**
 * A PROJECT'S ENV HAS TWO HALVES: WHAT IS TRUE OF THE PROJECT, AND WHAT IS TRUE OF THE STACK.
 *
 * The hot swap needs the provider-dependent half to change with the set. `config.env` is
 * PARSED line by line, not executed (lib/env-file.sh), so a `source` line inside it would be
 * silently skipped — the selection has to live in the loader, and the loader is reached from
 * many call sites. So ONE place answers "which env files does this project have", and the
 * FILENAMES come from the registry, not from a literal in any script.
 *
 * THE DISJOINTNESS RULE: base and overlay must never declare the same key. Disjoint files make
 * load order irrelevant, so no caller has to know which wins. With overlap, the answer would
 * depend on which file loaded first AND on load_env_file_safe's `preserve` mode — the kind of
 * invisible coupling that produced skyscanner's partial-inheritance hazard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MOD = join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js');
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const PROJECTS = join(ROOT, 'orchestrations/projects');

function fresh() { delete require.cache[require.resolve(MOD)]; return require(MOD); }
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

/** Keys an env file assigns — the same shape load_env_file_safe accepts. */
function keysOf(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n')
    .map((l) => l.replace(/^\s+/, '').replace(/^export /, ''))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => l.slice(0, l.indexOf('=')));
}

const projects = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

describe('a project env has two halves', () => {
  it('NO SCRIPT spells a declared env filename — every caller asks, none guesses', () => {
    // A launcher that loads `<dir>/config.env` itself gets ONLY the base — the six
    // provider-dependent keys moved to the overlay would simply be MISSING for that path, and
    // nothing would fail: the run would proceed with no provider map and no fallback model.
    // That is the failure this whole layering exists to make impossible, so the assertion
    // covers every script, not just the library that resolves the names.
    const dir = join(ROOT, 'orchestrations/scripts');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'test') walk(f); }
        else if (/\.(sh|js)$/.test(e.name)) files.push(f);
      }
    };
    walk(dir);
    expect(files.length, 'found no scripts — this test would pass vacuously').toBeGreaterThan(10);

    const names = [REGISTRY.projectEnv.base]
      .concat(Object.values<any>(REGISTRY.sets)
        .map((c) => REGISTRY.projectEnv.overlay.replace('{set}', c.projectEnvSuffix)));

    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*(#|\/\/|\*)/.test(l))
        .join('\n');
      for (const n of names) {
        if (code.includes(n)) offenders.push(`${f.replace(ROOT + '/', '')}: spells '${n}'`);
      }
    }
    expect(offenders, 'these must call load_project_env instead').toEqual([]);
  });

  it('NO library spells a declared env filename — the registry is its only home', () => {
    // The fallback in env-file.sh once read `load_env_file_safe "$_dir/config.env"`. A literal
    // there is a SECOND home for the name: free to drift from the declared one with nothing
    // failing, which is the shape of every defect this layering removes.
    const libs = join(ROOT, 'orchestrations/scripts/lib');
    const files = readdirSync(libs).filter((f) => /\.(sh|js)$/.test(f));
    expect(files.length, 'found no library files — this test would pass vacuously').toBeGreaterThan(3);

    const names = [REGISTRY.projectEnv.base]
      .concat(Object.values<any>(REGISTRY.sets)
        .map((c) => REGISTRY.projectEnv.overlay.replace('{set}', c.projectEnvSuffix)));

    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(join(libs, f), 'utf8').split('\n')
        .filter((l) => !/^\s*(#|\/\/|\*)/.test(l))   // a comment may name the file
        .join('\n');
      for (const n of names) if (code.includes(n)) offenders.push(`${f}: spells '${n}'`);
    }
    expect(offenders).toEqual([]);
  });

  it('the registry declares both filenames, so no script holds them as literals', () => {
    expect(REGISTRY.projectEnv?.base).toBeTruthy();
    expect(REGISTRY.projectEnv?.overlay).toContain('{set}');
  });

  it('projectEnvFiles() names the base and the ACTIVE set overlay', () => {
    delete process.env.EPAM_PROVIDER_SET;
    const dir = join(PROJECTS, projects[0]);
    const f = fresh().projectEnvFiles(dir);
    const suffix = REGISTRY.sets[REGISTRY.defaultSet].projectEnvSuffix;
    expect(f.base).toBe(join(dir, REGISTRY.projectEnv.base));
    expect(f.overlay).toBe(join(dir, REGISTRY.projectEnv.overlay.replace('{set}', suffix)));
  });

  it('an UNKNOWN set throws here too — the two halves cannot disagree about the stack', () => {
    process.env.EPAM_PROVIDER_SET = 'not-a-declared-set';
    let msg = '';
    try { fresh().projectEnvFiles(join(PROJECTS, projects[0])); }
    catch (e: any) { msg = String(e.message || e); }
    expect(msg).toMatch(/not-a-declared-set/);
    expect(msg).toMatch(new RegExp(Object.keys(REGISTRY.sets)[0]));
  });

  for (const p of projects) {
    it(`${p}: base and overlay declare NO key in common`, () => {
      const dir = join(PROJECTS, p);
      const base = keysOf(join(dir, REGISTRY.projectEnv.base));
      for (const [name, cfg] of Object.entries<any>(REGISTRY.sets)) {
        const overlay = keysOf(join(dir, REGISTRY.projectEnv.overlay.replace('{set}', cfg.projectEnvSuffix)));
        const shared = overlay.filter((k) => base.includes(k));
        expect(shared, `${p}: '${name}' overlay repeats keys from the base — load order would decide`).toEqual([]);
      }
    });
  }

  it('every declared set has an overlay wherever ANY set has one — no half-provisioned project', () => {
    for (const p of projects) {
      const dir = join(PROJECTS, p);
      const present = Object.entries<any>(REGISTRY.sets)
        .map(([n, c]) => ({ n, f: join(dir, REGISTRY.projectEnv.overlay.replace('{set}', c.projectEnvSuffix)) }))
        .filter((x) => existsSync(x.f));
      if (present.length === 0) continue;   // a project may predate the split entirely
      const missing = Object.entries<any>(REGISTRY.sets)
        .filter(([, c]) => !existsSync(join(dir, REGISTRY.projectEnv.overlay.replace('{set}', c.projectEnvSuffix))))
        .map(([n]) => n);
      expect(missing, `${p} has overlays for some sets but not: ${missing.join(', ')} — swapping would half-configure it`).toEqual([]);
    }
  });
});
