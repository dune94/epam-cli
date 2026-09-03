/**
 * A NUMBER THAT DECIDES WHAT AN AGENT SEES MUST HAVE A NAME.
 *
 * `head -c 8000` on a gate log, `head -40` on compiler output, `head -100` on a source file: each
 * decides what an agent is shown and therefore what it can conclude. Written at the call site, none
 * could be tuned by an operator, none appeared in a cost estimate, and none could be found by
 * anyone asking why an agent missed something three lines past the cut.
 *
 * The reader refuses an unknown name rather than defaulting. A window that silently becomes some
 * fallback is the same defect as the literal, with an extra layer of indirection to hide it.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/evidence-windows.sh');
const CONFIG = join(ROOT, 'orchestrations/config/evidence-windows.json');

function win(name: string) {
  const r = spawnSync('bash', ['-c',
    `error(){ echo "ERR $*" >&2; }
     source ${JSON.stringify(LIB)}
     if v=$(evidence_window ${JSON.stringify(name)}); then echo "OK:$v"; else echo "REFUSED"; fi`,
  ], { encoding: 'utf8', timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

describe('EVERY WINDOW IS READ FROM ITS DECLARATION', () => {
  it('the declaration exists and every window carries a reason', () => {
    const doc = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const names = Object.keys(doc.windows);
    expect(names.length).toBeGreaterThan(4);
    const noWhy = names.filter((n) => !doc.windows[n].$why);
    expect(noWhy, 'a window without a reason is a literal with a longer name').toEqual([]);
    const noValue = names.filter((n) => !Number.isFinite(doc.windows[n].value));
    expect(noValue).toEqual([]);
  });

  it('returns the declared value', () => {
    const doc = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(win('gateLogChars')).toContain(`OK:${doc.windows.gateLogChars.value}`);
  });

  it('REFUSES an unknown window rather than defaulting to something', () => {
    // A window that silently becomes a fallback is the literal again, hidden better.
    expect(win('noSuchWindow'), 'an undeclared window resolved to a value anyway')
      .toContain('REFUSED');
  });

  it('names the window it could not find, so it can be declared', () => {
    expect(win('noSuchWindow')).toMatch(/noSuchWindow/);
  });
});

describe('THE SHELL AND JS READERS SHARE ONE DECLARATION', () => {
  // Two files declaring the same number is how a limit comes to half-apply: this pipeline already
  // had a lint window written twice, and raising one of them changed nothing anybody could see.
  const js = require_(join(ROOT, 'orchestrations/scripts/lib/evidence-windows.js'));

  it('every declared window resolves identically in both', () => {
    const doc = JSON.parse(readFileSync(CONFIG, 'utf8'));
    for (const name of Object.keys(doc.windows)) {
      const fromShell = win(name).replace(/^OK:/, '').trim();
      expect(String(js.evidenceWindow(name)), `${name} differs between the readers`)
        .toBe(fromShell);
    }
  });

  it('the JS reader THROWS on an unknown name rather than defaulting', () => {
    expect(() => js.evidenceWindow('noSuchWindow')).toThrow(/not declared/);
  });
});
