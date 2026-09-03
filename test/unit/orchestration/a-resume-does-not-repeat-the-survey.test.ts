/**
 * A RESUME REPEATS NOTHING IT ALREADY DID, AND LOSES NOTHING IT ALREADY PRODUCED.
 *
 * Operator rules, 2026-09-02: duplication of a process after a pause is not permitted, and
 * information a downstream agent requires must not be lost. Both land on the same artefact here.
 *
 * The estate survey observes the codeline before the roster is assembled. It runs before pause 1,
 * its findings are shown to the operator there, and pre-run-reset already KEEPS it on a resume
 * ("Resuming — keeping this run's own fetched documents and estate survey"). So the information
 * survives; surveyEstate simply never looked, and re-ran the observation every time.
 *
 * THE COST IS NOT THE ONE CALL. The survey feeds codelineContext, and codelineContext is part of
 * the prompt cache key:
 *
 *     baseDigest = sha({ template, generatorBody, projectContext, codelineContext })
 *
 * A re-run survey produces a different context, so EVERY one of the 39 project prompts misses the
 * cache and is regenerated. Measured on the 2026-09-02 resume of run 20260902T022134Z: roster
 * correctly reused (49 agents, md5 identical), roles digest stable at 1dad7a5a… — and reused: 0,
 * because the survey had moved the key underneath them. The checkpoint skipped the mint and paid
 * for the whole prompt stage anyway.
 *
 * THE FILE'S PRESENCE IS THE SIGNAL, exactly as for the roster. pre-run-reset deletes
 * estate-survey.json on every NEW launch and keeps it only when EPAM_RESUME_RUN is set, so a
 * survey still on disk when this runs can only have been kept by a resume. The reset owns the
 * lifetime; this honours what it left, and no run id is consulted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'));

const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function logDirWithSurvey(body?: any) {
  const d = mkdtempSync(join(tmpdir(), 'resume-survey-'));
  cleanup.push(d);
  if (body) writeFileSync(join(d, 'estate-survey.json'), JSON.stringify(body, null, 2));
  return d;
}

const KEPT = {
  ran: true,
  codelines: [{ codeline: 'gotransit', state: 'in_scope', surfaces: ['src/components/pages/CheckoutPage'] }],
  recommendedInvestigators: [{ codeline: 'gotransit', focus: 'confirm where email equality is checked' }],
  recommendedWriters: [],
  violations: [],
};

describe('a resume does not repeat the survey', () => {
  it('surveyEstate is callable — otherwise nothing below is a fact', () => {
    expect(typeof spec.surveyEstate, 'surveyEstate is not exported').toBe('function');
  });

  it('REUSES A SURVEY ALREADY ON DISK — no second observation, no second call', async () => {
    const logDir = logDirWithSurvey(KEPT);
    let called = 0;
    const out = await spec.surveyEstate({
      promptExec: { cmd: 'false', args: [] },
      tickets: [{ id: 'AMSD-1919', title: 'x', description: 'y' }],
      referencedDocs: [], declaredDependencies: [],
      codelines: [{ name: 'gotransit', path: '/nonexistent', dependencies: [] }],
      toolGrant: 'read-only', logDir, repoPath: '/nonexistent',
      // If the survey runs, it must go through the runner; count that.
      _runForTest: () => { called += 1; return ''; },
    });
    expect(called, 'the survey ran again despite one already being on disk').toBe(0);
    expect(out.ran, 'the reused survey is reported as not having run').toBe(true);
    expect(out.codelines?.[0]?.codeline, 'the reused survey lost its codeline finding')
      .toBe('gotransit');
    expect(out.recommendedInvestigators?.[0]?.focus,
      'the investigator recommendation — which the mint reads — was lost')
      .toContain('email equality');
  });

  it('AND THE FILE IS UNTOUCHED — a reuse that rewrites it is not a reuse', async () => {
    const logDir = logDirWithSurvey(KEPT);
    const before = readFileSync(join(logDir, 'estate-survey.json'), 'utf8');
    await spec.surveyEstate({
      promptExec: { cmd: 'false', args: [] },
      tickets: [{ id: 'AMSD-1919', title: 'x', description: 'y' }],
      referencedDocs: [], declaredDependencies: [],
      codelines: [{ name: 'gotransit', path: '/nonexistent', dependencies: [] }],
      toolGrant: 'read-only', logDir, repoPath: '/nonexistent',
    });
    expect(readFileSync(join(logDir, 'estate-survey.json'), 'utf8'),
      'the kept survey was overwritten').toBe(before);
  });

  it('A MALFORMED SURVEY IS NOT TRUSTED — it is observed again rather than believed', async () => {
    // The same contract rule the roster reuse follows: stored state that cannot be read is not
    // silently accepted, or a corrupt file would silently disable the survey for the whole run.
    const logDir = mkdtempSync(join(tmpdir(), 'resume-survey-bad-'));
    cleanup.push(logDir);
    writeFileSync(join(logDir, 'estate-survey.json'), '{ not json');
    const out = await spec.surveyEstate({
      promptExec: { cmd: 'false', args: [] },
      tickets: [{ id: 'AMSD-1919', title: 'x', description: 'y' }],
      referencedDocs: [], declaredDependencies: [],
      codelines: [{ name: 'gotransit', path: '/nonexistent', dependencies: [] }],
      toolGrant: 'read-only', logDir, repoPath: '/nonexistent',
    });
    // It must not throw, and must not report a REUSE. With an unrunnable promptExec the fresh
    // survey cannot succeed, so ran:false is the honest outcome — what matters is that the corrupt
    // file was not returned as though it were this run's observation.
    expect(out, 'a corrupt survey file crashed the step').toBeTruthy();
    expect(out.ran, 'a corrupt file was accepted as a completed survey').toBe(false);
  });
});
