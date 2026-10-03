/**
 * A TICKET THAT SPANS CODELINES, RUN THROUGH THE REAL LAUNCHER AT £0 — PAUSE 1, PAUSE 2, THE WRITER.
 *
 * Operator, 2026-10-02: "I need a real multi lane worktree test devised and run and proven". The
 * AMSD-2974 writer relaunch (four codelines: a shared library and three sites consuming it) re-ran
 * every lane's spec pass on resume, overwrote the spec the operator had approved at pause 2, and
 * wrote straight into the library's checkout instead of a worktree. Every test before this lifted
 * one block; nothing drove a multi-codeline estate through the project's own launcher.
 *
 * This does, the way the operator does: `pipeline --jira <ticket>` to pause 1, the same command
 * resumed to pause 2, and resumed again into the writer. The estate is test/fixtures/multi-lane-estate
 * — real git repositories with their own origins and baselines (one site still on an old story
 * branch), and the project's own declarations (lanes run in sequence, local dependency overrides).
 * Every model call is answered by the mocking agent; the tracker is the stub tracker. Nothing of the
 * pipeline is imported, lifted or stubbed.
 *
 * What must hold, each read from the disk and the journal, never from the launcher's own words alone:
 *   pause 2  — every lane checkpointed pre-writer; the spec pass ran.
 *   writer   — NO spec-pass seam is called; each lane's PRD is the one approved at pause 2;
 *              each codeline's checkout ends on its story branch, cut from its own baseline;
 *              the writer worked in a worktree, never in the checkout; each site built against the
 *              library's current checkout without saving it to its manifest.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, cpSync, symlinkSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { ROOT, fixtureInstall, edgeFor, zeroCostEnv, run } from '../integration/lib/fixture-install';
import { MockAgent } from './agent';
import { World } from './world';
import { correct } from './seams';
import { configFor, standInsFor, vendorEdge, type ProjectRun } from './harness';

const FIXTURE = join(ROOT, 'test/fixtures/multi-lane-estate');
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (!process.env.MOCK_AGENT_KEEP) for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const cfgValue = (file: string, key: string) => ((readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
const tail = (t: string, n = 60) => strip(t).split('\n').slice(-n).join('\n');

/** Seams named by what the registry says they PRODUCE — never by their names. */
function seamsProducing(install: string, what: string[]): Set<string> {
  const reg = JSON.parse(readFileSync(join(install, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, { produces?: string }>;
  return new Set(Object.entries(reg).filter(([, p]) => p && what.includes(String(p.produces))).map(([k]) => k));
}

/** The estate on disk: each codeline a clone of its own bare origin, laid out as estate.json declares. */
function buildEstate(workspace: string): string {
  const layout = JSON.parse(readFileSync(join(FIXTURE, 'estate.json'), 'utf8')).codelines as { dir: string; branches: string[]; checkedOut: string }[];
  const root = join(workspace, 'codelines'); mkdirSync(root, { recursive: true });
  for (const c of layout) {
    const origin = join(workspace, 'origins', `${c.dir}.git`);
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q', '--bare', `--initial-branch=${c.branches[0]}`);
    const seed = join(workspace, 'seeds', c.dir);
    cpSync(join(FIXTURE, 'codelines', c.dir), seed, { recursive: true });
    git(seed, 'init', '-q', `--initial-branch=${c.branches[0]}`);
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'baseline');
    git(seed, 'remote', 'add', 'origin', origin);
    for (const b of c.branches) { if (b !== c.branches[0]) git(seed, 'branch', b); git(seed, 'push', '-q', 'origin', b); }
    const clone = join(root, c.dir);
    git(workspace, 'clone', '-q', origin, clone);
    if (!c.branches.includes(c.checkedOut)) {
      git(clone, 'checkout', '-q', '-b', c.checkedOut);
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'an earlier story');
    } else if (git(clone, 'branch', '--show-current') !== c.checkedOut) {
      git(clone, 'checkout', '-q', c.checkedOut);
    }
  }
  // INSTALLED, AS A REAL CHECKOUT IS: each codeline's node_modules/.bin holds the tools its scripts
  // run, linked from this repository's install; the packages themselves resolve from above the
  // codelines. A codeline's node_modules is its own directory, so the pipeline's installs there
  // (the local dependency overrides) touch nothing outside it.
  symlinkSync(join(ROOT, 'node_modules'), join(workspace, 'node_modules'));
  // INSTALLED, AS A REAL SITE IS: a site declaring another codeline's package carries that package's
  // RELEASE (the baseline) in its own node_modules — what a lane must NOT test against.
  const manifests = Object.fromEntries(layout.map((c) => [c.dir, JSON.parse(readFileSync(join(root, c.dir, 'package.json'), 'utf8'))]));
  for (const c of layout) {
    for (const dep of Object.keys(manifests[c.dir].dependencies || {})) {
      const provider = layout.find((p) => manifests[p.dir].name === dep);
      if (provider) cpSync(join(FIXTURE, 'codelines', provider.dir), join(root, c.dir, 'node_modules', dep), { recursive: true });
    }
  }
  const scripts = (dir: string) => Object.values(JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts || {}) as string[];
  for (const c of layout) {
    const bin = join(root, c.dir, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
    for (const tool of new Set(scripts(c.dir).map((s) => s.split(/\s+/)[0]))) {
      if (existsSync(join(ROOT, 'node_modules/.bin', tool))) symlinkSync(join(ROOT, 'node_modules/.bin', tool), join(bin, tool));
    }
  }
  return root;
}

async function startTracker(issues: string): Promise<string> {
  const p = spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js'), '--issues', issues], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(p);
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    p.stdout!.on('data', (d) => { out += d; const m = /LISTENING:(\d+)/.exec(out); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    setTimeout(() => reject(new Error('the stub tracker never reported a port')), 10_000);
  });
}

describe('a ticket spanning four codelines runs through pause 1, pause 2 and the writer — every lane in a worktree', () => {
  it('runs the real launcher three times and holds every invariant', async () => {
    const journal = join(JOURNALS, `multi-lane-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });

    const install = fixtureInstall(dirs);
    const project = cfgValue(join(FIXTURE, 'project/config.env'), 'PROJECT_NAME');
    expect(project, 'the fixture project declares no PROJECT_NAME').toBeTruthy();
    const projDir = join(install, 'orchestrations/projects', project);
    cpSync(join(FIXTURE, 'project'), projDir, { recursive: true });

    const workspace = mkdtempSync(join(tmpdir(), 'multi-lane-estate-')); dirs.push(workspace);
    const codelineRoot = buildEstate(workspace);
    const codelines = () => readdirSync(codelineRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.includes('-wt-')).map((d) => join(codelineRoot, d.name));
    const trackerUrl = await startTracker(join(projDir, 'tracker-issues.json'));
    const ticket = JSON.parse(readFileSync(join(projDir, 'tracker-issues.json'), 'utf8'))[0].key as string;

    // THE SET THE PROJECT DECLARES ITS PROVIDER HALF FOR — its own config.<suffix>.env, one of them.
    const sets = JSON.parse(readFileSync(join(install, 'orchestrations/config/provider-sets.json'), 'utf8')).sets as Record<string, { projectEnvSuffix?: string }>;
    const declared = Object.entries(sets).filter(([, s]) => s.projectEnvSuffix && existsSync(join(projDir, `config.${s.projectEnvSuffix}.env`))).map(([k]) => k);
    const set = process.env.MOCK_AGENT_PROVIDER_SET || declared[0];
    expect(set, 'the fixture project declares no provider set overlay').toBeTruthy();
    const config: Record<string, string> = { EPAM_PROVIDER_SET: set };

    const prd = join(projDir, 'prd.json');
    const stories = () => { try { return (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: { id: string }) => s.id); } catch { return []; } };
    const agent = new MockAgent(join(install, 'orchestrations'), journal, stories, ['brownfield', 'multi-codeline']);
    await agent.start();
    const { bin } = edgeFor(install, agent.url, children);
    const world = new World(codelines, () => prd, projDir);
    agent.on('*', correct(world, install));
    const codemie = await standInsFor(install, agent, journal, config);
    const r = { install, out: '', agent, project, prd, config, realOut: '', world, codemie } as ProjectRun;

    const env = zeroCostEnv(bin, agent.url, {
      ...configFor(install, project, config), ...vendorEdge(r),
      EPAM_FREE_RUN: '1', EPAM_PROJECT_CONFIG_DIR: '',
      JIRA_URL: trackerUrl, JIRA_EMAIL: 'mock@test.com', JIRA_TOKEN: 'mock-token',
      JIRA_CODELINE_ROOT: codelineRoot,
      // As the operator launches this shape: lanes one at a time, both pauses on.
      EPAM_PARALLEL_CODELINES: '0', EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_PAUSE_BEFORE_WRITER: '1',
      SKIP_REGRESSION_GUARD: 'true',
      // The estate's packages come from the estate; npm never reaches a registry from this test.
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    });
    // THE NPM TRIPWIRE (operator, 2026-10-03: nothing installed, packed, published or fetched): a script
    // verb passes through to the real npm; any other verb is recorded and refused.
    const trip = join(workspace, 'tripwire'); mkdirSync(trip);
    const npmLog = join(journal, 'npm-calls.log');
    const realNpm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    // Script verbs only — the project's own scripts (run, run-script, test). Everything else (install,
    // ci, add, pack, publish, view…) is refused and recorded.
    writeFileSync(join(trip, 'npm'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(npmLog)}\ncase "$1" in run|run-script|test|t) ;; *) echo "TRIPWIRE: npm $1 refused" >&2; exit 97;; esac\nexec ${JSON.stringify(realNpm)} "$@"\n`);
    chmodSync(join(trip, 'npm'), 0o755);
    env.PATH = `${trip}:${env.PATH}`;
    const launcher = join(install, 'orchestrations/scripts/pipeline');
    const keep = (name: string, text: string) => {
      writeFileSync(join(journal, `${name}.log`), text);
      try { execFileSync('cp', ['-a', join(install, 'orchestrations/logs'), join(journal, `${name}-logs`)]); } catch { /* absent */ }
      try { execFileSync('cp', ['-a', join(projDir, 'runs'), join(journal, `${name}-runs`)]); } catch { /* absent */ }
    };
    const SPEC = seamsProducing(install, ['story-specification', 'fix-plan', 'spec-assignments']);
    const WRITER = seamsProducing(install, ['implementation']);
    expect(SPEC.size, 'the registry declares no spec-pass seam').toBeGreaterThan(0);
    console.log(`[multi-lane] install ${install}\n  estate ${codelineRoot}\n  journal ${journal}\n  set ${set}`);

    // ── 1. START → PAUSE 1 ────────────────────────────────────────────────────────────────────
    const r1 = await run('bash', [launcher, '--jira', ticket], { cwd: install, env, timeout: 40 * 60_000 });
    const t1 = r1.stdout + r1.stderr; keep('1-pause1', t1);
    console.log(`[multi-lane] pause 1: exit ${r1.status}; ${agent.calls.length} model call(s)`);
    expect(agent.calls.length, `no model call reached the agent — log tail:\n${tail(t1)}`).toBeGreaterThan(0);
    expect(strip(t1), `the run did not pause after the mint — log tail:\n${tail(t1)}`).toMatch(/PAUSED — agents minted/);
    const runId = (strip(t1).match(/RUN NUMBER:\s+(\S+)/) || [])[1];
    expect(runId, `no run number reported — log tail:\n${tail(t1)}`).toBeTruthy();
    const runDir = join(projDir, 'runs', runId);

    // ── 2. RESUME → PAUSE 2 ───────────────────────────────────────────────────────────────────
    const c2 = agent.calls.length;
    const r2 = await run('bash', [launcher, '--jira', ticket], { cwd: install, env: { ...env, EPAM_RESUME_RUN: runId }, timeout: 60 * 60_000 });
    const t2 = r2.stdout + r2.stderr; keep('2-pause2', t2);
    const calls2 = agent.calls.slice(c2);
    console.log(`[multi-lane] pause 2: exit ${r2.status}; ${calls2.length} model call(s): ${[...new Set(calls2.map((c) => c.seam))].join(', ')}`);
    expect(calls2.some((c) => SPEC.has(c.seam)), `the spec pass never ran before pause 2 — log tail:\n${tail(t2)}`).toBe(true);
    const lanesDir = join(runDir, 'lanes');
    const lanes = existsSync(lanesDir) ? readdirSync(lanesDir) : [];
    expect(lanes.length, `no lane checkpointed — log tail:\n${tail(t2)}`).toBe(codelines().length);
    const approved: Record<string, { prd: string; story: string }> = {};
    for (const l of lanes) {
      const ck = join(lanesDir, l, 'checkpoint');
      expect(JSON.parse(readFileSync(join(ck, 'checkpoint.json'), 'utf8')).stage, `lane ${l} did not reach pause 2`).toBe('pre-writer');
      const f = join(ck, 'prd.json');
      approved[l] = { prd: f, story: readFileSync(f, 'utf8') };
    }
    // Every codeline is still where the operator left it: nothing is written before the writer.
    for (const c of codelines()) expect(git(c, 'status', '--porcelain', '--untracked-files=no'), `${basename(c)} was changed before the writer`).toBe('');

    // ── 3. RESUME → THE WRITER ────────────────────────────────────────────────────────────────
    const c3 = agent.calls.length;
    const r3 = await run('bash', [launcher, '--jira', ticket], { cwd: install, env: { ...env, EPAM_RESUME_RUN: runId }, timeout: 90 * 60_000 });
    const t3 = r3.stdout + r3.stderr; keep('3-writer', t3);
    const calls3 = agent.calls.slice(c3);
    console.log(`[multi-lane] writer: exit ${r3.status}; ${calls3.length} model call(s): ${[...new Set(calls3.map((c) => c.seam))].join(', ')}`);
    writeFileSync(join(journal, 'writer-calls.json'), JSON.stringify(calls3.map((c) => ({ n: c.n, seam: c.seam, story: c.story })), null, 1));

    // THE SPEC APPROVED AT PAUSE 2 IS THE SPEC THE WRITER GETS: no spec seam is asked again, and no
    // lane's approved PRD is rewritten by the resume.
    const respec = calls3.filter((c) => SPEC.has(c.seam)).map((c) => `#${c.n} ${c.seam}`);
    expect(respec, `the writer resume re-ran the spec pass — log tail:\n${tail(t3)}`).toEqual([]);
    // What the spec pass decided, per story: a later save of the same checkpoint may restamp it, but
    // never with different content.
    const specOf = (text: string) => (JSON.parse(text).stories || []).map((s: any) => ({
      id: s.id, title: s.title, description: s.description, verificationCriteria: s.verificationCriteria,
      fixSiteAnalysis: s.fixSiteAnalysis, specRunId: s.specification?.runId, specUpdatedAt: s.specification?.updatedAt,
    }));
    for (const [l, a] of Object.entries(approved)) {
      expect(specOf(a.story).length, `lane ${l}'s approved checkpoint holds no story`).toBeGreaterThan(0);
      expect(specOf(readFileSync(a.prd, 'utf8')), `lane ${l}'s approved spec was replaced by the resume`).toEqual(specOf(a.story));
    }
    expect(calls3.some((c) => WRITER.has(c.seam)), `the writer was never invoked — log tail:\n${tail(t3)}`).toBe(true);

    // NEVER IN THE CHECKOUT: no lane ran its story on the main branch, and every lane cut a worktree.
    const text3 = strip(t3);
    expect(text3, 'a lane ran its story in the codeline\'s checkout (Step 8)').not.toMatch(/Step 8: Running main-branch stories/);
    const worktreeWrites = calls3.filter((c) => WRITER.has(c.seam)).map((c) => (/[Ww]orking directory:\s*(\S+)/.exec(c.req.system) || [])[1] || '');
    expect(worktreeWrites.length).toBeGreaterThan(0);
    for (const cwd of worktreeWrites) expect(cwd, `the writer worked in ${cwd}, not a worktree`).toMatch(/-wt-/);

    // EACH CODELINE ENDS ON ITS STORY BRANCH, CUT FROM ITS OWN BASELINE, WITH THE LANE'S WORK MERGED.
    const layout = JSON.parse(readFileSync(join(FIXTURE, 'estate.json'), 'utf8')).codelines as { dir: string; branches: string[] }[];
    const prefix = cfgValue(join(projDir, 'config.env'), 'EPAM_BRANCH_PREFIX');
    for (const c of layout) {
      const clone = join(codelineRoot, c.dir);
      const branch = git(clone, 'branch', '--show-current');
      expect(branch, `${c.dir} is not on the story branch`).toBe(`${prefix}AI-${ticket}`);
      const own = c.branches.includes(cfgValue(join(projDir, 'config.env'), 'JIRA_BASELINE_BRANCH')) ? cfgValue(join(projDir, 'config.env'), 'JIRA_BASELINE_BRANCH') : c.branches[0];
      expect(spawnOk(clone, ['merge-base', '--is-ancestor', `origin/${own}`, 'HEAD']), `${c.dir}'s story branch is not cut from origin/${own}`).toBe(true);
      expect(Number(git(clone, 'rev-list', '--count', `origin/${own}..HEAD`)), `${c.dir} carries no work from its lane`).toBeGreaterThan(0);
      // …and none of it landed anywhere else: an agent started outside its codeline writes the
      // codeline's relative paths into the install (the repro writer did, run 11).
      for (const f of git(clone, 'diff', '--name-only', `origin/${own}`, 'HEAD').split('\n').filter(Boolean)) {
        // A path the engine itself ships (its own package-lock.json) is the install's, not a leak.
        if (existsSync(join(ROOT, f))) continue;
        expect(existsSync(join(install, f)), `${c.dir}'s ${f} was also written into the install folder`).toBe(false);
      }
    }

    // NOTHING INSTALLED, PACKED OR FETCHED: npm was only ever asked to run a declared script.
    const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    for (const c of npmCalls) expect(c, `npm ${c} — only the project's own scripts may run`).toMatch(/^(run|run-script|test|t)\b/);
    // EACH SITE'S OWN INSTALL IS UNTOUCHED: its baseline keeps the provider's release.
    const mf = (d: string) => JSON.parse(readFileSync(join(FIXTURE, 'codelines', d, 'package.json'), 'utf8'));
    for (const c of layout) {
      for (const dep of Object.keys(mf(c.dir).dependencies || {})) {
        const provider = layout.find((p) => mf(p.dir).name === dep);
        if (!provider) continue;
        const installed = join(codelineRoot, c.dir, 'node_modules', dep);
        for (const f of ['package.json', 'src/toast.js']) {
          if (!existsSync(join(FIXTURE, 'codelines', provider.dir, f))) continue;
          expect(readFileSync(join(installed, f), 'utf8'), `${c.dir}'s installed ${dep} was changed`).toBe(readFileSync(join(FIXTURE, 'codelines', provider.dir, f), 'utf8'));
        }
      }
    }

    expect(agent.stale, 'the agent generated answers the current code cannot accommodate').toEqual([]);
    if (codemie) await codemie.stop();
    await agent.stop();
  }, 200 * 60_000);
});

function spawnOk(cwd: string, args: string[]): boolean {
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}
