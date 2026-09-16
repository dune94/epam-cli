/**
 * A SPLIT MAIN IS THE SAME PROGRAM — AND STAYS SPLIT.
 *
 * claude.sh was 12,503 lines and 158 functions in one file; run-agent-orchestration.sh 11,261
 * and 88. Shellcheck needed 2.9–3.6 GB for either and was OOM-killed under the host's memory cap
 * the moment their bytes changed (2026-09-15), every fix landed in the same file, and no file of
 * that size is reviewable. tools/split-main-into-modules.py MOVES every function, verbatim, into
 * lib/<module>.sh as tools/split-maps/<main>.json says, and records each body in a golden.
 *
 * The move was proven byte for byte at the split commit (2309941f). Modules are edited after it
 * — that is the point of the split — so this guards the STRUCTURE, not the bytes:
 *   1. every function the golden names exists, once, in the module the map names;
 *   2. the main defines no function but its entrypoint;
 *   3. no file — main or module — exceeds the declared ceiling, and the ceiling is a declaration
 *      (tools/split-maps/ceilings.json), not a number in this test.
 * A later fix that appends a function to a main, or grows a module past its ceiling, fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const MAPS = join(SCRIPTS, 'tools/split-maps');
const FN = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/;

/** Column-0 functions of a file, ended where bash accepts the slice as a complete definition. */
function functionsOf(path: string): Map<string, string> {
  // The REAL file, never the reassembled text: this test is about where the bytes live.
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = FN.exec(lines[i]);
    if (!m) continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j += 1) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth <= 0 && spawnSync('bash', ['-n'], { input: `${lines.slice(i, j + 1).join('\n')}\n` }).status === 0) { end = j; break; }
    }
    if (end < 0) throw new Error(`no parseable end for ${m[1]} in ${path}`);
    out.set(m[1], lines.slice(i, end + 1).join('\n'));
    i = end;
  }
  return out;
}

const splits = readdirSync(MAPS).filter((f) => f.endsWith('.golden.json')).map((f) => f.replace(/\.golden\.json$/, ''));
const ceilings = JSON.parse(readFileSync(join(MAPS, 'ceilings.json'), 'utf8')) as { mainLines: Record<string, number>; moduleLines: number };

describe('a split main is the same program, and stays split', () => {
  it('there is at least one split to check', () => { expect(splits.length).toBeGreaterThan(0); });

  for (const main of splits) {
    const golden = JSON.parse(readFileSync(join(MAPS, `${main}.golden.json`), 'utf8')).functions as Record<string, string>;
    const map = JSON.parse(readFileSync(join(MAPS, `${main}.json`), 'utf8')) as Record<string, string[]>;
    const fileOf = (mod: string) => (mod === '.' ? join(SCRIPTS, main) : join(SCRIPTS, 'lib', `${mod}.sh`));

    it(`${main}: every function the golden names is in the module the map names, once`, () => {
      const seen = new Map<string, string>();
      for (const [mod, names] of Object.entries(map)) {
        const path = fileOf(mod);
        expect(existsSync(path), `${path} is missing`).toBe(true);
        const fns = functionsOf(path);
        for (const n of names) {
          expect(fns.has(n), `${n} is not defined in ${path}`).toBe(true);
          expect(seen.has(n), `${n} is defined twice (${seen.get(n)} and ${mod})`).toBe(false);
          seen.set(n, mod);
        }
      }
      expect([...seen.keys()].sort()).toEqual(Object.keys(golden).sort());
    });

    it(`${main}: the main defines nothing but its entrypoint`, () => {
      const kept = new Set(map['.'] || []);
      const fns = functionsOf(join(SCRIPTS, main));
      expect([...fns.keys()].filter((n) => !kept.has(n)), 'a function was added to the main — put it in a module').toEqual([]);
    });

    it(`${main}: the reassembled text is the original program — every kept line and every function, in order`, () => {
      // test/lib/engine-source.ts is what every text-reading test now sees; it must be the
      // pre-split file exactly: the layout's kept runs from the main, the goldens' bodies with
      // their comment blocks, in the recorded order.
      const g = JSON.parse(readFileSync(join(MAPS, `${main}.golden.json`), 'utf8')) as { functions: Record<string, string>; comments: Record<string, string>; layout: ({ keep: number } | { source: string } | { fn: string })[] };
      const splitSources = new Set(Object.keys(map).filter((m) => m !== '.').map((m) => `source "$SCRIPT_DIR/lib/${m}.sh"`));
      const kept = readFileSync(join(SCRIPTS, main), 'utf8').split('\n').filter((l) => !splitSources.has(l));
      // Bodies come from the CURRENT modules (functions are edited after the move); order and the
      // kept lines come from the layout. The reassembled text must contain every kept line in
      // order and every function's current definition exactly once.
      const text = engineSource(join(SCRIPTS, main));
      let at = 0; let cursor = 0;
      for (const item of g.layout) {
        if ('keep' in item) {
          for (const line of kept.slice(at, at + item.keep)) { const i = text.indexOf(line, cursor); expect(i, `kept line missing or out of order: ${line.slice(0, 60)}`).toBeGreaterThanOrEqual(0); cursor = i + line.length; }
          at += item.keep;
        } else if ('fn' in item) {
          const i = text.indexOf(`${item.fn}()`, cursor); expect(i, `${item.fn} missing or out of order in the reassembled text`).toBeGreaterThanOrEqual(0); cursor = i;
        }
      }
      for (const n of Object.keys(g.functions)) expect((text.match(new RegExp(`^${n}\\(\\)\\s*\\{`, 'gm')) || []).length, `${n} defined more than once`).toBe(1);
    });

    it(`${main}: the main and every module are under the declared ceilings`, () => {
      const lines = (p: string) => readFileSync(p, 'utf8').split('\n').length;
      expect(ceilings.mainLines[main], `no ceiling declared for ${main}`).toBeGreaterThan(0);
      expect(lines(join(SCRIPTS, main)), `${main} has grown`).toBeLessThanOrEqual(ceilings.mainLines[main]);
      for (const mod of Object.keys(map)) {
        if (mod === '.') continue;
        expect(lines(fileOf(mod)), `lib/${mod}.sh exceeds ${ceilings.moduleLines} lines — split it`).toBeLessThanOrEqual(ceilings.moduleLines);
      }
    });
  }
});
