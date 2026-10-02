/**
 * A LANE NEVER READS ANOTHER LANE'S SPEC AS THE TICKET.
 *
 * Live 2026-10-02, AMSD-2974 (a shared library and three consuming sites), run 20261001T181327Z,
 * lanes sequential. The library lane's spec agent rewrote the story description to say "No
 * consumer-site file needs to change … that bump is tracked separately", which the ticket never
 * said. The merge copied the lane's whole story over canonical, so the next lane's PRD carried
 * that rewrite as its description, and the next lane's detective quoted it: "The ticket itself
 * states this bump is tracked separately … No edit for this story". Two of three sites were
 * specified as needing nothing.
 *
 * A spanning story's title and description stay the ticket's on canonical; each lane's rewrite is
 * kept under its own codeline, and each lane's PRD carries its own rewrite, or the ticket's text
 * when it has none yet. A story confined to one codeline is merged wholesale, as before.
 *
 * EXECUTED: the real mergeLaneIntoCanonical (lib/story-merge.js) and the real filtered-prd.js, in
 * the order the lanes run them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeLaneIntoCanonical } = require(join(LIB, 'story-merge.js'));
const work = mkdtempSync(join(tmpdir(), 'lane-spec-text-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const TICKET_TITLE = 'Toast accessibility across the library and the sites';
const TICKET_DESC = 'Make toasts accessible in the library and in every site that shows them.';
const LANE_A_TITLE = '[A] library toast fix';
const LANE_A_DESC = 'Library change. No site needs to change; that bump is tracked separately.';

const canonical = () => ({
  implementationOrder: { core: ['S-1'] },
  stories: [{ id: 'S-1', title: TICKET_TITLE, description: TICKET_DESC, codeline: 'a', codelines: ['a', 'b'], status: 'in-progress' }],
});
const laneAfterSpec = (cl: string, title: string, description: string) => ({
  stories: [{ id: 'S-1', title, description, codeline: cl, codelines: ['a', 'b'], status: 'paused', verificationCriteria: ['v'], fixSiteAnalysis: [] }],
});

function lanePrd(canon: any, cl: string) {
  const src = join(work, `canon-${cl}.json`); const out = join(work, `lane-${cl}.json`);
  writeFileSync(src, JSON.stringify(canon));
  const r = spawnSync(process.execPath, [join(LIB, 'handlers/filtered-prd.js'), src, out, cl], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(readFileSync(out, 'utf8')).stories[0];
}

describe('a spanning story keeps the ticket on canonical', () => {
  const merged = mergeLaneIntoCanonical({ canonical: canonical(), updated: laneAfterSpec('a', LANE_A_TITLE, LANE_A_DESC), codeline: 'a' });
  const s = merged.stories[0];

  it('canonical title and description are still the ticket\'s after lane a merges', () => {
    expect(s.title).toBe(TICKET_TITLE);
    expect(s.description).toBe(TICKET_DESC);
  });

  it('lane a\'s rewrite is kept under lane a', () => {
    expect(s.specTextPerCodeline.a).toEqual({ title: LANE_A_TITLE, description: LANE_A_DESC });
  });

  it('the next lane is given the ticket, never lane a\'s rewrite', () => {
    const b = lanePrd(merged, 'b');
    expect(b.description).toBe(TICKET_DESC);
    expect(b.title).toBe(TICKET_TITLE);
    expect(b.description).not.toContain('tracked separately');
  });

  it('lane a, run again (a resume), is given its own rewrite', () => {
    const a = lanePrd(merged, 'a');
    expect(a.description).toBe(LANE_A_DESC);
    expect(a.title).toBe(LANE_A_TITLE);
  });

  it('a second lane\'s merge keeps both rewrites apart and the ticket intact', () => {
    const again = mergeLaneIntoCanonical({ canonical: merged, updated: laneAfterSpec('b', '[B] site', 'Site change.'), codeline: 'b' });
    const t = again.stories[0];
    expect(t.description).toBe(TICKET_DESC);
    expect(t.specTextPerCodeline).toEqual({ a: { title: LANE_A_TITLE, description: LANE_A_DESC }, b: { title: '[B] site', description: 'Site change.' } });
  });
});

describe('a story confined to one codeline is merged as before', () => {
  it('its lane\'s rewrite replaces the description, and nothing per-codeline is added', () => {
    const c = { stories: [{ id: 'S-2', title: 'T', description: 'D', codeline: 'a' }] };
    const m = mergeLaneIntoCanonical({ canonical: c, updated: { stories: [{ id: 'S-2', title: 'T2', description: 'D2', codeline: 'a' }] }, codeline: 'a' });
    expect(m.stories[0].description).toBe('D2');
    expect(m.stories[0].title).toBe('T2');
    expect(m.stories[0].specTextPerCodeline).toBeUndefined();
  });
});
