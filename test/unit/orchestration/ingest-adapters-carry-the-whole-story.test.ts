/**
 * THE TWO ADAPTERS BETWEEN A PRD AND THE LANES THAT RUN IT — NEITHER HAD A TEST.
 *
 * work-items-from-prd.js exists because discovery was invoked only on the Jira path, so a project
 * whose PRD was authored rather than ingested could never resolve its codelines at all.
 *
 * filtered-prd.js splits a PRD into one PRD per lane, and carries two defects worth a test each:
 *
 *   A story spanning several codelines matched no single-codeline partition, appeared in ZERO
 *   filtered PRDs, and was silently dropped from the run — how a [GO, UP, MX] ticket reached ingest
 *   and died.
 *
 *   Stories were copied through unchanged, so a story spanning three codelines carried its PRIMARY
 *   codeline into all three lane PRDs. Every consumer reading the singular field got the same answer
 *   everywhere: the detective resolved the first lane's investigator in all three lanes and
 *   investigated two repositories with a brief written for a different one.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = join(__dirname, '../../../orchestrations/scripts/lib/handlers');
const NODE = process.execPath;

function writePrd(body: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'prd-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return { dir, f };
}

function workItems(body: unknown) {
  const { f } = writePrd(body);
  const r = spawnSync(NODE, [join(H, 'work-items-from-prd.js'), f], { encoding: 'utf8', timeout: 60_000 });
  let items = null;
  try { items = JSON.parse(r.stdout || ''); } catch { /* refusal */ }
  return { code: r.status ?? -1, err: r.stderr ?? '', items };
}

function filtered(body: unknown, codeline: string, env: Record<string, string> = {}) {
  const { dir, f } = writePrd(body);
  const out = join(dir, 'lane.json');
  const r = spawnSync(NODE, [join(H, 'filtered-prd.js'), f, out, codeline], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env },
  });
  const prd = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { code: r.status ?? -1, err: r.stderr ?? '', prd };
}

describe('work-items-from-prd gives discovery what it reads, whatever the PRD came from', () => {
  it('turns stories into work items with the fields discovery uses', () => {
    const { items } = workItems({ stories: [
      { id: 'S-1', title: 'A title', description: 'A description', components: ['api'] }] });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('A title');
    expect(items[0].description).toBe('A description');
    expect(items[0].components).toContain('api');
  }, 90_000);

  it("a story's own codelines feed components too — the same meaning, authored by a human", () => {
    // Components are the strongest signal discovery has: the tracker's own statement of which
    // product areas a change touches. An authored PRD says it with `codelines`.
    const { items } = workItems({ stories: [
      { id: 'S-1', title: 't', codelines: ['be', 'fe'] }] });
    expect(items[0].components).toEqual(expect.arrayContaining(['be', 'fe']));
  }, 90_000);

  it('and both sources are DEDUPLICATED, in a stable order', () => {
    const { items } = workItems({ stories: [
      { id: 'S-1', title: 't', components: ['be', 'api'], codelines: ['be'] }] });
    expect(items[0].components.length, 'a duplicated area was weighed twice as evidence')
      .toBe(new Set(items[0].components).size);
    const again = workItems({ stories: [
      { id: 'S-1', title: 't', components: ['be', 'api'], codelines: ['be'] }] });
    expect(again.items[0].components, 'the order is not stable between runs')
      .toEqual(items[0].components);
  }, 90_000);

  it('EMPTY components are allowed — discovery then works from title and description', () => {
    // Which is exactly what it does for a ticket whose components were never filled in.
    const { code, items } = workItems({ stories: [{ id: 'S-1', title: 't', description: 'd' }] });
    expect(code).toBe(0);
    expect(items[0].components).toEqual([]);
  }, 90_000);

  it('an UNREADABLE PRD is fatal, not an empty list', () => {
    // Emitting an empty list would let discovery run against nothing and report that no codeline
    // matched, which reads like a finding rather than a missing input.
    expect(workItems('{ not json').code).not.toBe(0);
    const r = spawnSync(NODE, [join(H, 'work-items-from-prd.js'), '/no/such/prd.json'],
      { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
  }, 90_000);

  it('a PRD with NO stories is fatal for the same reason', () => {
    const r = workItems({ stories: [] });
    expect(r.code, 'a PRD with no stories produced an empty work-item list').not.toBe(0);
    expect(r.err).toMatch(/declares no stories/);
  }, 90_000);

  it('and no argument at all is refused with usage', () => {
    const r = spawnSync(NODE, [join(H, 'work-items-from-prd.js')], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/);
  }, 90_000);
});

describe('filtered-prd gives each lane a PRD that describes THAT lane', () => {
  it('a single-codeline story lands in its own lane only', () => {
    const body = { stories: [
      { id: 'S-1', codeline: 'be' }, { id: 'S-2', codeline: 'fe' }] };
    expect(filtered(body, 'be').prd.stories.map((s: any) => s.id)).toEqual(['S-1']);
    expect(filtered(body, 'fe').prd.stories.map((s: any) => s.id)).toEqual(['S-2']);
  }, 90_000);

  it('A SPANNING STORY APPEARS IN EVERY LANE IT SPANS — it used to appear in none', () => {
    // codelines[] is authoritative when present: the story stays whole and participates in each
    // lane's execution rather than being partitioned into exactly one. Without this it matched no
    // partition and was silently dropped — a [GO, UP, MX] ticket reached ingest and died.
    const body = { stories: [{ id: 'S-1', codeline: 'go', codelines: ['go', 'up', 'mx'] }] };
    for (const lane of ['go', 'up', 'mx']) {
      expect(filtered(body, lane).prd.stories.map((s: any) => s.id),
        `the spanning story is missing from the ${lane} lane`).toEqual(['S-1']);
    }
    expect(filtered(body, 'other').prd.stories, 'it leaked into a lane it does not span')
      .toEqual([]);
  }, 90_000);

  it("and each lane's copy names THAT lane, not the story's primary one", () => {
    // Stories were copied through unchanged, so all three lanes read the primary codeline. The
    // detective then resolved the first lane's investigator in every lane and investigated two
    // repositories with a brief written for a different one.
    const body = { stories: [{ id: 'S-1', codeline: 'go', codelines: ['go', 'up'] }] };
    const up = filtered(body, 'up').prd.stories[0];
    expect(up.codeline, "the lane's PRD says it is a different lane").toBe('up');
    expect(up.codelines, 'the spanning fact was destroyed rather than kept')
      .toEqual(expect.arrayContaining(['go', 'up']));
  }, 90_000);

  it('a story with NO codeline falls to the declared default lane, and nowhere else', () => {
    const body = { stories: [{ id: 'S-1' }] };
    expect(filtered(body, 'be', { JIRA_DEFAULT_CODELINE: 'be' }).prd.stories.map((s: any) => s.id))
      .toEqual(['S-1']);
    expect(filtered(body, 'fe', { JIRA_DEFAULT_CODELINE: 'be' }).prd.stories,
      'an unassigned story appeared in a lane that is not the default').toEqual([]);
  }, 90_000);

  it('a PRD that parsed but carries NO stories array does not throw a node internal mid-run', () => {
    const r = filtered({ project: { name: 'p' } }, 'be');
    expect(r.err, 'a missing stories array threw from inside node').not.toMatch(/TypeError/);
  }, 90_000);

  it('an unreadable PRD is refused rather than producing an empty lane', () => {
    const r = filtered('{ not json', 'be');
    expect(r.code).not.toBe(0);
    expect(r.prd, 'a lane PRD was written from a PRD that could not be read').toBeNull();
  }, 90_000);
});
