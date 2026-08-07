/**
 * A MINTED AGENT MUST BE OPERATIONAL, AND THE CANONICAL CORE MUST SURVIVE IT.
 *
 * Minting project-specific roles is only half the feature. A role that exists as a name
 * in profiles.json and nothing else is a role nothing can invoke: the seams look up
 * `.[$role]` for instructions, read KB-{role}.md for accumulated skills, and take tools
 * from the invocation profile. Write one surface and skip the others and the agent is
 * assigned work it has no briefing, no memory and no tools for.
 *
 * The other half is protection. FIXED_AGENT_ROLES (21 canonical roles: spec-coordinator-agent,
 * team-lead-agent, review-agent, the sentinels, ...) are the generic core. A proposal is an
 * LLM's suggestion, and an LLM asked for "project-specific roles" can and will occasionally
 * return a name that collides with one. Minting is therefore strictly ADDITIVE:
 *
 *   - a proposal may never overwrite a canonical role's prompt
 *   - a proposal may never remove any existing role, canonical or previously minted
 *   - re-running the mint must converge, not accumulate duplicates or churn prompts
 *
 * The failure this guards is silent: an overwritten review-agent still has a profile
 * entry, still gets invoked, and simply reviews with the wrong brief.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');
const { FIXED_AGENT_ROLES } = require('../../../dist/sdk.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function workspace(profiles: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
  return { dir, profilesPath };
}

const PROPOSAL = {
  name: 'some-domain-engineer',
  systemPrompt: 'You own a distinct domain of this project. '.repeat(12),
  rationale: 'The codeline has a domain that no generic role covers.',
};

describe('the fixture is real', () => {
  it('the canonical core is non-empty and the module is loadable', () => {
    expect(FIXED_AGENT_ROLES.length).toBeGreaterThan(10);
    expect(typeof roster.mergeProjectAgents).toBe('function');
  });
});

describe('minting is additive — the canonical core is protected', () => {
  it('a proposal colliding with a canonical role does NOT overwrite it', () => {
    const canonical = FIXED_AGENT_ROLES[0];
    const { profilesPath } = workspace({ [canonical]: 'THE CANONICAL BRIEF' });

    const res = roster.mergeProjectAgents({
      profilesPath,
      proposals: [{ ...PROPOSAL, name: canonical, systemPrompt: 'AN LLM SUGGESTION' }],
    });

    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(
      after[canonical],
      'an LLM proposal replaced a canonical role — it still runs, just with the wrong brief',
    ).toBe('THE CANONICAL BRIEF');
    expect(res.rejected).toContainEqual(expect.objectContaining({ name: canonical }));
  });

  it('no existing role is ever removed', () => {
    const { profilesPath } = workspace({ 'review-agent': 'r', 'kept-engineer': 'k' });
    roster.mergeProjectAgents({ profilesPath, proposals: [PROPOSAL] });

    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(Object.keys(after)).toEqual(expect.arrayContaining(['review-agent', 'kept-engineer']));
  });

  it('a previously minted role is not churned on re-run — the mint converges', () => {
    const { profilesPath } = workspace({ [PROPOSAL.name]: 'ALREADY MINTED, POSSIBLY LEARNED-ON' });
    roster.mergeProjectAgents({ profilesPath, proposals: [PROPOSAL] });

    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(
      after[PROPOSAL.name],
      'a re-run rewrote an existing agent, discarding whatever it had accumulated',
    ).toBe('ALREADY MINTED, POSSIBLY LEARNED-ON');
  });
});

describe('a genuinely new role is added AND wired', () => {
  it('instructions land in profiles.json under the role key the seams look up', () => {
    const { profilesPath } = workspace({ 'review-agent': 'r' });
    roster.mergeProjectAgents({ profilesPath, proposals: [PROPOSAL] });

    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(after[PROPOSAL.name]).toBe(PROPOSAL.systemPrompt);
  });

  it('a KB file is seeded so the role has a skills store from its first run', () => {
    const { dir, profilesPath } = workspace({});
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });

    const kb = join(dir, `KB-${PROPOSAL.name}.md`);
    expect(
      existsSync(kb),
      'the seams append skills to KB-{role}.md; without it the agent starts every run blank',
    ).toBe(true);
    expect(readFileSync(kb, 'utf8').length).toBeGreaterThan(0);
  });

  it('the result reports what was wired, so a run can be audited afterwards', () => {
    const { dir, profilesPath } = workspace({});
    const res = roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [PROPOSAL] });

    expect(res.minted).toContainEqual(expect.objectContaining({ name: PROPOSAL.name }));
    expect(res.minted[0].surfaces).toEqual(expect.arrayContaining(['profiles.json', 'kb']));
  });

  it('the written profiles.json stays valid JSON', () => {
    const { profilesPath } = workspace({ 'review-agent': 'r' });
    roster.mergeProjectAgents({ profilesPath, proposals: [PROPOSAL] });
    expect(() => JSON.parse(readFileSync(profilesPath, 'utf8'))).not.toThrow();
  });
});

describe('malformed proposals are refused, not written', () => {
  it('a proposal with no name or no prompt never reaches profiles.json', () => {
    const { profilesPath } = workspace({ 'review-agent': 'r' });
    const res = roster.mergeProjectAgents({
      profilesPath,
      proposals: [{ name: '', systemPrompt: 'x' }, { name: 'nameless-engineer', systemPrompt: '' }],
    });

    const after = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(Object.keys(after)).toEqual(['review-agent']);
    expect(res.rejected.length).toBe(2);
  });

  it('a role name that is not a plain identifier is refused — it becomes a filename', () => {
    const { dir, profilesPath } = workspace({});
    roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: '../escape', systemPrompt: 'x'.repeat(50), rationale: 'r' }],
    });
    expect(existsSync(join(dir, '../KB-escape.md'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(profilesPath, 'utf8')))).toEqual([]);
  });
});
