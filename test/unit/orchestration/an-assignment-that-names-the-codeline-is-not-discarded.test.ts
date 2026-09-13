/**
 * AN ASSIGNMENT THAT NAMES THE CODELINE IS NOT DISCARDED WHEN THE STORY DECLARES NONE.
 *
 * The role-assigner answered correctly for all ten stories — every agentRole a minted role,
 * verbatim, each row carrying `codeline: "regintel"` as the prompt offered — and the consumer
 * reported every story unassigned, retried at the top of the ladder, got the same correct answer
 * and halted ($0.66, the other project's Run 4, 2026-09-13). The greenfield stories declare no
 * codeline, so the consumer looked up `<id>\0` and found only `<id>\0regintel`; its fallback runs
 * the other way only. The reply was right; the join dropped it. The refusal then blamed the
 * agent ("unassigned after the agent's full retry/ladder budget").
 *
 * A story declaring no codeline accepts its assignment under whatever codeline the assigner named
 * (one codeline, one owner), and a refusal names what was received against what was needed.
 * Driven through the real assignAgentRoles with a stub runner replaying the real reply shape.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(reply: object) {
  const d = mkdtempSync(join(tmpdir(), 'assign-')); dirs.push(d);
  const agents = join(d, 'agents'); mkdirSync(agents);
  const project = join(d, 'project'); mkdirSync(project);
  writeFileSync(join(agents, 'profiles.json'), JSON.stringify({}));
  writeFileSync(join(project, 'project-roles.json'), JSON.stringify({ roles: ['data-engineer', 'api-engineer'] }));
  writeFileSync(join(project, 'agent-profiles.json'), JSON.stringify({ profiles: { 'data-engineer': 'brief', 'api-engineer': 'brief' } }));
  const stub = join(d, 'stub.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'EOF'\n${JSON.stringify(reply)}\nEOF\n`, { mode: 0o755 });
  return { agents, project, promptExec: { cmd: stub, args: [] }, logDir: join(d, 'logs') };
}

async function assign(stories: any[], reply: object) {
  const f = fixture(reply);
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = f.project;
  mkdirSync(f.logDir, { recursive: true });
  try {
    return await spec.assignAgentRoles({ promptExec: f.promptExec, stories, profilesPath: join(f.agents, 'profiles.json'), logDir: f.logDir, repoPath: '' });
  } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
}

describe('an assignment that names the codeline is not discarded when the story declares none', () => {
  it('THE DEFECT: rows carrying a codeline for stories that declare none are accepted', async () => {
    const stories = [{ id: 'S-1', title: 'one' }, { id: 'S-2', title: 'two' }];
    const r = await assign(stories, { assignments: [
      { storyId: 'S-1', codeline: 'regintel', agentRole: 'data-engineer', reason: 'r' },
      { storyId: 'S-2', codeline: 'regintel', agentRole: 'api-engineer', reason: 'r' },
    ] });
    expect(r.assigned.map((a: any) => `${a.storyId}=${a.agentRole}`).sort()).toEqual(['S-1=data-engineer', 'S-2=api-engineer']);
    expect(stories[0].agentRole).toBe('data-engineer');
  });

  it('a story that DOES declare a codeline still needs a row for that codeline', async () => {
    const stories = [{ id: 'S-1', title: 'one', codelines: ['be', 'fe'] }];
    await expect(assign(stories, { assignments: [{ storyId: 'S-1', codeline: 'be', agentRole: 'data-engineer', reason: 'r' }] }))
      .rejects.toThrow(/S-1 @ fe/);
  });

  it('a refusal says what was received against what was needed, not what the agent failed to do', async () => {
    const stories = [{ id: 'S-1', title: 'one' }, { id: 'S-2', title: 'two' }];
    await expect(assign(stories, { assignments: [{ storyId: 'S-1', codeline: 'x', agentRole: 'data-engineer', reason: 'r' }] }))
      .rejects.toThrow(/1 assignment\(s\) received for 2 story\/ies.*S-2/s);
  });
});
