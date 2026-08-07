/**
 * ASSIGNMENT HAPPENS AGAINST THE LIVE ROSTER, OR IT DOES NOT HAPPEN.
 *
 * synthesize-prd-from-jira.js now defers: at synthesis nothing has analysed the codeline,
 * so agentRole is null and a later step fills it. This is that step. It runs after minting,
 * when the project's own roles exist, and it is the only place a story acquires a role.
 *
 * Two failures it must not have, both silent:
 *
 *  1. A HALLUCINATED ROLE. An LLM asked to pick a role will occasionally invent one. A story
 *     assigned a role with no profile entry gets an empty system prompt from `.[$role]`, so
 *     the writer runs briefed on nothing at all. That must be refused, not written.
 *  2. A PROCESS ROLE. The roster holds 56 agents, most of them engine machinery — gates,
 *     sentinels, reviewers, coordinators. Assigning `sast-sentinel` to implement a story is
 *     as wrong as assigning a role that doesn't exist. Candidates are the PROJECT roles:
 *     the roster minus the canonical core, derived rather than listed.
 *
 * And the null must never survive: 15 downstream consumers read `.agentRole // "unknown"`,
 * so an unassigned story does not error anywhere — it silently runs as "unknown".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');
const { FIXED_AGENT_ROLES } = require('../../dist/sdk.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ROSTER = {
  [FIXED_AGENT_ROLES[0]]: 'canonical process role',
  [FIXED_AGENT_ROLES[1]]: 'another canonical process role',
  'some-domain-engineer': 'A project role that owns a domain. '.repeat(10),
  'another-domain-specialist': 'A second project role. '.repeat(10),
};

const STORIES = [
  { id: 'AMSD-2041', title: 'Enable draft preview', description: 'Editors cannot preview.' },
  { id: 'AMSD-2042', title: 'Fix a broken link', description: 'A link 404s.' },
];

function runner(answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'assign-runner-')); dirs.push(dir);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(join(dir, 'prompt.txt'))}\ncat <<'A'\n<ROLE_ASSIGNMENTS>${answer}</ROLE_ASSIGNMENTS>\nA\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], promptPath: join(dir, 'prompt.txt'), dir };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'assign-ws-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify(ROSTER, null, 2));
  // The mint's registry is what says which roles implement — not "roster minus canonical".
  writeFileSync(join(dir, 'project-roles.json'), JSON.stringify({
    roles: ['some-domain-engineer', 'another-domain-specialist'],
  }));
  return { dir, profilesPath };
}

async function assign(answer: string, stories = STORIES) {
  const ws = workspace();
  const r = runner(answer);
  delete process.env.SPEC_MODE_PROVIDER;
  const res = await spec.assignAgentRoles({
    promptExec: r, stories: stories.map(s => ({ ...s })),
    profilesPath: ws.profilesPath, logDir: ws.dir, repoPath: ws.dir,
  });
  let prompt = '';
  try { prompt = readFileSync(r.promptPath, 'utf8'); } catch { /* none */ }
  return { res, prompt };
}

const GOOD = JSON.stringify({
  assignments: [
    { storyId: 'AMSD-2041', agentRole: 'some-domain-engineer', reason: 'owns that domain' },
    { storyId: 'AMSD-2042', agentRole: 'another-domain-specialist', reason: 'owns that one' },
  ],
});

describe('the fixture is real', () => {
  it('the seam exists and a valid answer assigns every story', async () => {
    const { res, prompt } = await assign(GOOD);
    expect(typeof spec.assignAgentRoles).toBe('function');
    expect(prompt.length, 'no prompt reached the agent').toBeGreaterThan(100);
    expect(res.assigned).toHaveLength(2);
  }, 60_000);
});

describe('the agent is shown the real roster', () => {
  it('project roles are offered as candidates', async () => {
    const { prompt } = await assign(GOOD);
    expect(prompt).toContain('some-domain-engineer');
    expect(prompt).toContain('another-domain-specialist');
  }, 60_000);

  it('canonical process roles are NOT offered — they do not implement stories', async () => {
    const { prompt } = await assign(GOOD);
    const offered = prompt.slice(prompt.indexOf('AVAILABLE'), prompt.indexOf('AVAILABLE') + 1200);
    expect(
      offered,
      'a gate/sentinel was offered as an implementation role',
    ).not.toContain(FIXED_AGENT_ROLES[0]);
  }, 60_000);

  it('every story reaches the agent', async () => {
    const { prompt } = await assign(GOOD);
    expect(prompt).toContain('AMSD-2041');
    expect(prompt).toContain('AMSD-2042');
  }, 60_000);
});

describe('the assignment is applied', () => {
  it('each story gets the role it was assigned', async () => {
    const { res } = await assign(GOOD);
    const byId = Object.fromEntries(res.stories.map((s: any) => [s.id, s.agentRole]));
    expect(byId['AMSD-2041']).toBe('some-domain-engineer');
    expect(byId['AMSD-2042']).toBe('another-domain-specialist');
  }, 60_000);
});

describe('an unusable assignment is refused, never written', () => {
  it('a role with no profile entry is rejected — the writer would be briefed on nothing', async () => {
    const bad = JSON.stringify({
      assignments: [{ storyId: 'AMSD-2041', agentRole: 'invented-engineer', reason: 'r' }],
    });
    await expect(assign(bad, [STORIES[0]])).rejects.toThrow(/invented-engineer|not in the roster|no profile/i);
  }, 60_000);

  it('a canonical process role is rejected as an implementation role', async () => {
    const bad = JSON.stringify({
      assignments: [{ storyId: 'AMSD-2041', agentRole: FIXED_AGENT_ROLES[0], reason: 'r' }],
    });
    await expect(assign(bad, [STORIES[0]])).rejects.toThrow(/canonical|process role|not an implementation/i);
  }, 60_000);

  it('a story left unassigned fails loudly — 15 consumers would read it as "unknown"', async () => {
    const partial = JSON.stringify({
      assignments: [{ storyId: 'AMSD-2041', agentRole: 'some-domain-engineer', reason: 'r' }],
    });
    await expect(assign(partial, STORIES)).rejects.toThrow(/AMSD-2042|unassigned/i);
  }, 60_000);
});

/**
 * RESUME MUST NOT UNDO THE OPERATOR'S JUDGEMENT.
 *
 * The roster pause exists so the agents can be assessed and gaps closed before the spec
 * phase builds on them: the operator may edit a role's brief, the project-roles registry, or
 * a story's agentRole directly, then restart the run. If resume re-ran the assignment agent,
 * it would silently discard exactly the decision the pause was there to capture — and it
 * would look like it worked, because a fresh assignment is always plausible.
 */
describe('a resume validates the roster instead of regenerating it', () => {
  it('an operator-assigned role is KEPT, and no agent is called', async () => {
    const ws = workspace();
    // A runner that fails loudly if invoked — proving the agent was not consulted.
    const r = runner(JSON.stringify({
      assignments: [{ storyId: 'AMSD-2041', agentRole: 'another-domain-specialist', reason: 'the agent would have said this' }],
    }));
    const stories = [{ ...STORIES[0], agentRole: 'some-domain-engineer' }];
    const res = await spec.assignAgentRoles({
      promptExec: r, stories, profilesPath: ws.profilesPath, logDir: ws.dir, repoPath: ws.dir,
    });
    expect(
      res.stories[0].agentRole,
      'the resume re-ran the assignment agent and overwrote the operator\'s edit',
    ).toBe('some-domain-engineer');
    expect(existsSync(r.promptPath), 'an agent was invoked despite every story being assigned').toBe(false);
  }, 60_000);

  it('an operator edit to something INVALID is still refused', async () => {
    const ws = workspace();
    const r = runner(GOOD);
    const stories = [{ ...STORIES[0], agentRole: 'a-role-that-does-not-exist' }];
    await expect(spec.assignAgentRoles({
      promptExec: r, stories, profilesPath: ws.profilesPath, logDir: ws.dir, repoPath: ws.dir,
    })).rejects.toThrow(/not in the roster|no profile/i);
  }, 60_000);

  it('a partially-assigned set still goes to the agent — that is not an operator decision', async () => {
    const ws = workspace();
    const r = runner(GOOD);
    const stories = [{ ...STORIES[0], agentRole: 'some-domain-engineer' }, { ...STORIES[1] }];
    const res = await spec.assignAgentRoles({
      promptExec: r, stories, profilesPath: ws.profilesPath, logDir: ws.dir, repoPath: ws.dir,
    });
    expect(res.assigned).toHaveLength(2);
    expect(existsSync(r.promptPath), 'the agent was not consulted for the unassigned story').toBe(true);
  }, 60_000);
});
