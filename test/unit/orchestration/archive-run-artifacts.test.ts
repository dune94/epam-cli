/**
 * A successful run must leave its evidence behind.
 *
 * Everything that explains WHY a run did what it did is destroyed shortly after
 * it finishes:
 *
 *   the working PRD   — lives in /tmp as orch-<codeline>-prd-<pid>.json and is
 *                       cleaned up. It holds the verification criteria, the test
 *                       criteria, fixSiteAnalysis and the declared file list.
 *                       Asked for those on 2026-07-26, hours after a successful
 *                       run, they were simply gone: the report could say "4
 *                       verification criteria were written" and not what they
 *                       said.
 *   profiles.json     — restored from canonical at the START of every run, so
 *                       the agent instructions a run actually used are
 *                       overwritten by the next launch.
 *   KB self-heals     — the scratchpad is cleared by pre-run-reset.sh, and the
 *                       constraints/healing-events store keeps mutating.
 *
 * So the artefacts that would let anyone audit or reproduce a run survive only
 * until the next one starts. This archives them, once, at the point of success.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/archive-run-artifacts.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Fx = { root: string; logDir: string; automationDir: string; outDir: string; prd: string };

function makeFixture(opts: { prd?: boolean; profiles?: boolean; kb?: boolean } = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), 'archive-artifacts-'));
  cleanupDirs.push(root);
  const automationDir = join(root, 'orchestrations');
  const logDir = join(automationDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const write = (p: string, body: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };

  const prd = join(root, 'orch-cdts-prd-12345.json');
  if (opts.prd !== false) {
    write(prd, JSON.stringify({
      stories: [{
        id: 'AMSD-1820',
        verificationCriteria: ['The email shows a promo discount for return trips'],
        testCriteria: ['discount is applied to both legs'],
        fixSiteAnalysis: [{ file: 'src/a.ts', brokenLine: 'a === b', evidenceVerified: true }],
      }],
    }));
  }
  if (opts.profiles !== false) {
    write(join(automationDir, 'agents/profiles.json'),
      JSON.stringify({ 'typescript-engineer': 'be minimal' }));
  }
  if (opts.kb !== false) {
    write(join(logDir, 'kb-scratchpad/AMSD-1820-attempt-1.md'), '# what went wrong\n');
    write(join(automationDir, 'agents/kb/constraints.json'), '{"rules":[{"id":"ts2532"}]}');
    write(join(automationDir, 'agents/kb/healing-events.jsonl'), '{"event":"heal"}\n');
  }
  return { root, logDir, automationDir, outDir: join(root, 'runs/20260726T090951'), prd };
}

function run(fx: Fx, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      AUTOMATION_DIR: fx.automationDir,
      LOG_DIR: fx.logDir,
      RUN_ARTIFACT_DIR: fx.outDir,
      WORKING_PRD: fx.prd,
      ...extraEnv,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const at = (fx: Fx, rel: string) => join(fx.outDir, rel);

describe('a successful run archives what explains it', () => {
  it('keeps the working PRD, with the criteria that would otherwise be lost', () => {
    const fx = makeFixture();
    expect(run(fx).code).toBe(0);

    expect(existsSync(at(fx, 'working-prd.json')),
      'the working PRD was not kept — verification criteria, test criteria and the ' +
      'fix-site analysis all die with /tmp').toBe(true);
    const prd = JSON.parse(readFileSync(at(fx, 'working-prd.json'), 'utf8'));
    const story = prd.stories[0];
    expect(story.verificationCriteria).toHaveLength(1);
    expect(story.testCriteria).toHaveLength(1);
    expect(story.fixSiteAnalysis[0].brokenLine).toBe('a === b');
  });

  it('keeps profiles.json as the run actually used it', () => {
    // Restored from canonical at the start of every run, so without this the
    // instructions a run worked from are overwritten by the next launch.
    const fx = makeFixture();
    run(fx);
    expect(existsSync(at(fx, 'profiles.json'))).toBe(true);
    expect(JSON.parse(readFileSync(at(fx, 'profiles.json'), 'utf8')))
      .toHaveProperty('typescript-engineer');
  });

  it('keeps every self-heal artefact', () => {
    // The scratchpad is cleared by pre-run-reset.sh and the constraint store
    // keeps mutating, so these exist only until the next run starts.
    const fx = makeFixture();
    run(fx);
    expect(existsSync(at(fx, 'kb/kb-scratchpad/AMSD-1820-attempt-1.md')),
      'the self-heal scratchpad was not kept').toBe(true);
    expect(existsSync(at(fx, 'kb/constraints.json')),
      'the compiled constraints were not kept').toBe(true);
    // healing-events.jsonl is the ENGINE-WIDE store, accumulating across every project and
    // run. It is now filtered to THIS run (entries at/after the instant ORCH_RUN_ID
    // encodes), because copying it whole put another project's previous-day history into a
    // clean run's evidence. Captured when this run has events; honestly reported as
    // missing when it has none — never another project's.
    const manifest = JSON.parse(readFileSync(at(fx, 'artifacts.json'), 'utf8'));
    const kbListed = [...manifest.captured, ...manifest.missing].includes('kb/healing-events.jsonl');
    expect(kbListed, 'healing-events must appear in the manifest either way').toBe(true);
  });

  it('writes a manifest saying what was captured and from where', () => {
    // Otherwise a missing file is ambiguous: absent because it did not exist, or
    // absent because archiving silently failed?
    const fx = makeFixture();
    run(fx);
    const manifest = readFileSync(at(fx, 'artifacts.json'), 'utf8');
    expect(manifest).toMatch(/working-prd\.json/);
    expect(manifest).toMatch(/profiles\.json/);
  });

  it('records what was MISSING rather than failing silently', () => {
    const fx = makeFixture({ kb: false });
    expect(run(fx).code, 'a missing optional artefact failed the whole archive').toBe(0);
    const manifest = JSON.parse(readFileSync(at(fx, 'artifacts.json'), 'utf8'));
    expect(JSON.stringify(manifest),
      'the absent KB artefacts are not recorded, so the gap is invisible')
      .toMatch(/missing|absent/i);
  });

  it('never fails the run it is archiving', () => {
    // This is a post-success convenience. It must not turn a green run red.
    const fx = makeFixture({ prd: false, profiles: false, kb: false });
    expect(run(fx).code).toBe(0);
  });

  it('is safe to run twice', () => {
    const fx = makeFixture();
    run(fx);
    expect(run(fx).code).toBe(0);
    expect(existsSync(at(fx, 'working-prd.json'))).toBe(true);
  });
});

describe('the pipeline archives on every outcome, not just success', () => {
  const runner = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');

  it('archives when the run FAILS — the case evidence is most needed', () => {
    // Every failure investigated on 2026-07-26 had to be reconstructed from a
    // log after the fact, because the working PRD, profiles.json and the KB
    // scratchpad were already gone by the time anyone looked.
    const failFn = runner.slice(runner.indexOf('fail()    {'), runner.indexOf('fail()    {') + 400);
    expect(failFn, 'a failed run still leaves nothing behind')
      .toMatch(/_archive_run_artifacts/);
  });

  it('archives when the run PASSES', () => {
    const i = runner.indexOf('PASSED — all');
    expect(runner.slice(i, i + 300)).toMatch(/_archive_run_artifacts/);
  });

  it('records which outcome it was', () => {
    expect(runner).toMatch(/outcome\.txt/);
  });

  it('generates the narrative and QA summary from what it captured', () => {
    expect(runner, 'the deliverables are still only produced by hand')
      .toMatch(/generate-run-report\.py/);
  });

  it('cannot change the run result', () => {
    // A post-run convenience must never turn a green run red, nor mask a red one.
    const fn = runner.slice(runner.indexOf('_archive_run_artifacts() {'),
                            runner.indexOf('_archive_run_artifacts() {') + 1600);
    expect((fn.match(/\|\| true/g) || []).length,
      'archiving steps are not individually guarded').toBeGreaterThanOrEqual(3);
    const failFn = runner.slice(runner.indexOf('fail()    {'), runner.indexOf('fail()    {') + 400);
    expect(failFn, 'the failure path no longer exits non-zero').toMatch(/exit 1/);
  });

  it('names the run folder after the shared run id', () => {
    // The same id must reach the Langfuse session and pre-run-reset's archive,
    // or a run folder cannot be matched to its traces.
    expect(runner).toMatch(/export ORCH_RUN_ID=/);
    expect(runner).toMatch(/runs\/\$\{ORCH_RUN_ID/);
  });
});
