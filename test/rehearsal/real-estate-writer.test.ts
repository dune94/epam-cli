/**
 * THE OPERATOR'S RELAUNCH, ON A COPY OF THE REAL ESTATE, AT £0.
 *
 * Operator, 2026-10-05: "make your tests real even if you have to make a codeline copy". Every earlier
 * proof ran on fixtures and missed what the real codelines carry: next.gotransit.com's commitlint hook
 * refused the pipeline's merge commit after the writer had passed, live.
 *
 * Input: REHEARSAL_ROOT built by test/rehearsal/real-estate-setup.sh — whole copies of the real
 * codelines (hooks, node_modules, .epam) with local mirrors as origin, and a copy of the real install
 * holding the run being resumed. The launch is the operator's: the same resume, passed lanes, pauses,
 * sequential lanes and provider set. Only the model is the mock agent (the copilot set's own BYOK
 * redirect, offline); Jira points at a closed local port. Nothing touches the real repos or install.
 *
 * Holds when: the run exits 0; every non-passed lane reports its phase done; no worktree merge failed;
 * each site codeline's story branch carries a merge of its lane's work, accepted by the codeline's own
 * commit hook.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { edgeFor, zeroCostEnv, run } from '../integration/lib/fixture-install';
import { MockAgent } from '../mock-agent/agent';
import { World } from '../mock-agent/world';
import { correct } from '../mock-agent/seams';
import { configFor, standInsFor, vendorEdge, type ProjectRun } from '../mock-agent/harness';

const R = process.env.REHEARSAL_ROOT || '';
const RUN = process.env.REHEARSAL_RESUME_RUN || '';
const TICKET = process.env.REHEARSAL_TICKET || '';
const PROJECT = process.env.REHEARSAL_PROJECT || '';
const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');

describe.runIf(R && RUN && TICKET && PROJECT)('the operator relaunch on a copy of the real estate', () => {
  it('runs every lane through the writer, the merge and the gates', async () => {
    const install = join(R, 'install');
    const codelineRoot = join(R, 'codelines');
    const journal = join(R, 'journal', new Date().toISOString().replace(/[:.]/g, '')); mkdirSync(journal, { recursive: true });
    const projDir = join(install, 'orchestrations/projects', PROJECT);
    const prd = join(projDir, 'prd.json');
    const codelines = () => readdirSync(codelineRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.includes('-wt-')).map((d) => join(codelineRoot, d.name));
    const stories = () => { try { return (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: { id: string }) => s.id); } catch { return []; } };
    const config: Record<string, string> = { EPAM_PROVIDER_SET: process.env.REHEARSAL_PROVIDER_SET || 'copilot' };

    const agent = new MockAgent(join(install, 'orchestrations'), journal, stories, ['brownfield', 'multi-codeline']);
    await agent.start();
    const { bin } = edgeFor(install, agent.url, children);
    const world = new World(codelines, () => prd, projDir);
    agent.on('*', correct(world, install));
    const codemie = await standInsFor(install, agent, journal, config);
    const r = { install, out: '', agent, project: PROJECT, prd, config, realOut: '', world, codemie } as ProjectRun;

    const passthrough = Object.fromEntries(['EPAM_PASSED_LANES', 'EPAM_ESTIMATION_MANIFEST', 'EPAM_AGENT_MEMORY_SHARE', 'NODE_OPTIONS', 'EPAM_WHOLE_SUITE_CHECK']
      .filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));
    const env = zeroCostEnv(bin, agent.url, {
      ...configFor(install, PROJECT, config), ...vendorEdge(r), ...passthrough,
      EPAM_FREE_RUN: '1',
      JIRA_URL: 'http://127.0.0.1:9', JIRA_EMAIL: 'rehearsal@local', JIRA_TOKEN: 'rehearsal-no-access',
      JIRA_CODELINE_ROOT: codelineRoot,
      EPAM_RESUME_RUN: RUN,
      EPAM_PARALLEL_CODELINES: '0', EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_PAUSE_BEFORE_WRITER: '1',
      SKIP_REGRESSION_GUARD: 'true',
    });
    // vendorEdge set the set's credential to a placeholder no service accepts; any other token is dropped.
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    expect(env.COPILOT_GITHUB_TOKEN || '', 'a real-looking Copilot token reached the rehearsal').not.toMatch(/^(gho_|ghp_|ghu_|github_pat_)/);

    const res = await run('bash', [join(install, 'orchestrations/scripts/pipeline'), '--jira', TICKET], { cwd: install, env, timeout: 4 * 60 * 60_000 });
    const text = strip(res.stdout + res.stderr);
    writeFileSync(join(journal, 'launch.log'), text);
    writeFileSync(join(journal, 'calls.json'), JSON.stringify(agent.calls.map((c) => ({ n: c.n, seam: c.seam, story: c.story })), null, 1));
    const tail = text.split('\n').slice(-80).join('\n');
    console.log(`[rehearsal] exit ${res.status}; ${agent.calls.length} model call(s); journal ${journal}`);

    expect(agent.calls.length, `no model call reached the mock — log tail:\n${tail}`).toBeGreaterThan(0);
    expect(text, 'a worktree merge failed').not.toMatch(/Failed to merge wt-/);
    expect(text, `a lane failed — log tail:\n${tail}`).not.toMatch(/Phase '[a-z]+' for '[a-z]+' failed/);
    expect(res.status, `the run did not finish — log tail:\n${tail}`).toBe(0);
    const passed = new Set((process.env.EPAM_PASSED_LANES || '').split(/[\s,]+/).filter(Boolean));
    const lanes = [...text.matchAll(/Codeline '([a-z0-9]+)' — \d+ stories/g)].map((m) => m[1]).filter((l) => !passed.has(l));
    expect(lanes.length, 'no lane ran').toBeGreaterThan(0);
    for (const l of lanes) expect(text, `lane ${l} did not finish its phase`).toMatch(new RegExp(`Phase '[a-z]+' — '${l}' done`));
    for (const c of codelines()) {
      const merges = git(c, 'log', '--merges', '--format=%s', '-5', 'HEAD');
      if (/merge phase/.test(merges)) expect(merges, `${c}: the lane merge is not on the story branch`).toMatch(new RegExp(`${TICKET}: merge phase`));
    }
  }, 4 * 60 * 60_000);
});
