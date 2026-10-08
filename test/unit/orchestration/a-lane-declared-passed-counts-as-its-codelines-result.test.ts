/**
 * A LANE THE OPERATOR DECLARED PASSED IS THAT CODELINE'S RESULT FOR THE STORY.
 *
 * Live AMSD-2974 run 9 (2026-10-08): every lane that ran recorded its result; cx-shared and gotransit, declared passed
 * (EPAM_PASSED_LANES), were skipped and recorded nothing — "Spanning story INCOMPLETE — no result for: cxshared,
 * gotransit", exit 1. A run where every lane succeeds would end the same way. The declaration is the result: it is
 * recorded as one, and marked as declared.
 *
 * EXECUTED: lib/handlers/record-declared-pass.js, then lib/handlers/spanning-stories-incomplete.js on its output.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = (n: string) => join(__dirname, '../../../orchestrations/scripts/lib/handlers', n);
const d = mkdtempSync(join(tmpdir(), 'declared-pass-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const prd = (stories: object[]) => { const f = join(d, `prd-${Math.random()}.json`); writeFileSync(f, JSON.stringify({ stories })); return f; };
const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });
const story = { id: 'S-1', codelines: ['lib', 'site', 'other'], perCodeline: { site: { status: 'completed', completed: true } } };

describe('a declared pass is the codeline\'s result', () => {
  it('recorded for the story, marked as declared; the completeness check no longer names it', () => {
    const f = prd([story]);
    expect(node([H('spanning-stories-incomplete.js'), f]).stdout).toMatch(/no result for: lib, other/);
    expect(node([H('record-declared-pass.js'), f, 'lib']).status).toBe(0);
    const s = JSON.parse(readFileSync(f, 'utf8')).stories[0];
    expect(s.perCodeline.lib).toMatchObject({ status: 'completed', completed: true, reviewStatus: 'declared-passed' });
    expect(node([H('spanning-stories-incomplete.js'), f]).stdout).toBe('S-1 → no result for: other');
  });
  it('a codeline that has a result of its own keeps it', () => {
    const f = prd([story]);
    node([H('record-declared-pass.js'), f, 'site']);
    expect(JSON.parse(readFileSync(f, 'utf8')).stories[0].perCodeline.site).toEqual({ status: 'completed', completed: true });
  });
  it('a story that does not span the codeline is left alone', () => {
    const f = prd([{ id: 'S-2', codelines: ['site', 'other'] }]);
    node([H('record-declared-pass.js'), f, 'lib']);
    expect(JSON.parse(readFileSync(f, 'utf8')).stories[0].perCodeline).toBeUndefined();
  });
});
