/**
 * The assessment returns a decision. The script applies it.
 *
 * mock1 runs 10 and 12: the pre-phase assessment ran to its 25-turn cap every
 * time, 300–474K tokens, ~40% of a run's cost, and never completed. Its own log
 * says where the turns went:
 *
 *   "The addendum was duplicated 4 times! This must have been caused by the
 *    python script being run multiple times or the profile string being
 *    concatenated incorrectly. Let me fix this by removing the duplicates"
 *
 * It is not reasoning badly — its plan pass is correct and specific. It is
 * MUTATING a 135,901-char JSON file with no `write_file` tool, so it hand-rolls
 * python through bash, re-reads to check, finds it corrupted its own work, and
 * writes more scripts to undo that. Granting write_file would not save it either:
 * appending one rule means rewriting the whole file, which needs the whole file
 * read, which is the thing an 8,192-char tool ceiling forbids.
 *
 * So it stops writing. It emits a decision under EPAM_RESPONSE_SCHEMA — enforced
 * at the provider (AgentRunner.ts:190 sets responseFormat with strict:true), not
 * requested in prose — and this module applies it.
 *
 * That also BOUNDS THE LOOP, which is what makes schema-binding safe here. A
 * schema over an agent that still exhausts returns a valid EMPTY object: a loud
 * failure turned silent. With the writes gone the work is read-reason-emit, a
 * handful of turns, so the two changes are one change and not a sequence.
 *
 * Every rule the agent was asked to follow in prose is enforced here instead:
 * only unassigned roles get assigned, only absent profiles get created, and a
 * rule already present is never appended twice — the duplication that cost run
 * 12 its budget becomes unrepresentable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const APPLY = join(__dirname, '../../../orchestrations/scripts/lib/assessment_apply.py');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function apply(result: unknown, prd: any, profiles: any, phase = 'core') {
  const dir = mkdtempSync(join(tmpdir(), 'assess-apply-'));
  dirs.push(dir);
  const rPath = join(dir, 'result.json');
  const pPath = join(dir, 'prd.json');
  const fPath = join(dir, 'profiles.json');
  writeFileSync(rPath, typeof result === 'string' ? result : JSON.stringify(result));
  writeFileSync(pPath, JSON.stringify(prd));
  writeFileSync(fPath, JSON.stringify(profiles));

  // A non-zero exit is a RESULT here, not a harness error: refusing malformed
  // agent output loudly is the contract under test.
  const r = spawnSync('python3',
    [APPLY, '--result', rPath, '--prd', pPath, '--profiles', fPath, '--phase', phase],
    { encoding: 'utf8', timeout: 20000 });
  const stdout = (r.stdout || '') + (r.stderr || '');

  return {
    exitCode: r.status,
    prd: JSON.parse(readFileSync(pPath, 'utf8')),
    profiles: JSON.parse(readFileSync(fPath, 'utf8')),
    stdout,
  };
}

const PRD = {
  implementationOrder: { core: ['S-1', 'S-2'], other: ['S-9'] },
  stories: [
    { id: 'S-1', agentRole: null, technicalNotes: { files: ['a.test.ts'] } },
    { id: 'S-2', agentRole: 'typescript-engineer', technicalNotes: { files: ['a.ts'] } },
    { id: 'S-9', agentRole: null },
  ],
};

const PROFILES = { 'typescript-engineer': 'existing TS rules' };

function story(prd: any, id: string) {
  return prd.stories.find((s: any) => s.id === id);
}

describe('role assignment follows the rule the prompt states', () => {
  it('assigns a role to a story that has none', () => {
    const r = apply({ storyRoleAssignments: [{ storyId: 'S-1', agentRole: 'test-engineer' }],
                      profileAdditions: [], newProfiles: [] }, PRD, PROFILES);
    expect(story(r.prd, 'S-1').agentRole).toBe('test-engineer');
  });

  it('does NOT overwrite a role that is already set', () => {
    // Step 3 of its task is "for any story where agentRole is null or empty".
    // Enforced here rather than hoped for.
    const r = apply({ storyRoleAssignments: [{ storyId: 'S-2', agentRole: 'docs-agent' }],
                      profileAdditions: [], newProfiles: [] }, PRD, PROFILES);
    expect(story(r.prd, 'S-2').agentRole,
      'an existing role was reassigned — the agent may only fill in blanks')
      .toBe('typescript-engineer');
  });

  it('ignores a story outside this phase', () => {
    const r = apply({ storyRoleAssignments: [{ storyId: 'S-9', agentRole: 'docs-agent' }],
                      profileAdditions: [], newProfiles: [] }, PRD, PROFILES);
    expect(story(r.prd, 'S-9').agentRole,
      'a story from another phase was modified')
      .toBeNull();
  });

  it('ignores a story id that does not exist', () => {
    expect(() => apply({ storyRoleAssignments: [{ storyId: 'GHOST', agentRole: 'x' }],
                         profileAdditions: [], newProfiles: [] }, PRD, PROFILES)).not.toThrow();
  });

  it('touches no other field on the story', () => {
    // The PRD field-allowlist check exists because an agent with a shell could
    // rewrite anything. Now only agentRole is writable, by construction.
    const r = apply({ storyRoleAssignments: [{ storyId: 'S-1', agentRole: 'test-engineer' }],
                      profileAdditions: [], newProfiles: [] }, PRD, PROFILES);
    expect(story(r.prd, 'S-1').technicalNotes).toEqual({ files: ['a.test.ts'] });
  });
});

describe('profile rules are appended, never duplicated', () => {
  it('appends a new rule to an existing profile', () => {
    const r = apply({ storyRoleAssignments: [],
                      profileAdditions: [{ role: 'typescript-engineer', rules: ['always annotate return types'] }],
                      newProfiles: [] }, PRD, PROFILES);
    expect(r.profiles['typescript-engineer']).toContain('existing TS rules');
    expect(r.profiles['typescript-engineer']).toContain('always annotate return types');
  });

  it('does not append a rule the profile already contains', () => {
    // THE run-12 BUG: "The addendum was duplicated 4 times!". Unrepresentable now.
    const r = apply({ storyRoleAssignments: [],
                      profileAdditions: [{ role: 'typescript-engineer', rules: ['existing TS rules'] }],
                      newProfiles: [] }, PRD, PROFILES);
    const occurrences = r.profiles['typescript-engineer'].split('existing TS rules').length - 1;
    expect(occurrences, 'the rule was appended on top of itself').toBe(1);
  });

  it('is idempotent — applying the same decision twice changes nothing', () => {
    const decision = { storyRoleAssignments: [],
                       profileAdditions: [{ role: 'typescript-engineer', rules: ['rule A'] }],
                       newProfiles: [] };
    const once = apply(decision, PRD, PROFILES);
    const twice = apply(decision, PRD, once.profiles);
    expect(twice.profiles['typescript-engineer']).toBe(once.profiles['typescript-engineer']);
  });

  it('ignores an addition for a role with no profile', () => {
    // Creating it is what newProfiles is for; silently inventing one here would
    // bypass the create path and its checks.
    const r = apply({ storyRoleAssignments: [],
                      profileAdditions: [{ role: 'nonexistent', rules: ['x'] }],
                      newProfiles: [] }, PRD, PROFILES);
    expect(r.profiles.nonexistent).toBeUndefined();
  });

  it('drops empty and whitespace-only rules', () => {
    const r = apply({ storyRoleAssignments: [],
                      profileAdditions: [{ role: 'typescript-engineer', rules: ['', '   ', 'real rule'] }],
                      newProfiles: [] }, PRD, PROFILES);
    expect(r.profiles['typescript-engineer']).toContain('real rule');
    expect(r.profiles['typescript-engineer']).not.toMatch(/\n\s*\n\s*\n/);
  });
});

describe('new profiles are created, never silently replaced', () => {
  it('creates a profile for a role that has none', () => {
    const r = apply({ storyRoleAssignments: [], profileAdditions: [],
                      newProfiles: [{ role: 'test-engineer', profile: 'writes only test files' }] },
                    PRD, PROFILES);
    expect(r.profiles['test-engineer']).toBe('writes only test files');
  });

  it('does NOT overwrite an existing profile', () => {
    const r = apply({ storyRoleAssignments: [], profileAdditions: [],
                      newProfiles: [{ role: 'typescript-engineer', profile: 'REPLACED' }] },
                    PRD, PROFILES);
    expect(r.profiles['typescript-engineer'],
      'an existing profile was clobbered — 53 roles depend on these')
      .toBe('existing TS rules');
  });
});

describe('a bad decision cannot corrupt the run', () => {
  it('leaves both files valid JSON on malformed agent output', () => {
    const r = apply('not json at all', PRD, PROFILES);
    expect(r.prd.stories.length).toBe(3);
    expect(r.profiles['typescript-engineer']).toBe('existing TS rules');
  });

  it('reports that it applied nothing rather than failing silently', () => {
    const r = apply('not json at all', PRD, PROFILES);
    expect(r.stdout, 'malformed output was swallowed — the step would report success')
      .toMatch(/could not parse|invalid|no decision/i);
  });

  it('recovers the decision from an answer with a preamble', () => {
    // The schema binds output at the provider, but AgentRunner warns and
    // CONTINUES when EPAM_RESPONSE_SCHEMA is absent or malformed — so an
    // unwrapped answer must not cost the phase.
    const wrapped = 'Here is my assessment:\n\n' +
      JSON.stringify({ storyRoleAssignments: [{ storyId: 'S-1', agentRole: 'test-engineer' }],
                       profileAdditions: [], newProfiles: [] }) + '\n\nDone.';
    const r = apply(wrapped, PRD, PROFILES);
    expect(story(r.prd, 'S-1').agentRole,
      'a decision wrapped in prose was discarded').toBe('test-engineer');
  });

  it('survives missing keys', () => {
    const r = apply({}, PRD, PROFILES);
    expect(r.profiles['typescript-engineer']).toBe('existing TS rules');
  });

  it('survives wrong types in the arrays', () => {
    expect(() => apply({ storyRoleAssignments: 'nope', profileAdditions: 42, newProfiles: null },
                       PRD, PROFILES)).not.toThrow();
  });

  it('says what it changed, so the step is auditable', () => {
    const r = apply({ storyRoleAssignments: [{ storyId: 'S-1', agentRole: 'test-engineer' }],
                      profileAdditions: [{ role: 'typescript-engineer', rules: ['rule A'] }],
                      newProfiles: [] }, PRD, PROFILES);
    expect(r.stdout).toMatch(/S-1/);
    expect(r.stdout).toMatch(/typescript-engineer/);
  });
});

describe('the assessment is actually wired to decide-not-write', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  function fn(): string {
    const i = ORCH.indexOf('run_pre_phase_assessment() {');
    return ORCH.slice(i, ORCH.indexOf('\n}\n', i));
  }

  function prompt(): string {
    const i = ORCH.indexOf('You are the skill assessment agent running in PRE-PHASE mode');
    const m = /\nPROMPT_HEADER\n/.exec(ORCH.slice(i));
    return ORCH.slice(i, i + (m ? m.index : 8000));
  }

  it('binds the output with EPAM_RESPONSE_SCHEMA', () => {
    expect(fn(), 'the output is unbound — the agent may return anything')
      .toMatch(/EPAM_RESPONSE_SCHEMA/);
  });

  it('applies the decision deterministically', () => {
    expect(fn(), 'the agent decides and nothing applies it')
      .toMatch(/assessment_apply\.py/);
  });

  it('grants the agent no write scope at all', () => {
    // It has no reason to write now, and a future prompt edit must not quietly
    // regain the access that let it edit src/hello.ts before implementation ran.
    expect(fn(), 'the agent can still write files')
      .toMatch(/EPAM_ALLOWED_WRITE_PATHS=""/);
  });

  it('asks the prompt for a decision, not an edit', () => {
    expect(prompt()).toMatch(/storyRoleAssignments/);
    expect(prompt()).toMatch(/profileAdditions/);
    expect(prompt()).toMatch(/newProfiles/);
  });

  it('no longer instructs the agent to edit the PRD or profiles', () => {
    // These are what it was hand-rolling python to do.
    expect(prompt(), 'the agent is still told to write the PRD itself')
      .not.toMatch(/Write the assigned agentRole back/);
    expect(prompt(), 'the agent is still told to write profiles.json itself')
      .not.toMatch(/Add the new profile as a key/);
  });

  it('treats an unapplied decision as a failed attempt', () => {
    // Anchor on the INVOCATION, not the first mention — the module is named in a
    // comment above it too.
    const i = fn().indexOf('--result "$assessment_log"');
    expect(i, 'the apply invocation was not found').toBeGreaterThan(-1);
    expect(fn().slice(i, i + 700),
      'the apply can fail while the step reports the phase was assessed')
      .toMatch(/_pfa_call_ok=0/);
  });
});

describe('the schema binds the output space', () => {
  const SCHEMA = JSON.parse(execFileSync('python3', [APPLY, '--print-schema'], { encoding: 'utf8' }));

  it('is shaped for EPAM_RESPONSE_SCHEMA', () => {
    // AgentRunner reads name+schema and sets responseFormat strict:true.
    expect(SCHEMA.name).toBeTruthy();
    expect(SCHEMA.schema?.type).toBe('object');
  });

  it('requires the three decision arrays', () => {
    expect(SCHEMA.schema.required.sort())
      .toEqual(['newProfiles', 'profileAdditions', 'storyRoleAssignments']);
  });

  it('forbids extra properties, so prose cannot ride along', () => {
    expect(SCHEMA.schema.additionalProperties).toBe(false);
  });
});
