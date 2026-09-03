/**
 * A PROVIDER SET IS DECLARED IN CONFIG. THE ENGINE NAMES NONE OF THEM.
 *
 * The hot-swap requirement (C0): if CodeMie tokens run out mid-programme, the openrouter
 * stack must be back on the air in SECONDS — one env var, no build, no test run, no git.
 *
 * That only holds if selecting a set is a lookup, not a branch. A `case` statement naming
 * "openrouter" and "codemie" would put set names in code, and adding a third set would be an
 * engine change — the same defect B6 removed for ladders, one layer up.
 *
 * So the sets, and WHICH ONE IS DEFAULT, live in a declaration file. The engine reads it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/config/provider-sets.json');
const ENGINE_DIRS = [join(ROOT, 'orchestrations/scripts')];

function engineFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'test') walk(p); }
      else if (/\.(sh|js)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ENGINE_DIRS) if (existsSync(d)) walk(d);
  return out;
}

describe('a provider set is declared, not named in code', () => {
  it('the registry exists and declares a default plus at least one set', () => {
    expect(existsSync(REGISTRY), 'orchestrations/config/provider-sets.json is missing').toBe(true);
    const j = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(j.defaultSet, 'registry declares no defaultSet').toBeTruthy();
    expect(Object.keys(j.sets || {}).length).toBeGreaterThan(0);
    expect(Object.keys(j.sets), 'defaultSet must be one of the declared sets').toContain(j.defaultSet);
  });

  it('every declared set names a settings file and a project env suffix', () => {
    const j = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    for (const [name, cfg] of Object.entries<any>(j.sets)) {
      expect(cfg.settingsFile, `${name}: no settingsFile`).toBeTruthy();
      expect(cfg.projectEnvSuffix, `${name}: no projectEnvSuffix`).toBeTruthy();
    }
  });

  it('NO engine script BRANCHES on which provider set is active', () => {
    // The invariant is about CONTROL FLOW, not vocabulary.
    //
    // This asserted that no set NAME appears anywhere in engine code, which broke the moment a
    // set was named after the provider it runs: `claude` is both a set and a runner, and
    // llm-handler.sh must branch on the RUNNER — that is its job. A test that cannot tell those
    // apart reports the dispatch arm as a defect and hides real ones in the noise.
    //
    // What must never happen is an engine script asking WHICH SET is active and behaving
    // differently — that is how a set stops being data. The free-run seal did exactly this
    // (it inferred a mock from runner names) and would have scrubbed a real stack's credentials.
    const files = engineFiles();
    expect(files.length, 'found no engine files — this test would pass vacuously').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\*)/.test(line)) return;           // comments may discuss sets by name
        if (!/EPAM_PROVIDER_SET/.test(line)) return;
        // reading the variable is fine; COMPARING it to a literal is the branch
        if (/EPAM_PROVIDER_SET[^\n]*(==|=~|!=|===)\s*["'`]?[a-z]/i.test(line)
            || /["'`]\$\{?EPAM_PROVIDER_SET\}?["'`]?\s*(==|===|!=)/.test(line)
            || /case\s+"?\$\{?EPAM_PROVIDER_SET/.test(line)) {
          offenders.push(`${f.replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
    expect(offenders,
      'these branch on which provider set is active. A set is DATA the engine reads, never a '
      + 'condition it tests — that is what makes swapping stacks a config edit.').toEqual([]);
  });

  it('the default set resolves without EPAM_PROVIDER_SET being set', () => {
    const j = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const f = join(ROOT, 'orchestrations/config', j.sets[j.defaultSet].settingsFile);
    expect(existsSync(f), `default set's settings file missing: ${f}`).toBe(true);
  });
});
