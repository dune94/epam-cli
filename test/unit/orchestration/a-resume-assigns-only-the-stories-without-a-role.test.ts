/**
 * A RESUME ASSIGNS ONLY THE STORIES WITHOUT A ROLE.
 *
 * assignAgentRoles decided all-or-nothing: when every story carried a role it validated and kept
 * them; when ONE story lacked a role it sent every story to the role-assigner and overwrote every
 * agentRole — completed stories and the operator's pause-time edits included. Adding two stories to
 * regintel run 20260926T125158Z (REGI-015/016, authored after the live DIAL check) would have
 * re-assigned the 22 stories that had already been built and reviewed.
 *
 * Driven through the real assignAgentRoles on that run's own PRD with the two authored stories added,
 * with a stub model that records the prompt it is sent.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const RUN_PRD = join(ROOT, 'test/fixtures/regintel/prd-20260926T125158Z.json');
const CANONICAL = join(ROOT, 'test/fixtures/regintel/prd-20260927.canonical.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Story = { id: string; status?: string; agentRole?: string; agentRoles?: Record<string, string> };
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { stories: Story[] };

/** The run's stories, plus the authored stories the run has never seen. */
function storiesWithNew(): Story[] {
  const run = load(RUN_PRD).stories;
  const ids = new Set(run.map((s) => s.id));
  const added = load(CANONICAL).stories.filter((s) => !ids.has(s.id));
  expect(added.map((s) => s.id)).toEqual(['REGI-015', 'REGI-016']);   // guard: the case under test is present
  return [...run, ...added.map((s) => ({ ...s, agentRole: undefined }))];
}

function fixture(roles: string[], reply: object) {
  const d = mkdtempSync(join(tmpdir(), 'assign-resume-')); dirs.push(d);
  const agents = join(d, 'agents'); mkdirSync(agents);
  const project = join(d, 'project'); mkdirSync(project);
  const calls = join(d, 'calls'); mkdirSync(calls);
  writeFileSync(join(agents, 'profiles.json'), JSON.stringify({}));
  writeFileSync(join(project, 'project-roles.json'), JSON.stringify({ roles }));
  writeFileSync(join(project, 'agent-profiles.json'), JSON.stringify({ profiles: Object.fromEntries(roles.map((r) => [r, `${r} brief`])) }));
  writeFileSync(join(d, 'reply.json'), JSON.stringify(reply));
  const stub = join(d, 'stub.sh');
  writeFileSync(stub, ['#!/usr/bin/env bash', `n=$(ls ${calls} | grep -c "^prompt-")`, `cat > ${calls}/prompt-$n.txt`, `cat ${d}/reply.json`].join('\n'), { mode: 0o755 });
  return { agents, project, calls, promptExec: { cmd: stub, args: [] }, logDir: join(d, 'logs') };
}

async function assign(stories: Story[], reply: object) {
  const roles = [...new Set(stories.map((s) => s.agentRole).filter(Boolean) as string[])];
  const f = fixture(roles, reply);
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = f.project;
  mkdirSync(f.logDir, { recursive: true });
  try {
    await spec.assignAgentRoles({ promptExec: f.promptExec, stories, profilesPath: join(f.agents, 'profiles.json'), logDir: f.logDir, repoPath: '' });
    const prompts = readdirSync(f.calls).map((p) => readFileSync(join(f.calls, p), 'utf8'));
    return { prompts };
  } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
}

describe('a resume that adds stories to a run assigns only those stories', () => {
  it('keeps every existing assignment, assigns the two new stories, and asks the assigner about nothing else', async () => {
    const stories = storiesWithNew();
    const before = new Map(stories.filter((s) => s.agentRole).map((s) => [s.id, s.agentRole]));
    expect(before.size).toBeGreaterThan(20);
    // The model would re-assign everything to one role if it were asked about everything.
    const everything = stories.map((s) => ({ storyId: s.id, agentRole: 'regintel-pipeline-engineer', reason: 'r' }));
    const { prompts } = await assign(stories, { assignments: everything });

    for (const [id, role] of before) expect(stories.find((s) => s.id === id)!.agentRole, `${id} was re-assigned`).toBe(role);
    expect(stories.find((s) => s.id === 'REGI-015')!.agentRole).toBe('regintel-pipeline-engineer');
    expect(stories.find((s) => s.id === 'REGI-016')!.agentRole).toBe('regintel-pipeline-engineer');

    expect(prompts.length).toBe(1);
    // The stories the assigner is asked about are its listed lines ("- <id>: <title>"); another
    // story's id may still appear inside a listed story's own text (REGI-015 depends on REGI-011).
    const listed = [...prompts[0].matchAll(/^- (REGI-[\w-]+):/gm)].map((m) => m[1]);
    expect(listed).toEqual(['REGI-015', 'REGI-016']);
  });

  it('an answer that misses a new story is refused and asked again, never filled from the old assignments', async () => {
    const stories = storiesWithNew();
    await expect(assign(stories, { assignments: [{ storyId: 'REGI-015', agentRole: 'regintel-pipeline-engineer', reason: 'r' }] }))
      .rejects.toThrow(/REGI-016/);
  });

  it('when every story already has a role, the assigner is not called at all', async () => {
    const stories = load(RUN_PRD).stories;
    const before = stories.map((s) => s.agentRole);
    const { prompts } = await assign(stories, { assignments: [] });
    expect(prompts).toEqual([]);
    expect(stories.map((s) => s.agentRole)).toEqual(before);
  });
});
