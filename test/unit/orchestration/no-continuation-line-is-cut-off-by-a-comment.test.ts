/**
 * NO CONTINUATION LINE IS CUT OFF BY A COMMENT.
 *
 * `cmd A=1 \` followed by a `# comment` line: bash joins the continuation with the comment line,
 * the `#` ends the command there, and whatever follows the comment runs as a SEPARATE command.
 * Four sites carried this (2026-09-14): the pre-phase assessment's `export` became permanent and
 * leaked its response schema, a ten-call tool budget and an empty write allow-list into every
 * later seam of the phase (self-healing then failed against the wrong schema); the gate-finding
 * analyst's runner ran with no prompt on stdin and no tool grant; two launchers exported half
 * their environment. bash -n and shellcheck accept all of them.
 *
 * Executed, not read: each offending shape is reproduced with bash to show the split is real,
 * then every script in the tree is scanned for the shape.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
function scripts(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    // .parked holds frozen snapshots of earlier trees — evidence, not code that runs.
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.git' && e !== '.parked') out.push(...scripts(p)); }
    else if (e.endsWith('.sh')) out.push(p);
  }
  return out;
}
/** Line numbers of non-comment lines ending in `\` whose next line is a comment. */
function cutOff(text: string): number[] {
  const lines = text.split('\n'); const hits: number[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/\\$/.test(lines[i]) && !/^\s*#/.test(lines[i]) && /^\s*#/.test(lines[i + 1])) hits.push(i + 1);
  }
  return hits;
}

describe('no continuation line is cut off by a comment', () => {
  it('THE HAZARD IS REAL: bash runs what follows the comment as a separate command', () => {
    const r = spawnSync('bash', ['-c', 'f() { echo "f saw X=${X:-unset}"; }\nexport X=1 \\\n# a comment\nf\nbash -c \'echo "child sees X=${X:-unset}"\''], { encoding: 'utf8' });
    expect(r.stdout).toContain('f saw X=1');            // f ran as its own command…
    expect(r.stdout).toContain('child sees X=1');       // …and the export was permanent, not scoped to f
  });
  const all = scripts(join(ROOT, 'orchestrations'));
  it('there are scripts to scan', () => { expect(all.length).toBeGreaterThan(50); });
  it('no script in orchestrations/ carries the shape', () => {
    const offenders = all.flatMap((f) => cutOff(readFileSync(f, 'utf8')).map((n) => `${f.replace(ROOT + '/', '')}:${n}`));
    expect(offenders).toEqual([]);
  });
});
