/**
 * A GREENFIELD PROJECT RUNS TO COMPLETION AT £0 — THE WHOLE PATH, NOTHING LIFTED OUT.
 *
 * Every stop the greenfield rehearsal hit between 2026-09-11 and 2026-09-13 was a HANDOFF:
 * installer → pre-flight (keys, mount, subnet), launcher → lifecycle (PRD restored after the
 * gate that reads it), mint → engine (who writes the roster), exporter → loader (a rehearsal's
 * own stand-ins served back as recordings). Each had a unit test that lifted one block out and
 * stubbed its neighbours — which is exactly how the handoff itself stayed unproven — and each
 * was then "verified" by launching another rehearsal. Five of them. Runs are not tests.
 *
 * This test IS the rehearsal, inside the suite: the real generic launcher on every project that
 * declares itself greenfield, the real orchestrator, the real mint and engine, the real runner
 * scripts and the real `claude` CLI — with only the NETWORK EDGE in-process: the model answered
 * by what mock-expectations.js registers (as the MockServer container would serve it), and the
 * observability services answering as a healthy stack does. The container runtime is a no-op at
 * the same edge: restarting a dashboard is not the pipeline.
 *
 * The universe is derived — every project under orchestrations/projects whose config.env
 * declares EPAM_BROWNFIELD=0 — so a new greenfield project is covered by existing.
 *
 * WHAT £0 CAN PROVE. Every stage up to the writer is a HANDOFF the engine owns — launcher,
 * lifecycle, reset, pre-flight, mint, prompts, spec pass, CPA, dependency check — and a stand-in
 * or another project's recording exercises each of them. The writer is different: only a model
 * (or a recording of one, for THIS project) produces the code the gates then judge, and at £0
 * with no such recording the writer produces nothing and the gates refuse it — correctly. So:
 *   - ALWAYS: every stage before the writer passes, the writer is reached and invoked, the mint's
 *     artefacts are on disk, and the restored PRD names this run's output directory.
 *   - WHEN this project's own writer recording exists (the operator's one paid run, exported as a
 *     cassette): every declared phase completes and the codeline holds committed work.
 * Red names the stage. Nothing is skipped when the environment is short: a missing `claude` CLI
 * is a failure of this test's environment, reported as such.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMockServer } from './lib/mini-mockserver';
import { ROOT, NODE, fixtureInstall, edgeFor, zeroCostEnv, run } from './lib/fixture-install';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** The projects that declare themselves greenfield — the launcher's own test, never a list here. */
function greenfieldProjects(): string[] {
  const root = join(ROOT, 'orchestrations/projects');
  return readdirSync(root).filter((p) => {
    const f = join(root, p, 'config.env');
    return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8'));
  });
}

/**
 * ANOTHER INSTALL'S GREENFIELD PROJECTS, RUN HERE AT £0 BEFORE THEY ARE LAUNCHED ANYWHERE.
 *
 * A project authored in another install — its config.env and the canonical PRD it names — is
 * copied into the fixture install (its generated artefacts left behind: roster, profiles, prompts,
 * runs, kb) and takes its place in the universe. Set EPAM_GREENFIELD_TEST_INSTALL to that install's
 * root. This is how a project is proven at £0 with ITS data before a single paid launch: the four
 * paid runs of 2026-09-13 each found a defect this test would have found first had it run their
 * project rather than only this repository's.
 */
function adoptExternalProjects(install: string) {
  const src = process.env.EPAM_GREENFIELD_TEST_INSTALL;
  if (!src) return [] as string[];
  const generated = JSON.parse(readFileSync(join(ROOT, 'orchestrations-installer/generated-run-state-paths.json'), 'utf8')).paths as string[];
  const runState = JSON.parse(readFileSync(join(ROOT, 'orchestrations-installer/run-state-paths.json'), 'utf8')).paths as string[];
  // What a project directory carries that a run generated — EXACTLY what the installer declares it
  // must never overwrite, read as globs relative to the project directory. No name is listed here.
  const leaveBehind = [...generated, ...runState]
    .map((p) => p.match(/^orchestrations\/projects\/\*\/(.+)$/)).filter(Boolean)
    .map((m) => new RegExp('^' + m![1].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '(/|$)'));
  const adopted: string[] = [];
  const projectsSrc = join(src, 'orchestrations/projects');
  for (const p of readdirSync(projectsSrc)) {
    const cfgPath = join(projectsSrc, p, 'config.env');
    if (!existsSync(cfgPath)) continue;
    const cfg = readFileSync(cfgPath, 'utf8');
    if (!/^EPAM_BROWNFIELD=0\s*$/m.test(cfg)) continue;
    const dest = join(install, 'orchestrations/projects', p);
    // THEIR projects, not this repository's: a project the repository already carries is run as
    // the repository declares it (the other install may hold an older copy of it).
    if (existsSync(dest)) continue;
    cpSync(join(projectsSrc, p), dest, { recursive: true, filter: (f) => {
      const rel = f.slice(join(projectsSrc, p).length + 1);
      // A directory is copied when anything under it may be kept; a generated file is not.
      return !rel || !leaveBehind.some((r) => r.test(rel) || r.test(rel + '/'));
    } });
    const canonical = (cfg.match(/^PRD_CANONICAL=(.*)$/m) || [, ''])[1].trim();
    if (canonical) {
      const from = canonical.startsWith('/') ? canonical : join(src, canonical);
      const to = canonical.startsWith('/') ? canonical : join(install, canonical);
      if (!canonical.startsWith('/')) { mkdirSync(join(to, '..'), { recursive: true }); cpSync(from, to); }
    }
    adopted.push(p);
  }
  return adopted;
}

const mock = new MiniMockServer();
let install = '';
let bin = '';
let adopted: string[] = [];
beforeAll(async () => {
  await mock.start();
  install = fixtureInstall(dirs);
  bin = edgeFor(install, mock.url, children).bin;
  adopted = adoptExternalProjects(install);
  if (adopted.length) console.log(`[greenfield £0] adopted from ${process.env.EPAM_GREENFIELD_TEST_INSTALL}: ${adopted.join(', ')}`);
}, 120_000);
afterAll(() => mock.stop());

function runEnv(_project: string, outputDir: string): Record<string, string> {
  return zeroCostEnv(bin, mock.url, {
    EPAM_PAUSE_BEFORE_WRITER: '0',
    OUTPUT_DIR: outputDir,
    EPAM_PROJECT_CONFIG_DIR: '', // the launcher resolves it from --project
  });
}

/** A seam named by what the registry says it PRODUCES — never by its name. */
const seamProducing = (what: string): string => {
  const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
  const hit = Object.entries(reg).find(([, p]) => p && p.produces === what);
  if (!hit) throw new Error(`no seam produces '${what}'`);
  return hit[0];
};
const WRITER = seamProducing('implementation');
const isSeam = (hit: { seam: string }, seam: string) => hit.seam === seam || hit.seam.startsWith(`${seam}:`);

const projects = [...new Set([...greenfieldProjects(), ...(process.env.EPAM_GREENFIELD_TEST_INSTALL
  ? readdirSync(join(process.env.EPAM_GREENFIELD_TEST_INSTALL, 'orchestrations/projects')).filter((p) => {
    if (existsSync(join(ROOT, 'orchestrations/projects', p))) return false;   // the repository's own copy is the one run
    const f = join(process.env.EPAM_GREENFIELD_TEST_INSTALL!, 'orchestrations/projects', p, 'config.env');
    return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8'));
  }) : [])])];

describe('a greenfield project runs to completion at £0', () => {
  it('the launcher has at least one greenfield project to run, and the runner CLI exists', () => {
    expect(projects.length, 'no project declares EPAM_BROWNFIELD=0').toBeGreaterThan(0);
    expect(spawnSync('claude', ['--version'], { encoding: 'utf8' }).status, 'the `claude` CLI is not on PATH').toBe(0);
  });

  for (const project of projects) {
    it(`${project}: every declared phase completes, the codeline holds committed work, the mint left its artefacts`, async () => {
      const projDir = join(install, 'orchestrations/projects', project);
      const cfg = readFileSync(join(projDir, 'config.env'), 'utf8');
      const phases = (cfg.match(/^EPAM_PHASES="?([^"\n]*)"?/m) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
      expect(phases.length, `${project} declares no EPAM_PHASES`).toBeGreaterThan(0);
      const canonical = (cfg.match(/^PRD_CANONICAL=(.*)$/m) || [, ''])[1].trim();
      const out = join(tmp('gf-out-'), 'app');
      const env = runEnv(project, out);

      // The model's answers, registered by the same script a rehearsal uses, against this edge.
      const reg = await run(NODE, [join(install, 'orchestrations/scripts/mock-expectations.js'), '--host', mock.url], {
        cwd: install, timeout: 300_000,
        env: { ...env, PRD_FILE: join(install, canonical), EPAM_PROJECT_CONFIG_DIR: projDir },
      });
      expect(reg.status, `mock-expectations.js failed:\n${reg.stdout}\n${reg.stderr}`).toBe(0);
      expect(reg.stdout).toMatch(/every declared seam reached a printed bucket/);

      const log = join(install, 'greenfield-run.log');
      writeFileSync(join(install, 'mock-expectations.log'), reg.stdout + reg.stderr);
      console.log(reg.stdout.split('\n').filter((l) => /roster/.test(l)).join('\n'));
      const r = await run('bash', [join(install, 'orchestrations/scripts/tier3-run.sh'), '--project', project, '--yes'], {
        cwd: install, timeout: 45 * 60_000, env,
      });
      const text = (r.stdout || '') + (r.stderr || '');
      writeFileSync(log, text);
      const tail = text.split('\n').slice(-60).join('\n')
        + '\n--- model calls served, in order ---\n'
        + mock.hits.map((h, i) => `${i + 1}. ${h.seam} (${h.path})`).join('\n');

      // WHAT THE RUN LEFT BEHIND, kept where it can be read after the fixture is gone: a failure
      // one stage deep is diagnosed from the codeline and the logs, not from the assertion text.
      if (r.status !== 0 && process.env.EPAM_GREENFIELD_TEST_KEEP) {
        const keep = join(process.env.EPAM_GREENFIELD_TEST_KEEP, project); rmSync(keep, { recursive: true, force: true }); mkdirSync(keep, { recursive: true });
        try { cpSync(out, join(keep, 'app'), { recursive: true }); } catch { /* no output dir */ }
        try { cpSync(join(install, 'orchestrations/logs'), join(keep, 'logs'), { recursive: true }); } catch { /* no logs */ }
        try { cpSync(projDir, join(keep, 'project'), { recursive: true }); } catch { /* no project dir */ }
        writeFileSync(join(keep, 'run.log'), text);
      }
      // Does THIS project have a recording of its own writer? The registration says so per seam:
      // a capture from another project is labelled as such and cannot write this project's code.
      const writerRecorded = reg.stdout.split('\n').some((l) => new RegExp(`^\\s+${WRITER}\\s+<-\\s+cassette:`).test(l))
        && !reg.stdout.split('\n').some((l) => new RegExp(`^\\s+${WRITER}\\s+<-.*another project's answer`).test(l));

      // Every stage BEFORE the writer passed: the first failed step, if any, is the writer's own.
      const failedSteps = [...text.matchAll(/✗[^\n]{0,12}?Step (\d+):\s*([^\n]*)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
      const writerStep = (text.match(/▶[^\n]{0,12}?Step (\d+):\s*Main-branch stories/) || [])[1];
      expect(writerStep, `the run never reached the writer — log tail:\n${tail}`).toBeTruthy();
      const before = failedSteps.filter((f) => Number(f.split(':')[0]) < Number(writerStep));
      expect(before, `a stage before the writer failed — log tail:\n${tail}`).toEqual([]);
      expect(mock.hits.some((h) => isSeam(h, WRITER)), 'the writer was never invoked').toBe(true);
      // Calls that matched no seam are REPORTED, not refused: the `claude` CLI makes auxiliary calls
      // of its own (measured live: 4 POSTs where 2 were expected), and the catch-all exists to
      // absorb exactly those. A seam that fell through shows up as a failed stage above instead.
      const unmatched = mock.hits.filter((h) => /CATCH-ALL/.test(h.seam));
      if (unmatched.length) console.log(`[greenfield £0] ${project}: ${unmatched.length} call(s) matched no seam (the runner's own auxiliary calls, absorbed by the catch-all)`);

      if (writerRecorded) {
        for (const p of phases) expect(text, `phase '${p}' did not complete — log tail:\n${tail}`).toMatch(new RegExp(`Phase '${p}' completed`));
        expect(r.status, `launcher exited ${r.status} — log tail:\n${tail}`).toBe(0);
        // The codeline holds the work: a repo with commits beyond the empty one the lifecycle makes.
        const commits = spawnSync('git', ['-C', out, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        expect(Number(commits), 'the output directory holds no committed work').toBeGreaterThan(1);
      } else {
        console.log(`[greenfield £0] ${project}: no recording of this project's writer — proven up to and including the writer's invocation; the phases need one paid run recorded as a cassette to be proven end to end`);
      }

      // The mint left what the next stage reads, in the project's own directory.
      for (const f of ['roster.json', 'agent-profiles.json', 'project-roles.json']) {
        expect(existsSync(join(projDir, f)), `${f} was not written by the mint`).toBe(true);
      }
      expect(readdirSync(join(projDir, 'prompts')).filter((f) => f.endsWith('.json')).length, 'no prompts were generated').toBeGreaterThan(0);

      // The restored PRD names this run's output directory.
      const prdPath = (cfg.match(/^PRD_FILE=(.*)$/m) || [, ''])[1].trim();
      const prd = JSON.parse(readFileSync(join(install, prdPath), 'utf8'));
      expect(prd.project && prd.project.outputDir).toBe(out);

      expect(mock.hits.length, 'no model call reached the mock — nothing was rehearsed').toBeGreaterThan(0);
    }, 50 * 60_000);

    // A RESUME IS NOT A LAUNCH. Every greenfield "resume" of run 20260915T101555Z (2.0.38–2.0.41)
    // began by tearing the codeline down, restoring the authored PRD and resetting every completed
    // flag — a fresh launch wearing the old run id — because this cell launched and finished and
    // never once resumed. This leg pauses before the writer, resumes the SAME run through the same
    // launcher, and asserts what a resume must keep: the codeline, the PRD's own state, the run id.
    it(`${project}: a run paused before the writer resumes as the same run — codeline, PRD and run id kept`, async () => {
      const projDir = join(install, 'orchestrations/projects', project);
      const cfg = readFileSync(join(projDir, 'config.env'), 'utf8');
      const phases = (cfg.match(/^EPAM_PHASES="?([^"\n]*)"?/m) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
      const canonical = (cfg.match(/^PRD_CANONICAL=(.*)$/m) || [, ''])[1].trim();
      const prdPath = join(install, (cfg.match(/^PRD_FILE=(.*)$/m) || [, ''])[1].trim());
      const out = join(tmp('gf-resume-out-'), 'app');
      const env = runEnv(project, out);
      const reg = await run(NODE, [join(install, 'orchestrations/scripts/mock-expectations.js'), '--host', mock.url], {
        cwd: install, timeout: 300_000, env: { ...env, PRD_FILE: join(install, canonical), EPAM_PROJECT_CONFIG_DIR: projDir },
      });
      expect(reg.status, `mock-expectations.js failed:\n${reg.stdout}\n${reg.stderr}`).toBe(0);
      const launcher = join(install, 'orchestrations/scripts/tier3-run.sh');

      // 1. Launch, pausing before the writer.
      const first = await run('bash', [launcher, '--project', project, '--yes'], { cwd: install, timeout: 30 * 60_000, env: { ...env, EPAM_PAUSE_BEFORE_WRITER: '1' } });
      const t1 = (first.stdout || '') + (first.stderr || '');
      writeFileSync(join(install, 'greenfield-pause.log'), t1);
      const tail1 = t1.split('\n').slice(-40).join('\n');
      expect(t1, `the run did not pause before the writer — log tail:\n${tail1}`).toMatch(/PAUSED — inputs ready, writer NOT started/);
      const runId = (t1.match(/RUN NUMBER:\s*\S*?(\d{8}T\d{6}Z)/) || [])[1];
      expect(runId, `no run id printed at the pause — log tail:\n${tail1}`).toBeTruthy();
      const prdAtPause = JSON.parse(readFileSync(prdPath, 'utf8'));
      const specAtPause = Object.fromEntries((prdAtPause.stories || []).map((st: any) => [st.id, st.specification && st.specification.runId]));
      expect(Object.values(specAtPause).some(Boolean), 'the spec pass wrote nothing before the pause').toBe(true);
      const headAtPause = spawnSync('git', ['-C', out, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const hitsAtPause = mock.hits.length;

      // 2. Resume the same run through the same launcher.
      const second = await run('bash', [launcher, '--project', project, '--yes'], { cwd: install, timeout: 45 * 60_000, env: { ...env, EPAM_RESUME_RUN: runId } });
      const t2 = (second.stdout || '') + (second.stderr || '');
      writeFileSync(join(install, 'greenfield-resume.log'), t2);
      const tail2 = t2.split('\n').slice(-60).join('\n');
      expect(t2, `the resume tore the codeline down — log head:\n${t2.split('\n').slice(0, 12).join('\n')}`).not.toMatch(/Tearing down output directory/);
      expect(t2, 'the resume restored the authored PRD over the run\'s own').not.toMatch(/PRD restored from canonical/);
      expect(t2, `the resume ran under another run id — log tail:\n${tail2}`).toMatch(new RegExp(`RUN NUMBER:\\s*\\S*?${runId}`));
      // The codeline the paused run left is the base the resumed run builds on.
      const firstParent = spawnSync('git', ['-C', out, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      expect(spawnSync('git', ['-C', out, 'merge-base', '--is-ancestor', headAtPause, 'HEAD']).status, 'the paused run\'s commit is no longer in the codeline\'s history').toBe(0);
      expect(firstParent, 'the codeline was re-initialised').toBe(spawnSync('git', ['-C', out, 'rev-list', '--max-parents=0', headAtPause], { encoding: 'utf8' }).stdout.trim());
      // The spec pass is not re-run: every story keeps the spec run id it had at the pause.
      const prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
      for (const st of prdAfter.stories || []) {
        if (specAtPause[st.id]) expect(st.specification && st.specification.runId, `${st.id}: the spec pass re-ran on resume`).toBe(specAtPause[st.id]);
      }
      expect(mock.hits.slice(hitsAtPause).some((h) => isSeam(h, WRITER)), 'the resumed run never reached the writer').toBe(true);
      for (const p of phases) expect(t2, `phase '${p}' did not complete on the resume — log tail:\n${tail2}`).toMatch(new RegExp(`Phase '${p}' completed`));
      expect(second.status, `resume exited ${second.status} — log tail:\n${tail2}`).toBe(0);
      expect(Number(spawnSync('git', ['-C', out, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim()), 'the resumed run committed nothing').toBeGreaterThan(1);
    }, 80 * 60_000);
  }
});
