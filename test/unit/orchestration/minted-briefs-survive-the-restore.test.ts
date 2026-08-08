/**
 * A MINTED AGENT MUST SURVIVE THE ROSTER RESTORE.
 *
 * profiles.json is copied from profiles.json.original at the start of every run — the
 * ephemeral-roster design (879c705), correct when the only project-specific thing about an
 * agent was a skill addendum. Identities are generated now, and that restore deleted the
 * minted briefs while the role registry and the KB files survived.
 *
 * Live 2026-08-07, after the first real mint:
 *
 *   profiles.json           56 keys — the three minted roles GONE
 *   project-roles.json      still lists all three
 *   KB-<role>.md            all three still present
 *
 * Three halves of one fact disagreeing. On a resume (mint skipped) the registry named roles
 * with no profile, candidateRoles filtered them all out, and assignment refused with "no
 * project implementation roles are registered". Resume was broken; only a fresh run
 * self-healed, by re-proposing.
 *
 * The briefs are stored with the project — never in profiles.json.original, because writing
 * one project's agents into the engine's canonical base is the contamination being removed.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');
const { FIXED_AGENT_ROLES } = require('../../../dist/sdk.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let prevCfg: string | undefined;
beforeEach(() => { prevCfg = process.env.EPAM_PROJECT_CONFIG_DIR; delete process.env.EPAM_PROJECT_CONFIG_DIR; });
afterAll(() => { if (prevCfg !== undefined) process.env.EPAM_PROJECT_CONFIG_DIR = prevCfg; });

const CANONICAL = { [FIXED_AGENT_ROLES[0]]: 'canonical brief', 'review-agent': 'reads only' };
const PROPOSAL = {
  name: 'a-domain-engineer', codeline: '*', systemPrompt: 'The brief for this project. '.repeat(10),
  rationale: 'This codeline owns a domain the canonical core does not cover.',
};

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify(CANONICAL, null, 2));
  return { dir, profilesPath };
}

/** What the launcher does at the start of every run. */
function restoreFromOriginal(profilesPath: string) {
  writeFileSync(profilesPath, JSON.stringify(CANONICAL, null, 2));
}

describe('the mint stores the brief with the project', () => {
  it('a store file is written alongside the registry', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    expect(res.minted[0].surfaces).toContain('project-profiles');
    expect(existsSync(roster.projectProfilesPath(dir))).toBe(true);
  });

  it('the stored brief is the one that was minted', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    const store = JSON.parse(readFileSync(roster.projectProfilesPath(dir), 'utf8'));
    expect(store.profiles[PROPOSAL.name]).toBe(PROPOSAL.systemPrompt);
  });

  it('it is NOT written into the canonical original', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    expect(
      roster.projectProfilesPath(dir).endsWith('profiles.json.original'),
      'one project\'s agents were written into the engine\'s canonical base',
    ).toBe(false);
  });
});

describe('THE DEFECT: the brief survives a per-run restore', () => {
  it('after a restore the role is gone — this is the live failure', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    restoreFromOriginal(profilesPath);
    expect(Object.keys(JSON.parse(readFileSync(profilesPath, 'utf8')))).not.toContain(PROPOSAL.name);
  });

  it('re-applying the store brings it back', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    restoreFromOriginal(profilesPath);

    const applied = roster.applyProjectProfiles(profilesPath, dir);
    expect(applied).toContain(PROPOSAL.name);
    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(
      after[PROPOSAL.name],
      'the registry still names this role, so without its brief assignment refuses and resume dies',
    ).toBe(PROPOSAL.systemPrompt);
  });

  it('registry and roster agree again afterwards', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    restoreFromOriginal(profilesPath);
    roster.applyProjectProfiles(profilesPath, dir);

    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    for (const r of roster.projectRoles(dir)) {
      expect(profiles[r], `${r} is registered but has no brief`).toBeTruthy();
    }
  });
});

describe('re-applying is additive and safe', () => {
  it('a canonical role is never replaced by a stored one', () => {
    const { dir, profilesPath } = ws();
    const canonical = FIXED_AGENT_ROLES[0];
    writeFileSync(roster.projectProfilesPath(dir), JSON.stringify({
      profiles: { [canonical]: 'A STORED IMPOSTOR' },
    }));
    roster.applyProjectProfiles(profilesPath, dir);
    expect(JSON.parse(readFileSync(profilesPath, 'utf8'))[canonical]).toBe('canonical brief');
  });

  it('a brief that gained skill notes this run is not reverted', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    const live = JSON.parse(readFileSync(profilesPath, 'utf8'));
    live[PROPOSAL.name] = PROPOSAL.systemPrompt + '\n[Self-Heal] a note learned this run';
    writeFileSync(profilesPath, JSON.stringify(live, null, 2));

    roster.applyProjectProfiles(profilesPath, dir);
    expect(JSON.parse(readFileSync(profilesPath, 'utf8'))[PROPOSAL.name]).toMatch(/Self-Heal/);
  });

  it('no store means no change and no crash', () => {
    const { dir, profilesPath } = ws();
    expect(roster.applyProjectProfiles(profilesPath, dir)).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(profilesPath, 'utf8'))).length).toBe(2);
  });
});

/**
 * NO ROSTER DRIFT (operator direction, 2026-08-07).
 *
 * The merge is additive so an existing brief is never rewritten — but that also means a
 * second mint ADDS whatever it proposes that time. Two live runs left five roles behind:
 * the three from a run whose vendor was wrong, plus new ones, with one name overlapping.
 * A roster that changes shape every run is not a roster.
 */
describe('the roster does not drift between runs', () => {
  it('a second mint on an already-minted project adds nothing', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    const first = roster.projectRoles(dir);
    expect(first).toEqual([PROPOSAL.name]);

    // What a second run would propose — different names, same project.
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [
      { name: 'a-different-engineer', codeline: '*', systemPrompt: 'y'.repeat(80), rationale: 'Nothing in the canonical core owns this part of the estate.' },
    ] });
    // The merge itself is additive by design; the STEP is what refuses to re-propose. This
    // pins the accumulation so the guard above it can never be quietly dropped.
    expect(roster.projectRoles(dir).length).toBeGreaterThan(first.length);
  });

  it('an explicit re-mint REPLACES rather than accumulating', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });

    const cleared = roster.clearProjectRoster(dir, profilesPath);
    expect(cleared).toContain(PROPOSAL.name);
    expect(roster.projectRoles(dir)).toEqual([]);

    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [
      { name: 'the-replacement-engineer', codeline: '*', systemPrompt: 'z'.repeat(80), rationale: 'Nothing in the canonical core owns this part of the estate.' },
    ] });
    expect(
      roster.projectRoles(dir),
      'the previous roster survived a replacement — that is drift wearing a new name',
    ).toEqual(['the-replacement-engineer']);
  });

  it('clearing removes the brief from the live roster too', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    roster.clearProjectRoster(dir, profilesPath);
    expect(Object.keys(JSON.parse(readFileSync(profilesPath, 'utf8')))).not.toContain(PROPOSAL.name);
  });

  it('clearing never touches a canonical role', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });
    roster.clearProjectRoster(dir, profilesPath);
    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(after[FIXED_AGENT_ROLES[0]]).toBe('canonical brief');
    expect(after['review-agent']).toBe('reads only');
  });

  it('clearing an unminted project is a no-op', () => {
    const { dir, profilesPath } = ws();
    expect(roster.clearProjectRoster(dir, profilesPath)).toEqual([]);
  });
});
