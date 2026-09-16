/**
 * AN INCOMPLETE ASSIGNMENT IS RETRIED WITH THE SHORTFALL NAMED, NOT ABORTED.
 *
 * Run 7 (20260916T184851Z), regintel: the role-assigner was sent the same 14,092-character
 * prompt listing all ten stories that six earlier calls had answered with ten assignments, and
 * this time answered with ONE (REGI-001). The completeness check threw, the mint failed, the run
 * exited 1 at $0.02 — no retry, no corrective note, no climb. The operator's standing rule: every
 * seam has a ladder, self-heal and retries; a model's short answer is a failure to retry from,
 * never an abort.
 *
 * Driven through the real assignAgentRoles with a stub runner that answers as run 7's model did
 * on the first call and completely on the second; the stub records every prompt it was sent, so
 * the corrective note — naming the unassigned stories — is asserted on what the model actually
 * received, and the rung it was asked at.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const TEN = Array.from({ length: 10 }, (_, i) => `REGI-${String(i + 1).padStart(3, '0')}`);
const full = { assignments: TEN.map((id) => ({ storyId: id, agentRole: 'data-engineer', reason: 'r' })) };
const one = { assignments: [{ storyId: 'REGI-001', agentRole: 'data-engineer', reason: 'r' }] };

/** A stub model: replies in order, one per call; each prompt it receives is kept. */
function fixture(replies: object[]) {
  const d = mkdtempSync(join(tmpdir(), 'assign-retry-')); dirs.push(d);
  const agents = join(d, 'agents'); mkdirSync(agents);
  const project = join(d, 'project'); mkdirSync(project);
  const calls = join(d, 'calls'); mkdirSync(calls);
  writeFileSync(join(agents, 'profiles.json'), JSON.stringify({}));
  writeFileSync(join(project, 'project-roles.json'), JSON.stringify({ roles: ['data-engineer'] }));
  writeFileSync(join(project, 'agent-profiles.json'), JSON.stringify({ profiles: { 'data-engineer': 'brief' } }));
  replies.forEach((r, i) => writeFileSync(join(d, `reply-${i}.json`), JSON.stringify(r)));
  const stub = join(d, 'stub.sh');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `n=$(ls ${calls} | grep -c "^prompt-")`,
    `cat > ${calls}/prompt-$n.txt`,
    `echo "rung=\${EPAM_LADDER_RUNG:-} model=\${EPAM_MODEL:-}" > ${calls}/env-$n.txt`,
    `f=${d}/reply-$n.json; [ -f "$f" ] || f=${d}/reply-$(( ${replies.length} - 1 )).json`,
    'cat "$f"',
  ].join('\n'), { mode: 0o755 });
  return { agents, project, calls, promptExec: { cmd: stub, args: [] }, logDir: join(d, 'logs') };
}

async function assign(stories: any[], replies: object[]) {
  const f = fixture(replies);
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = f.project;
  mkdirSync(f.logDir, { recursive: true });
  try {
    const r = await spec.assignAgentRoles({ promptExec: f.promptExec, stories, profilesPath: join(f.agents, 'profiles.json'), logDir: f.logDir, repoPath: '' });
    return { r, f };
  } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
}

describe('an incomplete assignment is retried with the shortfall named, not aborted', () => {
  it("run 7's shape: one assignment for ten stories, then a complete answer — the run continues", async () => {
    const stories = TEN.map((id) => ({ id, title: id }));
    const { r, f } = await assign(stories, [one, full]);
    expect(r.assigned.length, 'the assigner did not recover from a short answer').toBe(10);
    const prompts = readdirSync(f.calls).filter((x) => x.startsWith('prompt-')).sort();
    expect(prompts.length, 'the model was not asked again').toBe(2);
    const second = readFileSync(join(f.calls, 'prompt-1.txt'), 'utf8');
    for (const id of TEN.slice(1)) expect(second, `the retry did not name ${id} as unassigned`).toContain(id);
    expect(second, 'the retry did not say what was wrong with the previous answer').toMatch(/1 assignment\(s\) received for 10/);
  });

  it('the retry climbs the ladder: the second call is asked at the next rung, on the next model', async () => {
    // The seam's ladder is a declaration: the registry names the position ('mid'), the tier order
    // maps it to a tier, and the tier's chain names the models. All three are the real registry
    // plus an explicit chain, so the climb is asserted on a model name, not on a counter.
    const stories = TEN.map((id) => ({ id, title: id }));
    const f = fixture([one, full]);
    const prev = { ...process.env };
    process.env.EPAM_PROJECT_CONFIG_DIR = f.project;
    process.env.AGENT_PROFILES_REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
    process.env.EPAM_MODEL_LADDER_TIER_ORDER = 'low,medium,high';
    process.env.EPAM_MODEL_LADDER_MEDIUM = 'first-model=second-model|second-model=third-model';
    process.env.EPAM_MODEL_LADDER_MEDIUM_START = 'first-model';
    mkdirSync(f.logDir, { recursive: true });
    try {
      await spec.assignAgentRoles({ promptExec: f.promptExec, stories, profilesPath: join(f.agents, 'profiles.json'), logDir: f.logDir, repoPath: '' });
    } finally {
      for (const k of ['EPAM_PROJECT_CONFIG_DIR', 'AGENT_PROFILES_REGISTRY', 'EPAM_MODEL_LADDER_TIER_ORDER', 'EPAM_MODEL_LADDER_MEDIUM', 'EPAM_MODEL_LADDER_MEDIUM_START']) {
        if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
    }
    expect(readFileSync(join(f.calls, 'env-0.txt'), 'utf8')).toMatch(/rung=0 model=first-model/);
    expect(readFileSync(join(f.calls, 'env-1.txt'), 'utf8'), 'the retry was made at the same rung, on the same model').toMatch(/rung=1 model=second-model/);
  });

  it('a model that never answers completely is refused after the ladder is spent — with the shortfall named', async () => {
    const stories = TEN.map((id) => ({ id, title: id }));
    await expect(assign(stories, [one])).rejects.toThrow(/1 assignment\(s\) received for 10 story\/ies.*REGI-010/s);
  });

  it('a complete first answer is not retried', async () => {
    const stories = TEN.map((id) => ({ id, title: id }));
    const { f } = await assign(stories, [full]);
    expect(readdirSync(f.calls).filter((x) => x.startsWith('prompt-')).length).toBe(1);
  });
});
