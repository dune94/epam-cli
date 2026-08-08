/**
 * A CORRECTION REPLACES WHAT WAS WRONG — NOT EVERYTHING.
 *
 * The roster reviewer returns findings, each naming the agent whose brief is defective. The
 * first version of the correction cycle responded to ANY blocking finding by wiping the entire
 * minted roster and re-proposing it from scratch. With five agents minted and one defective,
 * four briefs that had just passed adversarial review were discarded and re-derived.
 *
 * That is worse than wasteful. Minting is a sampling process: the re-proposal is a fresh draw,
 * so a brief that was correct is as likely to come back subtly wrong as to come back the same,
 * and the reviewer's own budget (EPAM_ROSTER_REVIEW_CYCLES, default 2) is spent re-checking
 * work that was already sound. A cycle meant to converge could move the roster sideways.
 *
 * So the clear is targeted: only the agents named by blocking findings are removed, from every
 * surface they were written to. A finding that names no agent — "nothing covers codeline X" —
 * is a gap, not a defect, and must remove nothing at all.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

beforeEach(() => {
  // these steer the registry paths away from the fixture if left set by another test
  delete process.env.EPAM_PROJECT_CONFIG_DIR;
  delete process.env.EPAM_PROJECT_INVESTIGATORS_FILE;
});

/** A minted roster: two implementers and two per-codeline investigators. */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-targeted-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({
    'canonical-review-agent': 'CANONICAL — never minted, never cleared',
    'sound-engineer': 'a brief that passed review',
    'defective-engineer': 'a brief the reviewer refuted',
    'sound-investigator': 'read-only, codeline alpha',
    'defective-investigator': 'read-only, codeline beta',
  }, null, 2));

  roster.registerProjectRoles(dir, ['sound-engineer', 'defective-engineer']);
  roster.registerProjectInvestigators(dir, [
    { name: 'sound-investigator', codeline: 'alpha' },
    { name: 'defective-investigator', codeline: 'beta' },
  ]);
  return { dir, profilesPath };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('the fixture is real', () => {
  it('a full roster is registered across both registries before anything is cleared', () => {
    const { dir } = seeded();
    expect(readJson(join(dir, 'project-roles.json')).roles).toEqual(
      expect.arrayContaining(['sound-engineer', 'defective-engineer']));
    expect(readJson(join(dir, 'project-investigators.json')).byCodeline).toEqual(
      { alpha: 'sound-investigator', beta: 'defective-investigator' });
  });
});

describe('a targeted clear removes only the agents named', () => {
  it('the defective implementer is removed and the sound one is left untouched', () => {
    const { dir, profilesPath } = seeded();
    const cleared = roster.clearProjectRoster(dir, profilesPath, ['defective-engineer']);

    expect(cleared).toEqual(['defective-engineer']);
    const profiles = readJson(profilesPath);
    expect(profiles['defective-engineer']).toBeUndefined();
    expect(
      profiles['sound-engineer'],
      'a brief that passed review was discarded and will be re-derived from scratch',
    ).toBe('a brief that passed review');
    expect(readJson(join(dir, 'project-roles.json')).roles).toEqual(['sound-engineer']);
  });

  it('a cleared investigator loses its codeline mapping; the other lane keeps its own', () => {
    const { dir, profilesPath } = seeded();
    roster.clearProjectRoster(dir, profilesPath, ['defective-investigator']);

    const inv = readJson(join(dir, 'project-investigators.json'));
    expect(inv.investigators).toEqual(['sound-investigator']);
    expect(
      inv.byCodeline,
      'a lane would be pointed at a detective whose brief no longer exists',
    ).toEqual({ alpha: 'sound-investigator' });
  });

  it('the canonical core is never touched, cleared selectively or wholesale', () => {
    const { dir, profilesPath } = seeded();
    roster.clearProjectRoster(dir, profilesPath, ['defective-engineer']);
    roster.clearProjectRoster(dir, profilesPath);
    expect(readJson(profilesPath)['canonical-review-agent']).toBe('CANONICAL — never minted, never cleared');
  });

  it('naming an agent that is not in the roster clears nothing', () => {
    const { dir, profilesPath } = seeded();
    const cleared = roster.clearProjectRoster(dir, profilesPath, ['never-minted']);
    expect(cleared).toEqual([]);
    expect(Object.keys(readJson(profilesPath)).sort()).toEqual([
      'canonical-review-agent', 'defective-engineer', 'defective-investigator',
      'sound-engineer', 'sound-investigator',
    ]);
  });

  it('an EMPTY name list clears nothing — it must never be read as "clear everything"', () => {
    // The gap case: blocking findings that name no agent. Passing their (empty) agent list
    // through must not collapse into the wholesale clear, which is what the argument-less
    // call still means.
    const { dir, profilesPath } = seeded();
    const cleared = roster.clearProjectRoster(dir, profilesPath, []);
    expect(cleared).toEqual([]);
    expect(readJson(join(dir, 'project-roles.json')).roles).toEqual(
      expect.arrayContaining(['sound-engineer', 'defective-engineer']));
  });
});

describe('the wholesale clear still exists for the ephemeral-roster rule', () => {
  it('calling it with no name list clears every minted agent, both registries', () => {
    const { dir, profilesPath } = seeded();
    const cleared = roster.clearProjectRoster(dir, profilesPath);

    expect(cleared.sort()).toEqual([
      'defective-engineer', 'defective-investigator', 'sound-engineer', 'sound-investigator',
    ]);
    expect(readJson(join(dir, 'project-roles.json')).roles).toEqual([]);
    expect(readJson(join(dir, 'project-investigators.json')).investigators).toEqual([]);
    expect(readJson(join(dir, 'project-investigators.json')).byCodeline).toEqual({});
    expect(Object.keys(readJson(profilesPath))).toEqual(['canonical-review-agent']);
  });
});

describe('the partition decides what is replaced and what is kept', () => {
  const MINTED = [
    { name: 'sound-engineer', kind: 'implementer' },
    { name: 'defective-engineer', kind: 'implementer' },
    { name: 'beta-investigator', kind: 'investigator', codeline: 'beta' },
  ];

  it('an agent named by a blocking finding is indicted; the rest are retained', () => {
    const { indicted, retained, gaps } = roster.partitionRosterFindings(
      [{ agent: 'defective-engineer', claim: 'c', checked: 'k', found: 'f' }], MINTED);

    expect(indicted).toEqual(['defective-engineer']);
    expect(retained.map((r: any) => r.name)).toEqual(['sound-engineer', 'beta-investigator']);
    expect(gaps).toBe(0);
  });

  it('two findings against the SAME agent indict it once, not twice', () => {
    const { indicted } = roster.partitionRosterFindings([
      { agent: 'defective-engineer', found: 'one defect' },
      { agent: 'defective-engineer', found: 'another defect' },
    ], MINTED);
    expect(indicted).toEqual(['defective-engineer']);
  });

  it('a finding naming NO agent indicts nobody and counts as a gap', () => {
    // "no role reads codeline gamma" is work to ADD, not a brief to replace.
    const { indicted, retained, gaps } = roster.partitionRosterFindings(
      [{ found: 'no role covers codeline gamma' }], MINTED);

    expect(indicted).toEqual([]);
    expect(
      retained.map((r: any) => r.name),
      'a coverage gap discarded briefs that had nothing wrong with them',
    ).toEqual(['sound-engineer', 'defective-engineer', 'beta-investigator']);
    expect(gaps).toBe(1);
  });

  it('a finding naming an agent NOT in this roster is a gap, not an indictment', () => {
    const { indicted, gaps } = roster.partitionRosterFindings(
      [{ agent: 'never-minted-engineer', found: 'stale name from an earlier cycle' }], MINTED);
    expect(indicted).toEqual([]);
    expect(gaps).toBe(1);
  });

  it('no findings at all retains the whole roster', () => {
    const { indicted, retained, gaps } = roster.partitionRosterFindings([], MINTED);
    expect(indicted).toEqual([]);
    expect(retained.length).toBe(3);
    expect(gaps).toBe(0);
  });

  it('every agent indicted leaves nothing retained — the wholesale case still reachable', () => {
    const { indicted, retained } = roster.partitionRosterFindings(
      MINTED.map((m) => ({ agent: m.name, found: 'defective' })), MINTED);
    expect(indicted.sort()).toEqual(['beta-investigator', 'defective-engineer', 'sound-engineer']);
    expect(retained).toEqual([]);
  });

  it('malformed input is refused rather than mistaken for "clear everything"', () => {
    expect(roster.partitionRosterFindings(null, MINTED).indicted).toEqual([]);
    expect(roster.partitionRosterFindings(null, MINTED).retained.length).toBe(3);
    expect(roster.partitionRosterFindings([null, undefined], MINTED).retained.length).toBe(3);
    expect(roster.partitionRosterFindings([{ agent: 'x' }], null).retained).toEqual([]);
  });
});
