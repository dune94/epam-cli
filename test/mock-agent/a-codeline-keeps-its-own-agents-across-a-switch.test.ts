/**
 * A CODELINE KEEPS ITS OWN AGENTS AND PROMPTS ACROSS A SWITCH — A, then B, then A again.
 *
 * Operator, 2026-09-30: "If roster/mint and prompt generation is successful it needs to be cached the
 * next run". Live AMSD-2974 runs switched codeline between launches (secure.gotransit.com, then
 * next.gotransit.com); run 3 served one codeline's minted agents to the other.
 *
 * The seeded project's own launcher, run three times in ONE install, each time to the pause before
 * the writer, every model call answered by the mocking agent. The codeline is named per launch
 * (MOCK1_CODELINE_NAME). After A's second run: nothing was minted or generated again, and the minted
 * agents and prompts on disk are A's own — not B's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type ChildProcess } from 'node:child_process';
import { ROOT, fixtureInstall, edgeFor, zeroCostEnv, run } from '../integration/lib/fixture-install';
import { MockAgent } from './agent';
import { World } from './world';
import { correct } from './seams';
import { currentConfig, configFor, standInsFor, vendorEdge, type ProjectRun } from './harness';

const SRC = process.env.MOCK_AGENT_INSTALL || ROOT;
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const LAUNCHER = 'orchestrations/scripts/mock1-paused-run.sh';
const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const seamProducing = (install: string, what: string): string => {
  const reg = JSON.parse(readFileSync(join(install, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
  const hit = Object.entries(reg).find(([, p]) => p && p.produces === what);
  if (!hit) throw new Error(`no seam produces '${what}'`);
  return hit[0];
};

/** Every file of a directory, by name → content (a directory that does not exist is empty). */
const snapshot = (dir: string): Record<string, string> => (existsSync(dir)
  ? Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
  : {});

describe('a codeline keeps its own agents and prompts across a switch', () => {
  it('A, then B, then A: A\'s second run mints and generates nothing, and runs on A\'s own agents and prompts', async () => {
    const journal = join(JOURNALS, `codeline-switch-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const install = fixtureInstall(dirs);
    const projects = join(install, 'orchestrations/projects');
    const project = readdirSync(projects).filter((d) => existsSync(join(projects, d, 'seed')))[0];
    expect(project, 'no project carries a seed/').toBeTruthy();
    const projDir = join(projects, project);
    const builder = require(join(install, 'orchestrations/scripts/lib/project-prompt-builder.js'));
    const minted = () => Object.fromEntries((builder.MINTED_FILES as string[]).filter((f) => existsSync(join(projDir, f))).map((f) => [f, readFileSync(join(projDir, f), 'utf8')]));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'mock-agent-switch-ws-')); dirs.push(workspaceRoot);
    const newest = () => readdirSync(workspaceRoot).map((d) => join(workspaceRoot, d, 'workspace')).filter(existsSync).sort().pop() || '';
    const prdPath = () => join(newest(), 'synthesized-prd.json');
    const codelines = () => { const c = join(newest(), 'codelines'); return existsSync(c) ? readdirSync(c, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(c, d.name)) : []; };
    const stories = () => { try { return (JSON.parse(readFileSync(prdPath(), 'utf8')).stories || []).map((s: any) => s.id); } catch { return []; } };
    const agent = new MockAgent(join(install, 'orchestrations'), journal, stories, ['brownfield']);
    await agent.start();
    const { bin } = edgeFor(install, agent.url, children);
    const world = new World(codelines, prdPath, projDir);
    agent.on('*', correct(world, install));
    const config = currentConfig(SRC);
    const codemie = await standInsFor(install, agent, journal, config);
    const r = { install, out: '', agent, project, prd: '', config, realOut: '', world, codemie } as ProjectRun;
    const env = zeroCostEnv(bin, agent.url, { ...configFor(install, project, config), ...vendorEdge(r), EPAM_FREE_RUN: '1', MOCK1_WORKSPACE_ROOT: workspaceRoot, EPAM_PROJECT_CONFIG_DIR: '' });
    const tail = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-40).join('\n');
    const MINT = seamProducing(install, 'agent-roster');
    const BUILD = seamProducing(install, 'project-prompts');

    const launch = async (codeline: string) => {
      const before = agent.calls.length;
      const res = await run('bash', [join(install, LAUNCHER)], { cwd: install, env: { ...env, MOCK1_CODELINE_NAME: codeline }, timeout: 40 * 60_000 });
      const text = res.stdout + res.stderr;
      require('node:fs').writeFileSync(join(journal, `${codeline}-${before}.log`), text);
      expect(text, `${codeline}: the run did not reach the pause before the writer — log tail:\n${tail(text)}`).toMatch(/STOPPED before the writer/);
      return { text, calls: agent.calls.slice(before) };
    };

    const a1 = await launch('codeline-a');
    expect(a1.calls.some((c) => c.seam === MINT), 'A\'s first run minted nothing — the case proves nothing').toBe(true);
    const aAgents = minted(); const aPrompts = snapshot(join(projDir, 'prompts'));
    expect(Object.keys(aAgents).length, 'A\'s first run left no minted agents').toBeGreaterThan(0);
    expect(Object.keys(aPrompts).length, 'A\'s first run left no prompts').toBeGreaterThan(0);

    const b = await launch('codeline-b');
    expect(b.calls.some((c) => c.seam === MINT), 'B was never minted — the switch proves nothing').toBe(true);
    expect(minted(), 'B ran on A\'s agents').not.toEqual(aAgents);

    const a2 = await launch('codeline-a');
    const seams = [...new Set(a2.calls.map((c) => c.seam))].join(', ');
    expect(a2.calls.filter((c) => c.seam === MINT).length, `A was minted again (calls: ${seams}) — log tail:\n${tail(a2.text)}`).toBe(0);
    expect(a2.calls.filter((c) => c.seam === BUILD).length, `A's prompts were generated again (calls: ${seams})`).toBe(0);
    expect(minted(), 'A\'s second run is not on A\'s own minted agents').toEqual(aAgents);
    expect(snapshot(join(projDir, 'prompts')), 'A\'s second run is not on A\'s own prompts').toEqual(aPrompts);

    if (codemie) await codemie.stop();
    await agent.stop();
  }, 120 * 60_000);
});
