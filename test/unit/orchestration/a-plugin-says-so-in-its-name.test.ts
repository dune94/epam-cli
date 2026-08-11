/**
 * A CONFIGURABLE FILE MUST BE IDENTIFIABLE AS ONE, FROM ITS NAME ALONE.
 *
 * Hardcoding is permitted in plugins and nowhere else. That rule is only enforceable if you can
 * tell, at a glance, whether the file you are reading is a plugin — and until now the only signal
 * was the directory. A path in a log line, a require() in a script, a stack frame, a grep result:
 * none of those carry the directory prominently, and `verification-plugin.js` reads exactly like
 * every other `-tools.js` helper in orchestrations/scripts/lib/.
 *
 * Operator, 2026-08-11: "If something is a plugin can you include plugin in the naming convention
 * so I know it is a configurable file?"
 *
 * So: every file in orchestrations/plugins/ ends with -plugin.js, and nothing outside that
 * directory may claim the suffix.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const PLUGIN_DIR = join(ROOT, 'orchestrations/plugins');

function pluginFiles(): string[] {
  return readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.js'));
}

describe('there are plugins to check — otherwise this passes vacuously', () => {
  it('the plugin directory is populated', () => {
    expect(pluginFiles().length).toBeGreaterThan(3);
  });
});

describe('EVERY PLUGIN SAYS SO IN ITS NAME', () => {
  it('every .js file in the plugin directory ends with -plugin.js', () => {
    const wrong = pluginFiles().filter((f) => !f.endsWith('-plugin.js'));
    expect(
      wrong,
      'hardcoding is permitted in plugins and nowhere else — that rule is only checkable if a ' +
      'plugin is identifiable from its name, not just from the directory it happens to sit in',
    ).toEqual([]);
  });

  it('nothing outside the plugin directory claims the suffix', () => {
    // A -plugin.js under scripts/ or lib/ would inherit the hardcoding licence by name while
    // sitting in engine code, which is the inverse of the point.
    const offenders: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { if (full !== PLUGIN_DIR) walk(full, depth + 1); }
        else if (name.endsWith('-plugin.js')) offenders.push(full.replace(ROOT, ''));
      }
    };
    walk(join(ROOT, 'orchestrations'), 0);
    expect(offenders, 'a plugin-named file outside orchestrations/plugins/').toEqual([]);
  });
});

describe('NO STALE REFERENCE TO A PRE-RENAME NAME SURVIVES', () => {
  /**
   * A rename that misses a reference fails at RUNTIME, in a path that is usually guarded — the
   * verification helper answers "plugin missing" and returns 2, which reads as a check failure on
   * a project that is fine. That happened today from a different cause and took an hour to find.
   */
  it('nothing references the old -tools.js plugin names', () => {
    // Built from parts so a future project-wide rename cannot silently rewrite this list into
    // the NEW names — which is exactly what happened during the 2026-08-11 rename: the sed
    // updated the test's own "old names" array, and it began asserting that nothing may
    // reference the names everything now uses.
    const SUFFIX = ['-', 'tools', '.js'].join('');
    const OLD = ['verification', 'dependency-scan', 'dependency-contract',
                 'codegraph', 'codeline-context', 'secret-scan'].map((n) => n + SUFFIX);
    const hits: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 5) return;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'logs') continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.(js|ts|sh|json)$/.test(name)) continue;
        let body = '';
        try { body = readFileSync(full, 'utf8'); } catch { continue; }
        for (const old of OLD) {
          if (body.includes(old)) hits.push(`${full.replace(ROOT, '')} -> ${old}`);
        }
      }
    };
    walk(join(ROOT, 'orchestrations'), 0);
    walk(join(ROOT, 'test'), 0);
    walk(join(ROOT, 'src'), 0);
    expect(hits, 'a missed reference resolves to nothing and degrades to a guarded failure').toEqual([]);
  });
});
