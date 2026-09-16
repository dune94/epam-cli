/**
 * THE WHOLE PROGRAM, AS TEXT, FOR A TEST THAT READS A SPLIT MAIN.
 *
 * claude.sh and run-agent-orchestration.sh were split into lib/ modules on 2026-09-16
 * (tools/split-main-into-modules.py; proven by a-split-main-is-the-same-program.test.ts).
 * Hundreds of tests read those files as TEXT — to lift a function by name and execute it, or to
 * assert a message sits where it did. Each would now see an entrypoint that `source`s the rest.
 *
 * engineSource(main) reassembles the ORIGINAL text — the same bytes the monolith had — from the
 * split's layout record (tools/split-maps/<main>.golden.json: kept runs of main lines and moved
 * functions, in their original order) and the CURRENT module files (so an edit to a module is
 * seen). engineSourceFile(main) writes it beside the real file (gitignored) for tests that lift
 * with awk/sed in a shell (under the OS temp dir). Neither is for EXECUTING the main — bash runs the real file.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const FN = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/;

/** Every column-0 function of a module, with the comment block above it, keyed by name. A
 * definition ends where the brace count returns to zero AND bash accepts the slice — braces in
 * strings fool the count alone. Same lifter as a-split-main-is-the-same-program.test.ts. */
function functionsWithComments(path: string): Map<string, string> {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = FN.exec(lines[i]);
    if (!m) continue;
    let k = i;
    while (k - 1 >= 0 && lines[k - 1].startsWith('#')) k -= 1;
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j += 1) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth <= 0 && spawnSync('bash', ['-n'], { input: `${lines.slice(i, j + 1).join('\n')}\n` }).status === 0) { end = j; break; }
    }
    if (end < 0) throw new Error(`no parseable end for ${m[1]} in ${path}`);
    out.set(m[1], lines.slice(k, end + 1).join('\n'));
    i = end;
  }
  return out;
}

export function engineSource(mainPath: string): string {
  const maps = join(dirname(mainPath), 'tools/split-maps');
  const goldenPath = join(maps, `${basename(mainPath)}.golden.json`);
  if (!existsSync(goldenPath)) return readFileSync(mainPath, 'utf8');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { layout: ({ keep: number } | { source: string } | { fn: string })[] };
  const map = JSON.parse(readFileSync(join(maps, `${basename(mainPath)}.json`), 'utf8')) as Record<string, string[]>;
  const moduleOf = new Map<string, string>();
  for (const [mod, names] of Object.entries(map)) for (const n of names) moduleOf.set(n, mod);
  const bodies = new Map<string, Map<string, string>>();
  const body = (fn: string) => {
    const mod = moduleOf.get(fn);
    if (!mod || mod === '.') throw new Error(`${fn} is not a moved function of ${basename(mainPath)}`);
    if (!bodies.has(mod)) bodies.set(mod, functionsWithComments(join(dirname(mainPath), 'lib', `${mod}.sh`)));
    const b = bodies.get(mod)!.get(fn);
    if (b === undefined) throw new Error(`${fn} is missing from lib/${mod}.sh`);
    return b;
  };
  // The main's lines minus the inserted source lines are exactly the kept runs, in order.
  const splitSources = new Set(Object.keys(map).filter((m) => m !== '.').map((m) => `source "$SCRIPT_DIR/lib/${m}.sh"`));
  const kept = readFileSync(mainPath, 'utf8').split('\n').filter((l) => !splitSources.has(l));
  const out: string[] = [];
  let at = 0;
  for (const item of golden.layout) {
    if ('keep' in item) { out.push(...kept.slice(at, at + item.keep)); at += item.keep; }
    else if ('fn' in item) out.push(body(item.fn));
  }
  return out.join('\n');
}

export function engineSourceFile(mainPath: string): string {
  // OUTSIDE the scripts tree: a copy under orchestrations/scripts/.inlined was found by every
  // scanner that walks that tree — the shell-defect scan ran shellcheck over two extra 12k-line
  // monoliths and was OOM-killed under the memory cap.
  const dir = join(tmpdir(), 'epam-inlined');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, basename(mainPath));
  writeFileSync(out, engineSource(mainPath));
  return out;
}
