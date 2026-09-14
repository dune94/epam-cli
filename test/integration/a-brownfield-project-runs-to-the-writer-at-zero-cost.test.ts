/**
 * A BROWNFIELD PROJECT RUNS TO THE WRITER AT £0 — THE WHOLE PATH, INCLUDING THE MINT.
 *
 * The greenfield test proved its path at £0 on 2026-09-13. The brownfield path shares most of it
 * — and the roster/mint rewrite of 2.0.29/2.0.30 (read-only specialiser, delta contract, engine
 * writes the roster) has had no brownfield run since it shipped. This is the brownfield
 * rehearsal inside the suite: the real paused mock launcher (mock1-paused-run.sh →
 * tier3-mock-run.sh) on the project it was built for, which builds a real client codeline from
 * the project's seed, serves one ticket from the stub tracker, and runs the real pipeline — reset,
 * ingest, AC gate, discovery, mint, prompts, spec pass, CPA — pausing before the writer; then
 * `--resume`, which continues into the writer.
 *
 * Only the network edge is in-process: the model answered by what the launcher itself registers
 * (from the tracker's issues, since the PRD does not exist before ingest), the observability
 * services answering as a healthy stack, a no-op container runtime.
 *
 * WHAT £0 PROVES. Every stage up to and including the mint and the specification pass — the
 * handoffs the engine owns — passes on stand-ins. Then a brownfield DEFECT meets the gates that
 * need an investigation nobody can stand in for: the detective must locate a fix site in the
 * codeline and the CPA reviewer must estimate it, and CPA blocks a defect with no fix site by
 * design. So:
 *   - ALWAYS: ingest, AC gate, discovery, the mint (specialiser invoked read-only, roster composed
 *     and reviewed, prompts provisioned) and the spec pass all pass; the mint's artefacts are on
 *     disk; and the run stops, if it stops, at CPA for the stated reason and nowhere else.
 *   - WHEN this project's own recordings of the investigating seams exist: the run pauses before
 *     the writer with a checkpoint, and `--resume` invokes the writer.
 *   - WHEN a recording of this project's writer exists too: the resume completes and changes the
 *     greeting.
 * The project is the one the launcher builds from its seed, never named here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMockServer } from './lib/mini-mockserver';
import { ROOT, fixtureInstall, edgeFor, zeroCostEnv, run } from './lib/fixture-install';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const mock = new MiniMockServer();
let install = '';
let bin = '';
let workspaceRoot = '';
beforeAll(async () => {
  await mock.start();
  install = fixtureInstall(dirs);
  bin = edgeFor(install, mock.url, children).bin;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mock1-ws-')); dirs.push(workspaceRoot);
}, 120_000);
afterAll(() => mock.stop());

const LAUNCHER = 'orchestrations/scripts/mock1-paused-run.sh';

/** A seam named by what the registry says it PRODUCES — never by its name. */
const seamProducing = (what: string): string => {
  const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
  const hit = Object.entries(reg).find(([, p]) => p && p.produces === what);
  if (!hit) throw new Error(`no seam produces '${what}'`);
  return hit[0];
};
const WRITER = seamProducing('implementation');
const SPECIALISER = seamProducing('project-roster');
const isSeam = (hit: { seam: string }, seam: string) => hit.seam === seam || hit.seam.startsWith(`${seam}:`);

/** The project the paused launcher runs when none is named: the one carrying the seed it builds from. */
function launcherProject(): string {
  const projects = join(install, 'orchestrations/projects');
  const seeded = readdirSync(projects).filter((d) => existsSync(join(projects, d, 'seed')));
  if (seeded.length !== 1) throw new Error(`${seeded.length} projects carry a seed/ — the launcher needs exactly one`);
  return join(projects, seeded[0]);
}

function env(extra: Record<string, string> = {}) {
  return zeroCostEnv(bin, mock.url, { MOCK1_WORKSPACE_ROOT: workspaceRoot, ...extra });
}

function keep(name: string, text: string, projDir: string) {
  if (!process.env.EPAM_GREENFIELD_TEST_KEEP) return;
  const k = join(process.env.EPAM_GREENFIELD_TEST_KEEP, name); rmSync(k, { recursive: true, force: true }); mkdirSync(k, { recursive: true });
  try { cpSync(join(install, 'orchestrations/logs'), join(k, 'logs'), { recursive: true }); } catch { /* none */ }
  try { cpSync(projDir, join(k, 'project'), { recursive: true }); } catch { /* none */ }
  try { cpSync(workspaceRoot, join(k, 'workspace'), { recursive: true }); } catch { /* none */ }
  writeFileSync(join(k, 'run.log'), text);
}

describe('a brownfield project runs to the writer at £0', () => {
  it('the paused launcher exists and declares its project', () => {
    expect(existsSync(join(install, LAUNCHER))).toBe(true);
    expect(existsSync(launcherProject()), `no project at ${launcherProject()}`).toBe(true);
    expect(spawnSync('claude', ['--version'], { encoding: 'utf8' }).status, 'the `claude` CLI is not on PATH').toBe(0);
  });

  it('pauses before the writer with every earlier stage passed, the mint\'s artefacts on disk, and a checkpoint to resume from', async () => {
    const projDir = launcherProject();
    const r = await run('bash', [join(install, LAUNCHER)], { cwd: install, env: env(), timeout: 40 * 60_000 });
    const text = r.stdout + r.stderr;
    keep('brownfield-pause', text, projDir);
    const tail = text.split('\n').slice(-60).join('\n') + '\n--- model calls served ---\n' + mock.hits.map((h, i) => `${i + 1}. ${h.seam}`).join('\n');

    expect(text, `the launcher did not register the mock's answers — log tail:\n${tail}`).toMatch(/registering the mock's answers/);
    expect(text, `registration did not account for every seam — log tail:\n${tail}`).toMatch(/every declared seam reached a printed bucket/);

    // Does THIS project have recordings of the seams that investigate the codeline? A stand-in
    // cannot locate a fix site or estimate one, and CPA blocks an unlocated defect by design.
    const recorded = (seam: string) => new RegExp(`^\\s+${seam}\\s+<-\\s+cassette:`, 'm').test(text)
      && !new RegExp(`^\\s+${seam}\\s+<-.*another project's answer`, 'm').test(text);
    const investigated = recorded(seamProducing('fix-plan')) && recorded(seamProducing('estimate'));

    const failedSteps = [...text.matchAll(/✗[^\n]{0,12}?Step (\d+):\s*([^\n]*)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
    const specStep = (text.match(/▶[^\n]{0,12}?Step (\d+):\s*Specification pass/) || [])[1];
    const cpaStep = (text.match(/▶[^\n]{0,12}?Step (\d+):\s*CPA pre-pass/) || [])[1];
    expect(specStep, `the run never reached the specification pass — log tail:\n${tail}`).toBeTruthy();
    expect(text, `the specification pass did not complete — log tail:\n${tail}`).toMatch(/Specification pass completed/);
    if (investigated) {
      expect(failedSteps, `a stage failed before the pause — log tail:\n${tail}`).toEqual([]);
      expect(text, `the run did not pause before the writer — log tail:\n${tail}`).toMatch(/STOPPED before the writer/);
      expect(r.status, `launcher exited ${r.status} — log tail:\n${tail}`).toBe(0);
    } else {
      // The only stage allowed to stop this run is CPA, and only for the reason it states.
      const other = failedSteps.filter((f) => f.split(':')[0] !== cpaStep);
      expect(other, `a stage other than CPA failed — log tail:\n${tail}`).toEqual([]);
      if (failedSteps.length) expect(text).toMatch(/BLOCK gate|CPA gate BLOCKED/);
      console.log(`[brownfield £0] no recording of this project's investigating seams — proven through the mint and the spec pass; CPA ${failedSteps.length ? 'blocked the unlocated defect, as designed' : 'passed'}`);
    }

    // The mint ran, on a brownfield codeline, and left what the writer stage reads.
    expect(mock.hits.some((h) => isSeam(h, SPECIALISER)), 'the roster specialiser was never invoked — the mint did not run').toBe(true);
    for (const f of ['roster.json', 'agent-profiles.json', 'project-roles.json']) {
      expect(existsSync(join(projDir, f)), `${f} was not written by the mint`).toBe(true);
    }
    const roster = JSON.parse(readFileSync(join(projDir, 'roster.json'), 'utf8'));
    expect(Object.keys(roster.agents || {}).length, 'the roster holds no agents').toBeGreaterThan(0);
    expect(readdirSync(join(projDir, 'prompts')).filter((f) => f.endsWith('.json')).length, 'no prompts were provisioned').toBeGreaterThan(0);

    // THE RESUME IS NOT OPTIONAL. It used to run only when a RECORDING of this project's
    // investigating seams existed — recordings that never worked — so the writer, the gates, the
    // reproduction test and the phase gate were never executed inside the suite, and two changes
    // to the stand-ins were launched untested and regressed a harness run from 35/40 to 27/40
    // (run 15, 2026-09-14). Stand-ins answer every seam; the whole path executes here, every time.

    // A checkpoint the resume can continue from.
    const runId = (text.match(/RUN NUMBER:\s+(\S+)/) || [])[1];
    expect(runId, 'no run number reported').toBeTruthy();
    // Asked of the checkpoint library the launcher itself resumes from (lanes/<codeline>/ since
    // lanes came in), never of a path this test spells.
    const stage = spawnSync('bash', ['-c', `. ${JSON.stringify(join(install, 'orchestrations/scripts/lib/run-checkpoint.sh'))}; run_stage ${JSON.stringify(runId)}`],
      { encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: projDir } }).stdout.trim();
    expect(stage, 'no checkpoint written at the pause (run_stage returned nothing)').toBeTruthy();

    // RESUME: the same launcher continues at implementation and runs to the end of the phase.
    const hitsBefore = mock.hits.length;
    const r2 = await run('bash', [join(install, LAUNCHER), '--resume', runId], { cwd: install, env: env(), timeout: 40 * 60_000 });
    const text2 = r2.stdout + r2.stderr;
    keep('brownfield-resume', text2, projDir);
    // The launcher re-registers the mock on resume, which RESETS its hit list; the resume's calls
    // are whatever the list holds if it shrank, else everything after the pause.
    const resumeHits = mock.hits.length < hitsBefore ? mock.hits : mock.hits.slice(hitsBefore);
    const tail2 = text2.split('\n').slice(-60).join('\n') + '\n--- model calls served ---\n' + resumeHits.map((h, i) => `${i + 1}. ${h.seam}`).join('\n');
    expect(text2, `the resume did not reach implementation — log tail:\n${tail2}`).toMatch(/resume finished/);
    expect(resumeHits.some((h) => isSeam(h, WRITER)), `the writer was never invoked on resume — log tail:\n${tail2}`).toBe(true);
    expect(r2.status, `resume exited ${r2.status} — log tail:\n${tail2}`).toBe(0);
    // WHAT THE RUN LEFT: the story completed in the PRD, the phase gate's own record says GO, the
    // fix is in the codeline and its own tests pass, and a reproducing test accompanies the change.
    const ws = join(workspaceRoot, runId, 'workspace');
    const prd = JSON.parse(readFileSync(join(ws, 'synthesized-prd.json'), 'utf8'));
    const incomplete = (prd.stories || []).filter((st: any) => !st.completed).map((st: any) => st.id);
    expect(incomplete, `stories not completed: ${incomplete} — log tail:\n${tail2}`).toEqual([]);
    const gates = readFileSync(join(install, 'orchestrations/logs/phase-gates.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(gates.some((g: any) => String(g.decision).toLowerCase() === 'go'), `no phase gate decided GO — log tail:\n${tail2}`).toBe(true);
    const clone = readdirSync(join(ws, 'codelines')).map((d) => join(ws, 'codelines', d))[0];
    const { resolveEcosystem } = require(join(install, 'orchestrations/scripts/lib/handlers/codeline-manifests.js'));
    const hit = resolveEcosystem(clone);
    const testCmd = typeof hit.eco.testCommand === 'function' ? hit.eco.testCommand(readFileSync(join(clone, hit.present), 'utf8')) : hit.eco.testCommand;
    expect(testCmd, 'the codeline declares no test command').toBeTruthy();
    const t = spawnSync('bash', ['-c', testCmd], { cwd: clone, encoding: 'utf8', timeout: 300_000 });
    expect(t.status, `the codeline's own tests fail after the run:\n${(t.stdout || '') + (t.stderr || '')}`).toBe(0);
    const committed = spawnSync('git', ['-C', clone, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(committed.length, 'the codeline holds no committed work beyond the seed').toBeGreaterThan(1);
    const changed = spawnSync('git', ['-C', clone, 'diff', '--name-only', `HEAD~${committed.length - 1}`, 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const { classify } = (() => { try { return require(join(install, 'orchestrations/scripts/lib/handlers/classify-changed-files.js')); } catch { return { classify: null }; } })();
    expect(changed.some((f) => /(\.|_)(spec|test)\.[A-Za-z0-9]+$|\/__tests__\/|(^|\/)test_[^/]+$/.test(f)), `no test accompanies the committed change (${changed.join(', ')})`).toBe(true);
    void classify;
  }, 85 * 60_000);
});
