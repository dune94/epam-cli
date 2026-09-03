/**
 * RETEST OF 5670537 AND d671b1d — nine evidence windows named across two commits, no test added.
 *
 * Both readers REFUSE an unknown window rather than defaulting (asserted already in
 * an-evidence-window-is-declared.test.ts). That is the right behaviour and it makes the reverse
 * property load-bearing: a call site naming a window nobody declared does not quietly use a
 * default, it throws — at whatever point in a run that line is reached.
 *
 * These windows are not cosmetic. Each decides what the agent fixing a story is allowed to SEE:
 * test output on failure, new type errors, lint violations in changed files, the failure payload
 * fed back on rejection, the raw output kept on a quarantined KB record. A window that throws at
 * the moment it is read takes the evidence with it.
 *
 * So this asserts the whole set at once: whatever a caller names, the declaration has it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const DECLARATION = join(__dirname, '../../../orchestrations/config/evidence-windows.json');

const declared = new Set<string>(
  Object.keys(JSON.parse(readFileSync(DECLARATION, 'utf8')).windows || {})
    .filter((k) => !k.startsWith('$')),
);

/** Every .sh and .js file under orchestrations/scripts. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(sh|js)$/.test(e)) out.push(p);
  }
  return out;
}

/** Window names any caller asks for, in either the shell or the JS reader's spelling. */
function namesUsed(): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  for (const f of sources(SCRIPTS)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/evidence_window\s+(?:"|')?([A-Za-z][A-Za-z0-9_]*)/g)) {
      found.push({ file: f, name: m[1] });
    }
    for (const m of src.matchAll(/evidenceWindow\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g)) {
      found.push({ file: f, name: m[1] });
    }
  }
  return found;
}

describe('every window a caller names is declared', () => {
  it('the declaration is populated, and callers exist — otherwise this proves nothing', () => {
    expect(declared.size, 'no windows are declared').toBeGreaterThan(10);
    expect(namesUsed().length, 'no caller asks for a window; the sweep found nothing')
      .toBeGreaterThan(5);
  });

  it('no caller names a window the declaration does not have', () => {
    // An undeclared name does not fall back — both readers refuse it — so this is a crash waiting
    // for the line to be reached, and it takes the agent's evidence with it.
    const missing = namesUsed()
      .filter(({ name }) => !declared.has(name))
      .map(({ file, name }) => `${file.replace(SCRIPTS, '')}: ${name}`);
    expect([...new Set(missing)],
      `these windows are read but never declared, and throw when reached:\n${missing.join('\n')}`)
      .toEqual([]);
  });

  // A THIRD ASSERTION WAS REMOVED RATHER THAN SOFTENED. It was meant to check that every window
  // carries a reason for its size, could not express that without false positives across two
  // reason shapes, and I had reduced it to expect(Array.isArray(...)).toBe(true) — which passes
  // for every possible input. A test that cannot fail is worse than an absent one: it reports
  // coverage that does not exist.
});
