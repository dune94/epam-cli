/**
 * OBSERVE BROWNFIELD: THE SEEDED BROWNFIELD PROJECT, RUN AT £0 AGAINST THE MOCKING AGENT — ON ANY SET.
 *
 * The seeded project's own launcher (mock1-paused-run.sh) builds a client codeline from the seed,
 * serves one ticket from the stub tracker and runs the real pipeline, pausing before the writer; then
 * `--resume` continues into the writer, the gates and the phase gate. Every model call is answered by
 * the mocking agent, on the set MOCK_AGENT_PROVIDER_SET names (default: the install's own), with every
 * endpoint that set calls pointed at the agent (vendorEdge) — so a set that cannot be rehearsed is
 * refused rather than run against a real model. No project, set or stack is named here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { ROOT, fixtureInstall, edgeFor, zeroCostEnv, run } from '../integration/lib/fixture-install';
import { MockAgent } from './agent';
import { World } from './world';
import { correct } from './seams';
import { currentConfig, configFor, standInsFor, vendorEdge, rehearsedSet, type ProjectRun } from './harness';

const SRC = process.env.MOCK_AGENT_INSTALL || ROOT;
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const LAUNCHER = 'orchestrations/scripts/mock1-paused-run.sh';
const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A seam named by what the registry says it PRODUCES — never by its name. */
const seamProducing = (install: string, what: string): string => {
  const reg = JSON.parse(readFileSync(join(install, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
  const hit = Object.entries(reg).find(([, p]) => p && p.produces === what);
  if (!hit) throw new Error(`no seam produces '${what}'`);
  return hit[0];
};

describe('the mocking agent drives the seeded brownfield project at £0', () => {
  it('pauses before the writer, resumes, and completes its phase — every model call answered by the agent', async () => {
    const journal = join(JOURNALS, `brownfield-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const install = fixtureInstall(dirs);
    const projects = join(install, 'orchestrations/projects');
    const seeded = readdirSync(projects).filter((d) => existsSync(join(projects, d, 'seed')));
    expect(seeded, 'the launcher needs exactly one project carrying a seed/').toHaveLength(1);
    const project = seeded[0]; const projDir = join(projects, project);
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'mock-agent-bf-ws-')); dirs.push(workspaceRoot);

    // THE RUN'S OWN PRD AND CODELINE: written by ingest and the launcher under the workspace, found there.
    const newest = () => readdirSync(workspaceRoot).map((d) => join(workspaceRoot, d, 'workspace')).filter(existsSync).sort().pop() || '';
    const prdPath = () => join(newest(), 'synthesized-prd.json');
    const codelines = () => { const c = join(newest(), 'codelines'); return existsSync(c) ? readdirSync(c, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ path: join(c, d.name) })) as any : []; };
    const stories = () => { try { return (JSON.parse(readFileSync(prdPath(), 'utf8')).stories || []).map((s: any) => s.id); } catch { return []; } };
    const agent = new MockAgent(join(install, 'orchestrations'), journal, stories, ['brownfield']);
    await agent.start();
    const { bin } = edgeFor(install, agent.url, children);
    const world = new World(() => codelines().map((c: { path: string }) => c.path), prdPath, projDir);
    agent.on('*', correct(world, install));
    const config = currentConfig(SRC);
    const codemie = await standInsFor(install, agent, journal, config);
    const r = { install, out: '', agent, project, prd: '', config, realOut: '', world, codemie } as ProjectRun;
    const env = zeroCostEnv(bin, agent.url, { ...configFor(install, project, config), ...vendorEdge(r), EPAM_FREE_RUN: '1', MOCK1_WORKSPACE_ROOT: workspaceRoot, EPAM_PROJECT_CONFIG_DIR: '' });
    const keep = (name: string, text: string) => {
      writeFileSync(join(journal, `${name}.log`), text);
      for (const [from, to] of [[join(install, 'orchestrations/logs'), `${name}-logs`], [newest(), `${name}-workspace`]] as const) {
        try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
      }
    };

    const r1 = await run('bash', [join(install, LAUNCHER)], { cwd: install, env, timeout: 40 * 60_000 });
    const text = r1.stdout + r1.stderr; keep('pause', text);
    const tail = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-50).join('\n');
    console.log(`[mock-agent] brownfield ${project} on '${rehearsedSet(install, config)}': pause exit ${r1.status}; ${agent.calls.length} model call(s)\n  journal: ${journal}`);
    expect(agent.calls.length, `no model call reached the agent — log tail:\n${tail(text)}`).toBeGreaterThan(0);
    expect(text, `the specification pass did not complete — log tail:\n${tail(text)}`).toMatch(/Specification pass completed/);
    expect(text, `the run did not pause before the writer — log tail:\n${tail(text)}`).toMatch(/STOPPED before the writer/);
    expect(r1.status, `launcher exited ${r1.status} — log tail:\n${tail(text)}`).toBe(0);
    const runId = (text.match(/RUN NUMBER:\s+(\S+)/) || [])[1];
    expect(runId, 'no run number reported').toBeTruthy();

    const before = agent.calls.length;
    const r2 = await run('bash', [join(install, LAUNCHER), '--resume', runId], { cwd: install, env, timeout: 40 * 60_000 });
    const text2 = r2.stdout + r2.stderr; keep('resume', text2);
    const resumed = agent.calls.slice(before);
    const WRITER = seamProducing(install, 'implementation');
    console.log(`[mock-agent] brownfield resume exit ${r2.status}; ${resumed.length} model call(s): ${[...new Set(resumed.map((c) => c.seam))].join(', ')}`);
    expect(resumed.some((c) => c.seam === WRITER), `the writer was never invoked on resume — log tail:\n${tail(text2)}`).toBe(true);
    expect(r2.status, `resume exited ${r2.status} — log tail:\n${tail(text2)}`).toBe(0);
    const prd = JSON.parse(readFileSync(prdPath(), 'utf8'));
    const incomplete = (prd.stories || []).filter((st: any) => !st.completed).map((st: any) => st.id);
    expect(incomplete, `stories not completed — log tail:\n${tail(text2)}`).toEqual([]);
    const gates = readFileSync(join(install, 'orchestrations/logs/phase-gates.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(gates.some((g: any) => String(g.decision).toLowerCase() === 'go'), `no phase gate decided GO — log tail:\n${tail(text2)}`).toBe(true);
    const clone = codelines()[0]?.path;
    const commits = spawnSync('git', ['-C', clone, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(commits.length, 'the codeline holds no committed work beyond the seed').toBeGreaterThan(1);
    expect(agent.stale, 'the agent generated answers the current code cannot accommodate').toEqual([]);

    if (codemie) {
      writeFileSync(join(journal, 'codemie-state.json'), JSON.stringify({ assistants: codemie.assistants, integrations: codemie.integrations.map(({ key, ...i }) => i), chats: codemie.chats.length }, null, 1));
      expect(codemie.assistants.length).toBeGreaterThan(0);
      for (const a of codemie.assistants) expect(a.shared, `${a.name} is shared with the team`).toBe(false);
      expect(codemie.engine.connections, 'a CodeMie plugin outlived the run').toBe(0);
      await codemie.stop();
    }
    await agent.stop();
  }, 85 * 60_000);
});
