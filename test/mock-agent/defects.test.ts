/**
 * THE DEFECTS THE MOCKING AGENT FOUND — each proven on the REAL pipeline, driven from outside.
 *
 * Each case launches the install's greenfield project on its current configuration with every seam
 * answering correctly except the ones the case breaks, the way models really break them, and then
 * asserts what the pipeline DID — from its own log and the artefacts it left. Nothing of the
 * pipeline is lifted or stubbed. MOCK_AGENT_INSTALL / MOCK_AGENT_PROJECT choose the project
 * (default: the first greenfield project this repository declares).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { ROOT } from '../integration/lib/fixture-install';
import { startProjectRun, launch, type ProjectRun } from './harness';
import { correct } from './seams';
import { withScenario, type Rule } from './negatives';

const SRC = process.env.MOCK_AGENT_INSTALL || ROOT;
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const PROJECT = process.env.MOCK_AGENT_PROJECT || readdirSync(join(SRC, 'orchestrations/projects')).find((p) => {
  const f = join(SRC, 'orchestrations/projects', p, 'config.env');
  return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8'));
})!;
const ONLY = (process.env.MOCK_AGENT_CASE || '').split(',').filter(Boolean);

const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** One real run under a scenario; the log, the calls and the run's leftovers are kept in the journal. */
async function runWith(name: string, rules: Rule[]): Promise<{ r: ProjectRun; log: string; status: number | null; journal: string }> {
  const journal = join(JOURNALS, `${PROJECT}-${name}-${new Date().toISOString().replace(/[:.]/g, '')}`);
  mkdirSync(journal, { recursive: true });
  const r = await startProjectRun({ src: SRC, project: PROJECT, dirs, children, journal });
  r.agent.on('*', withScenario(correct(r.world, r.install), rules));
  writeFileSync(join(journal, 'scenario.json'), JSON.stringify(rules, null, 1));
  const res = await launch(r);
  const log = `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  writeFileSync(join(journal, 'run.log'), log);
  for (const [from, to] of [[join(r.install, 'orchestrations/logs'), 'logs'], [r.out, 'codeline']] as const) {
    try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
  }
  // Every case is about the pipeline, never the mock: a correct answer the code refused is a mock fault.
  expect(r.agent.stale, 'the agent served answers the current code cannot accommodate').toEqual([]);
  expect(r.agent.calls.length, 'no model call reached the agent').toBeGreaterThan(0);
  return { r, log, status: res.status, journal };
}

const run = (name: string, fn: () => Promise<void>) => ((!ONLY.length || ONLY.includes(name)) ? it : it.skip)(name, fn, 70 * 60_000);

describe(`defects found by the mocking agent, on ${PROJECT}`, () => {
  run('a QA gate that never produced a verdict does not let the phase pass', async () => {
    // Every QA gate — the seams whose declared product is a QA verdict or the runtime-boundary
    // findings — answers in prose, so none produces a verdict after its retries.
    const gateProducts = ['qa-verdict', 'runtime-boundary-findings'];
    const { r, log } = await runWith('gate-no-verdict', gateProducts.map((produces) => ({ produces, negative: 'prose' as const })));
    const asked = [...new Set(r.agent.calls.filter((c) => gateProducts.includes(r.agent.decl.registry[c.seam]?.produces || '')).map((c) => c.seam))];
    expect(asked.length, 'no QA gate was ever asked — the case proves nothing').toBeGreaterThan(0);
    expect(log, 'gates that produced no verdict were counted towards "Testing gates PASSED"').not.toMatch(/Testing gates PASSED/);
    expect(log, 'the testing gates did not report failing').toMatch(/Testing gates FAILED/);
  });

  run('a review that did not answer is asked again before any prompt is installed unreviewed', async () => {
    // Every other reviewer call answers in prose — the reviewer's retry must recover each one.
    const { r, log } = await runWith('review-retry', [{ produces: 'prompt-verdict', negative: 'prose', every: { n: 2, k: 1 } }]);
    expect(r.agent.calls.filter((c) => r.agent.decl.registry[c.seam]?.produces === 'prompt-verdict').length, 'the prompt reviewer was barely asked').toBeGreaterThan(2);
    expect(log, 'a prompt was installed unreviewed after ONE unreadable review — the reviewer was not asked again').not.toMatch(/installing UNREVIEWED/);
    expect(r.agent.calls.some((c) => r.agent.decl.registry[c.seam]?.produces === 'implementation'), 'the run never reached the writer').toBe(true);
  });

  run('the spec coordinator\'s review of each story reaches the story', async () => {
    // Every seam correct. The coordinator answers in the shape its contract and schema bind
    // ({items:[…]}), one item per story — and each specified story must carry that review.
    const { r } = await runWith('spec-review-lands', []);
    expect(r.agent.calls.some((c) => r.agent.decl.registry[c.seam]?.produces === 'spec-assignments'), 'the spec coordinator was never asked').toBe(true);
    const cfg = readFileSync(join(r.install, 'orchestrations/projects', PROJECT, 'config.env'), 'utf8');
    const prdFile = join(r.install, (cfg.match(/^PRD_FILE=(.*)$/m) || [, ''])[1].trim());
    const stories = (JSON.parse(readFileSync(prdFile, 'utf8')).stories || []).filter((s: any) => s.specification);
    expect(stories.length, 'no story was specified — the case proves nothing').toBeGreaterThan(0);
    const unreviewed = stories.filter((s: any) => !s.specification.coordinatorReview).map((s: any) => s.id);
    expect(unreviewed, 'the coordinator reviewed these stories and the review was dropped').toEqual([]);
  });

  run('a resume after an engine release never re-runs a step the run already completed', async () => {
    const journal = join(JOURNALS, `${PROJECT}-resume-after-release-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const r = await startProjectRun({ src: SRC, project: PROJECT, dirs, children, journal });
    r.agent.on('*', correct(r.world, r.install));
    // 1. Launch on engine N, pausing before the writer: the roster and the prompts are settled.
    const first = await launch(r, { EPAM_PAUSE_BEFORE_WRITER: '1' });
    const t1 = `${first.stdout}\n${first.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'pause.log'), t1);
    expect(t1, 'the run did not pause before the writer').toMatch(/PAUSED — inputs ready, writer NOT started/);
    const runId = (t1.match(/RUN NUMBER:\s*\S*?(\d{8}T\d{6}Z)/) || [])[1];
    expect(runId, 'no run id at the pause').toBeTruthy();
    const settled = new Set(r.agent.calls.map((c) => c.seam));
    const callsAtPause = r.agent.calls.length;
    // 2. Engine N+1: a release changes a canonical persona — the first one, whichever it is.
    const canonFile = join(r.install, 'orchestrations/agents/profiles.canonical.json');
    const canon = JSON.parse(readFileSync(canonFile, 'utf8'));
    const changed = Object.keys(canon).find((k) => typeof canon[k] === 'string')!;
    canon[changed] += '\n\nA release added this sentence.';
    writeFileSync(canonFile, `${JSON.stringify(canon, null, 2)}\n`);
    // …and changes the template of a prompt the paused run already generated for this project.
    const promptsDir = join(r.install, 'orchestrations/projects', PROJECT, 'prompts');
    const generatedIds = existsSync(promptsDir) ? readdirSync(promptsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
    const tplDir = join(r.install, 'orchestrations/prompts/templates');
    const touched = generatedIds.find((id) => { try { return typeof JSON.parse(readFileSync(join(tplDir, `${id}.json`), 'utf8')).body === 'string'; } catch { return false; } });
    expect(touched, 'the paused run generated no project prompt from a template — the case proves nothing').toBeTruthy();
    const tpl = JSON.parse(readFileSync(join(tplDir, `${touched}.json`), 'utf8'));
    tpl.body += '\n\nA release added this sentence to the template.';
    writeFileSync(join(tplDir, `${touched}.json`), `${JSON.stringify(tpl, null, 2)}\n`);
    // 3. Resume the same run on the new engine.
    const second = await launch(r, { EPAM_RESUME_RUN: runId! });
    const t2 = `${second.stdout}\n${second.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'resume.log'), t2);
    for (const [from, to] of [[join(r.install, 'orchestrations/logs'), 'logs'], [r.out, 'codeline']] as const) {
      try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
    }
    const resumed = r.agent.calls.slice(callsAtPause);
    // THE STEPS THE PAUSED RUN COMPLETED run ONCE: the seams that settle the roster and the prompts
    // (what the registry says they produce) are not asked again.
    const settling = [...settled].filter((s) => /roster|prompt/.test(r.agent.decl.registry[s]?.produces || ''));
    expect(settling.length, 'no roster/prompt step ran before the pause — the case proves nothing').toBeGreaterThan(0);
    const repeated = [...new Set(resumed.filter((c) => settling.includes(c.seam)).map((c) => c.seam))];
    expect(repeated, `the resume re-ran completed steps after a release changed persona '${changed}' and template '${touched}'`).toEqual([]);
    expect(resumed.some((c) => r.agent.decl.registry[c.seam]?.produces === 'implementation'), 'the resumed run never reached the writer').toBe(true);
    expect(r.agent.stale).toEqual([]);
  });
  run('a resume whose prompt build was interrupted keeps the roster and completes the prompts', async () => {
    const journal = join(JOURNALS, `${PROJECT}-interrupted-build-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const r = await startProjectRun({ src: SRC, project: PROJECT, dirs, children, journal });
    r.agent.on('*', correct(r.world, r.install));
    const first = await launch(r, { EPAM_PAUSE_BEFORE_WRITER: '1' });
    const t1 = `${first.stdout}\n${first.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'pause.log'), t1);
    expect(t1, 'the run did not pause before the writer').toMatch(/PAUSED — inputs ready, writer NOT started/);
    const runId = (t1.match(/RUN NUMBER:\s*\S*?(\d{8}T\d{6}Z)/) || [])[1];
    expect(runId, 'no run id at the pause').toBeTruthy();
    const projDir = join(r.install, 'orchestrations/projects', PROJECT);
    // The project's generated artefacts, as the installer declares them: what a resume must keep.
    const generated = (JSON.parse(readFileSync(join(r.install, 'orchestrations-installer/generated-run-state-paths.json'), 'utf8')).paths as string[])
      .map((p) => p.match(/^orchestrations\/projects\/\*\/([^/*]+\.json)$/)?.[1]).filter((f): f is string => !!f && existsSync(join(projDir, f)));
    expect(generated.length, 'the pause left no generated project artefact — the case proves nothing').toBeGreaterThan(0);
    const kept = Object.fromEntries(generated.map((f) => [f, readFileSync(join(projDir, f), 'utf8')]));
    // THE INTERRUPTION: a rebuild killed part-way — the completion marker gone, most prompts gone.
    const cache = join(projDir, '.prompt-cache');
    for (const m of readdirSync(cache).filter((f) => f.startsWith('.complete-'))) rmSync(join(cache, m));
    const promptsDir = join(projDir, 'prompts');
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith('.json')).sort();
    expect(prompts.length, 'the pause built no prompts').toBeGreaterThan(3);
    for (const f of prompts.slice(Math.ceil(prompts.length / 3))) rmSync(join(promptsDir, f));
    const callsAtPause = r.agent.calls.length;
    // Resume the same run.
    const second = await launch(r, { EPAM_RESUME_RUN: runId! });
    const t2 = `${second.stdout}\n${second.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'resume.log'), t2);
    for (const [from, to] of [[join(r.install, 'orchestrations/logs'), 'logs'], [r.out, 'codeline']] as const) {
      try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
    }
    const resumed = r.agent.calls.slice(callsAtPause);
    const produced = (c: { seam: string }) => r.agent.decl.registry[c.seam]?.produces || '';
    for (const f of generated) {
      expect(existsSync(join(projDir, f)), `the resume DELETED ${f}`).toBe(true);
      expect(readFileSync(join(projDir, f), 'utf8'), `the resume rewrote ${f}`).toBe(kept[f]);
    }
    expect([...new Set(resumed.filter((c) => /roster/.test(produced(c))).map((c) => c.seam))], 'the resume re-derived the roster').toEqual([]);
    expect(readdirSync(promptsDir).filter((f) => f.endsWith('.json')).length, 'the interrupted prompt set was not completed').toBeGreaterThanOrEqual(prompts.length);
    expect(resumed.some((c) => produced(c) === 'implementation'), 'the resumed run never reached the writer').toBe(true);
    expect(r.agent.stale).toEqual([]);
  });
});
