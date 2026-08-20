/**
 * 114 call sites now run a handler by path. A path that does not resolve is the one failure this
 * change can produce at scale, and it is invisible: 60 of those sites end in
 * `2>/dev/null || echo "<fallback>"`, so a missing handler prints nothing, exits non-zero, and the
 * caller carries on with the fallback as if it were an answer. That is how a scaled timeout
 * silently becomes an unscaled one.
 *
 * These tests resolve every referenced path against the calling script's own location, the way the
 * shell will, and require the file to exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

function shellFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== 'handlers') shellFiles(p, acc);
    } else if (name.endsWith('.sh')) acc.push(p);
  }
  return acc;
}

type Ref = { file: string; line: number; raw: string; resolved: string };

/**
 * What `$SCRIPT_DIR` is when THIS file's lines run — which is not always the file's own directory.
 *
 *  - A script that assigns it gets what it assigns, including a `/..` suffix: tools/ scripts sit one
 *    level down and point back up.
 *  - A file that assigns nothing is SOURCED, so `$SCRIPT_DIR` belongs to whoever sourced it.
 *    lib/story-guards.sh states that as a requirement in its header, and every caller is in
 *    scripts/.
 *
 * Assuming "own directory" for all three shapes reported the two sourced/tools cases as broken when
 * they resolve correctly at runtime.
 */
function scriptDirOf(file: string): string {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/^SCRIPT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)(\/[^"]*)?" && pwd\)"/m);
  if (m) return resolve(dirname(file), `.${m[1] || ''}`);
  return SCRIPTS;                    // sourced: the caller's SCRIPT_DIR, and every caller is here
}

/** Every `lib/handlers/<name>.<ext>` mentioned in a shell script, with the path the shell reaches. */
function handlerRefs(): Ref[] {
  const refs: Ref[] = [];
  for (const file of shellFiles(SCRIPTS)) {
    const base = scriptDirOf(file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      // TWO SHAPES. A script that is SOURCED resolves handlers from its caller's $SCRIPT_DIR; one
      // that is EXECUTED resolves them from its own BASH_SOURCE, because $SCRIPT_DIR may not be set
      // at all. lib/codeline-health.sh is executed, and reporting its handler as unreached was the
      // guard not knowing the second shape.
      // THE SHAPES THAT ACTUALLY OCCUR, not the two this started with.
      //
      // It matched `${SCRIPT_DIR}/lib/handlers/X` and a BASH_SOURCE form, and nothing else — so
      // `${SCRIPT_DIR:-}/lib/handlers/X` (the `:-` default breaks `\}?`) and a repo-relative
      // `orchestrations/scripts/lib/handlers/X` both read as "nothing reaches this handler". Four
      // live, working call sites were reported as orphans. A scan scoped to one spelling of a path
      // finds exactly the call sites written in that spelling.
      const matches = [
        ...line.matchAll(/(?:\$\{?SCRIPT_DIR[^}\/]*\}?|orchestrations\/scripts)\/((?:\.\.\/)*lib\/handlers\/[\w.-]+\.(?:py|js))/g),
        ...line.matchAll(/dirname "\$\{BASH_SOURCE\[0\]\}"\)\/(handlers\/[\w.-]+\.(?:py|js))/g),
      ];
      for (const m of matches) {
        refs.push({
          file: relative(ROOT, file),
          line: i + 1,
          raw: m[0],
          // A BASH_SOURCE reference is relative to the file itself; a SCRIPT_DIR one to the
          // directory that script treats as its root.
          resolved: m[1].startsWith('handlers/')
            ? resolve(dirname(file), m[1])
            : resolve(base, m[1]),
        });
      }
    });
  }
  return refs;
}

describe('every handler call resolves to a file', () => {
  const refs = handlerRefs();

  it('finds the call sites — it is not matching nothing', () => {
    // Without this the whole file passes vacuously the day the pattern stops matching.
    expect(refs.length, 'no handler call site was found at all').toBeGreaterThan(50);
  });

  it('no script invokes a handler that does not exist', () => {
    const broken = refs.filter((r) => !existsSync(r.resolved));
    expect(broken.map((r) => `${r.file}:${r.line} -> ${relative(ROOT, r.resolved)}`),
      `${broken.length} call site(s) point at a handler that is not there. Each one runs its `
      + `fallback instead, which looks like an answer:`,
    ).toEqual([]);
  });

  it('every handler on disk is named by at least one call site or imported by another handler', () => {
    // The other direction: a handler nothing reaches means the code it replaced is still what runs.
    const dir = join(SCRIPTS, 'lib/handlers');
    const onDisk = readdirSync(dir).filter((f) => /\.(py|js)$/.test(f));
    const named = new Set(refs.map((r) => r.resolved.split('/').pop()!));

    // A handler passed BY NAME to a caller that builds the path itself — preflight-static.sh's
    // ratchet takes the scanner filename as an argument — is named at its call site even though no
    // path literal appears there. This direction of the check asks "does anything reach it", and a
    // bare filename in an engine script is a reference.
    for (const f of shellFiles(SCRIPTS)) {
      let src = '';
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      for (const h of onDisk) if (src.includes(`"${h}"`) || src.includes(`'${h}'`)) named.add(h);
    }

    for (const h of onDisk) {
      const src = readFileSync(join(dir, h), 'utf8');
      for (const m of src.matchAll(/^\s*(?:from\s+([A-Za-z_]\w*)\s+import|import\s+([A-Za-z_]\w*))/gm)) {
        named.add(`${m[1] || m[2]}.py`);
      }
      for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+?)(?:\.js)?['"]\)/g)) named.add(`${m[1]}.js`);
    }

    const orphans = onDisk.filter((h) => !named.has(h));
    expect(orphans, `${orphans.length} handler(s) nothing reaches:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('no handler is referenced by a path that leaves the handlers directory', () => {
    const dir = join(SCRIPTS, 'lib/handlers');
    const escaping = refs.filter((r) => !r.resolved.startsWith(dir + '/'));
    expect(escaping.map((r) => `${r.file}:${r.line} -> ${r.resolved}`),
      'a call site resolves outside lib/handlers, so it depends on a relative path that may move',
    ).toEqual([]);
  });
});
