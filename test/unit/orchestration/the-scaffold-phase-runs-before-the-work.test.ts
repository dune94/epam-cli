/**
 * THE SCAFFOLD PHASE — 46 lines with no test, and it decides whether every agent has its skills.
 *
 * Its only job is to make the launcher's run_phase "scaffold" call fire the pre-phase skill
 * assessment over every synthesised story, so each agent's profile gains this project's skills
 * before any implementation begins. Without it that assessment never runs and every agent works
 * without them — silently, because a missing skill produces worse work rather than an error.
 *
 * Three properties, each of which fails quietly if broken:
 *
 *   FIRST, not appended — phases run in declared order, and an assessment after the work has
 *   assessed nothing.
 *
 *   IDEMPOTENT — a PRD already declaring a scaffold phase is left exactly as it is, so a resume
 *   cannot reorder the phases of a run already under way.
 *
 *   WRITTEN THROUGH A TEMPORARY FILE — this rewrites the PRD the whole run depends on, and an
 *   interrupted write left a truncated one.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HANDLER = join(__dirname, '../../../orchestrations/scripts/lib/handlers/run-jira-pipeline.js');
const NODE = process.execPath;

function inject(prd: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, typeof prd === 'string' ? prd : JSON.stringify(prd));
  const r = spawnSync(NODE, [HANDLER, f], { encoding: 'utf8', timeout: 60_000 });
  let after: any = null;
  try { after = JSON.parse(readFileSync(f, 'utf8')); } catch { /* left unwritten */ }
  return { code: r.status ?? -1, err: r.stderr ?? '', after, path: f };
}

const prd = (order: Record<string, string[]>) => ({
  stories: [{ id: 'S-1', phase: 'core' }],
  implementationOrder: order,
  project: { name: 'p' },
});

describe('the scaffold phase is injected ahead of the work', () => {
  it('adds a scaffold phase FIRST, because phases run in declared order', () => {
    // An assessment after the work has assessed nothing.
    const r = inject(prd({ core: ['S-1'], later: [] }));
    expect(r.code, r.err).toBe(0);
    const keys = Object.keys(r.after.implementationOrder);
    expect(keys[0], 'scaffold was appended rather than placed first').toBe('scaffold');
    expect(keys, 'an existing phase was dropped when scaffold was added')
      .toEqual(expect.arrayContaining(['core', 'later']));
  }, 90_000);

  it('the scaffold phase carries NO implementation stories', () => {
    // It exists to trigger an assessment, not to do work. A story in it would be run twice.
    const r = inject(prd({ core: ['S-1'] }));
    expect(r.after.implementationOrder.scaffold,
      'the scaffold phase was given work to do').toEqual([]);
  }, 90_000);

  it('and no story is lost or duplicated', () => {
    const r = inject(prd({ core: ['S-1', 'S-2'], later: ['S-3'] }));
    const all = Object.values(r.after.implementationOrder).flat();
    expect(all.sort(), 'a story was dropped or duplicated by the rewrite')
      .toEqual(['S-1', 'S-2', 'S-3']);
  }, 90_000);

  it('IS IDEMPOTENT — a PRD already declaring scaffold is left exactly as it is', () => {
    // A resume must not reorder the phases of a run already under way.
    const already = prd({ scaffold: [], core: ['S-1'] });
    const first = inject(already);
    const second = inject(first.after);
    expect(second.after, 'a second run rewrote a PRD that already had its scaffold phase')
      .toEqual(first.after);
  }, 90_000);

  it('a PRD with NO implementationOrder is handled rather than throwing mid-run', () => {
    const r = inject({ stories: [{ id: 'S-1' }], project: { name: 'p' } });
    expect(r.err, 'a PRD without a phase index threw from inside node').not.toMatch(/TypeError/);
  }, 90_000);

  it('an UNREADABLE PRD is refused, and the file is not left truncated', () => {
    // The rewrite is done through a temporary file and rename because an interrupted write left a
    // truncated PRD — the file the whole run depends on.
    const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
    const f = join(dir, 'prd.json');
    writeFileSync(f, '{ not json');
    const r = spawnSync(NODE, [HANDLER, f], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, 'an unreadable PRD was rewritten anyway').not.toBe(0);
    expect(readFileSync(f, 'utf8'), 'the original file was destroyed by a failed rewrite')
      .toBe('{ not json');
  }, 90_000);

  it('a missing PRD is refused rather than creating one', () => {
    const r = spawnSync(NODE, [HANDLER, '/no/such/prd.json'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
  }, 90_000);

  it('no argument is refused', () => {
    const r = spawnSync(NODE, [HANDLER], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
  }, 90_000);
});
