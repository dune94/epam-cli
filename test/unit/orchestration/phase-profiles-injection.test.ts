/**
 * Hand the assessment the profiles it needs. It cannot go and read them.
 *
 * The pre-phase skill assessment is the most expensive call in the pipeline —
 * mock1 run 10: 2 calls, 25 turns each, 586,478 tokens, $0.2163, 57% of the run —
 * and it has never once completed. Its whole output, three runs running:
 *
 *   Agent reached maximum iterations (25) without completing.
 *
 * The cause is arithmetic, not prompting:
 *
 *   profiles.json                                  135,901 chars, 53 roles
 *   DEFAULT_MAX_TOOL_OUTPUT_CHARS                    8,192 chars
 *   what one read shows it                                6% of the file
 *   turns to page through it at 8,192/turn                   17
 *   iteration cap                                            25
 *
 * Reading the file once costs 68% of its budget. Narrowing does not save it
 * either: the `typescript-engineer` entry alone is 15,495 chars, 1.9x the
 * ceiling. `truncateToolOutput` keeps `slice(0, limit)` and appends a marker,
 * and ReadFile's schema takes only `path` and `encoding` — no offset, no range —
 * so the read tool cannot page at all. The agent is asked to reason about what a
 * profile already contains while being structurally unable to see one.
 *
 * So the profiles come to it. This is the standing rule the pipeline already has
 * for gates — they are HANDED what the run produced rather than going to find
 * it — applied to the one agent that most needed it.
 *
 * Scope matters as much as size: injecting all 53 roles would trade a paging
 * loop for a 136K-char prompt resent every turn. Only the roles THIS phase's
 * stories actually use are sent — 2 of 53 for a typical phase.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/lib/phase_profiles.py');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(prd: unknown, profiles: unknown, phase = 'core'): any {
  const dir = mkdtempSync(join(tmpdir(), 'phase-profiles-'));
  dirs.push(dir);
  const prdPath = join(dir, 'prd.json');
  const profPath = join(dir, 'profiles.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  writeFileSync(profPath, JSON.stringify(profiles));
  const out = execFileSync('python3',
    [SCRIPT, '--prd', prdPath, '--profiles', profPath, '--phase', phase, '--json'],
    { encoding: 'utf8', timeout: 20000 });
  return JSON.parse(out);
}

const PRD = {
  implementationOrder: { core: ['S-1', 'S-2'], other: ['S-9'] },
  stories: [
    { id: 'S-1', agentRole: 'typescript-engineer', technicalNotes: { files: ['src/a.ts'] } },
    { id: 'S-2', agentRole: 'test-engineer', technicalNotes: { files: ['src/a.test.ts'] } },
    { id: 'S-9', agentRole: 'docs-agent' },
  ],
};

const PROFILES = {
  'typescript-engineer': 'TS rules here',
  'test-engineer': 'test rules here',
  'docs-agent': 'docs rules',
  'sast-sentinel': 'security rules',
  'perf-sentinel': 'perf rules',
};

describe('only the roles this phase uses are sent', () => {
  it('includes the roles the phase\'s stories name', () => {
    const r = run(PRD, PROFILES);
    expect(Object.keys(r.roles).sort()).toEqual(['test-engineer', 'typescript-engineer']);
  });

  it('excludes roles belonging to other phases', () => {
    // Injecting all 53 would trade a paging loop for a 136K prompt every turn.
    expect(Object.keys(run(PRD, PROFILES).roles)).not.toContain('docs-agent');
  });

  it('excludes roles no story uses', () => {
    const keys = Object.keys(run(PRD, PROFILES).roles);
    expect(keys).not.toContain('sast-sentinel');
    expect(keys).not.toContain('perf-sentinel');
  });

  it('carries the profile text, not just the name', () => {
    expect(run(PRD, PROFILES).roles['typescript-engineer']).toBe('TS rules here');
  });
});

describe('it reports what it could not supply', () => {
  it('names a role with no profile rather than silently omitting it', () => {
    // Creating missing profiles is step 4 of the agent's own task — it must know
    // which are missing, and an empty section is indistinguishable from "none".
    const prd = { implementationOrder: { core: ['S-1'] },
                  stories: [{ id: 'S-1', agentRole: 'brand-new-role' }] };
    const r = run(prd, PROFILES);
    expect(r.missing).toContain('brand-new-role');
  });

  it('reports stories with no agentRole assigned', () => {
    // Assigning these is step 3 of its task.
    const prd = { implementationOrder: { core: ['S-1'] },
                  stories: [{ id: 'S-1', agentRole: null, technicalNotes: { files: ['x.test.ts'] } }] };
    const r = run(prd, PROFILES);
    expect(r.unassigned.map((s: any) => s.id)).toContain('S-1');
  });

  it('passes the files through for an unassigned story, so the role can be inferred', () => {
    const prd = { implementationOrder: { core: ['S-1'] },
                  stories: [{ id: 'S-1', technicalNotes: { files: ['x.test.ts'] } }] };
    expect(run(prd, PROFILES).unassigned[0].files).toEqual(['x.test.ts']);
  });
});

describe('the assessment actually receives it', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  function assessment(): string {
    const i = ORCH.indexOf('run_pre_phase_assessment() {');
    const j = ORCH.indexOf('\n}\n', i);
    return ORCH.slice(i, j);
  }

  it('builds the block before the prompt', () => {
    expect(assessment(), 'nothing invokes the profile extraction')
      .toMatch(/phase_profiles\.py/);
  });

  it('interpolates it into the prompt', () => {
    // Computing the block and not sending it is the failure mode that would
    // look exactly like success.
    expect(assessment(), 'the block is computed but never reaches the agent')
      .toMatch(/\$\{_pfa_profile_block\}/);
  });

  it('tells the agent not to read the profiles file', () => {
    // Without this it will still try: the task says "append to profiles.json",
    // and reading before writing is the obvious move.
    expect(assessment(), 'the agent is still free to page through a 136K file')
      .toMatch(/DO NOT READ/i);
  });

  it('says so loudly if extraction fails, rather than silently sending nothing', () => {
    const i = assessment().indexOf('phase_profiles.py');
    expect(assessment().slice(i, i + 500),
      'a failed extraction silently sends an empty block and the agent goes back ' +
      'to the file — the original failure, with no signal')
      .toMatch(/warning |error /);
  });
});

describe('it degrades safely rather than taking the phase down', () => {
  it('survives a phase that is not in implementationOrder', () => {
    const r = run(PRD, PROFILES, 'nonexistent');
    expect(r.roles).toEqual({});
    expect(r.unassigned).toEqual([]);
  });

  it('survives a story id that has no story object', () => {
    const prd = { implementationOrder: { core: ['GHOST'] }, stories: [] };
    expect(() => run(prd, PROFILES)).not.toThrow();
  });

  it('survives an empty profiles file', () => {
    const r = run(PRD, {});
    expect(r.missing.sort()).toEqual(['test-engineer', 'typescript-engineer']);
  });

  it('emits a bounded prompt block, not the whole file', () => {
    // The failure being fixed is a size mismatch; re-inflating the prompt with
    // all 53 roles would swap one unbounded cost for another.
    const big: Record<string, string> = {};
    for (let i = 0; i < 53; i += 1) big[`role-${i}`] = 'x'.repeat(3000);
    big['typescript-engineer'] = 'the one that matters';
    const prd = { implementationOrder: { core: ['S-1'] },
                  stories: [{ id: 'S-1', agentRole: 'typescript-engineer' }] };
    const r = run(prd, big);
    expect(Object.keys(r.roles)).toEqual(['typescript-engineer']);
    expect(JSON.stringify(r).length,
      'the injected block grew with the file instead of with the phase')
      .toBeLessThan(5000);
  });
});
