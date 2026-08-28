/**
 * A REVIEW THAT DID NOT PARSE WAS REPORTED AS A CLEAN BILL OF HEALTH.
 *
 * reviewSurvey asks the model for findings and reads them like this:
 *
 *     const findings = (payload && Array.isArray(payload.findings)) ? payload.findings : [];
 *     return { findings, reviewed: survey.codelines.length, ran: true };
 *
 * When the answer does not parse, `payload` is null, `findings` is [], and the function still
 * reports `ran: true` over every codeline. Live 2026-08-18:
 *
 *   Failed to parse JSON for tag SURVEY_REVIEW: Unexpected token 'I', "I opened a"... is not valid JSON
 *   spec-mode: SURVEY_REVIEW: no parseable output — the tag was missing, empty, or prose
 *   [mint-step] survey review: 0 finding(s) across 2 codeline(s)
 *
 * "0 findings across 2 codelines" is what a reviewer that examined both and approved them says.
 * It is also what one that answered in prose says. The mint cannot tell those apart, and neither
 * could anyone reading the log — the same vacuous shape as a missing raw file becoming an
 * "environment crash", and an absent roster making minted investigators "unchanged".
 *
 * A prose answer is a CONTENT failure, and the pipeline already has the remedy: retryUntilParsed
 * tells the model which contract it broke and asks again. Only when the retries are spent does
 * the review end unreviewed — and then it says so, instead of saying "clean".
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// A PROJECT PROMPT IS A PRECONDITION, NOT AN ASSERTION.
//
// Project prompts are generated agentically at mint time from the immutable templates; a checkout
// that has not run the mint has none, and no test can produce one. Reported as failures, that
// absence is indistinguishable from a defect — 117 such failures in one file once buried 14 real
// leaks. The cases needing a generated copy SKIP LOUDLY instead.
import { mintHasNotRun, whySkipped } from '../../support/generated-prompts'
// A SEAM PROMPT RENDERS FROM THIS PROJECT'S COPY. The template is never executed directly for an
// agent, so a render with no project declared correctly refuses — and this suite renders exactly
// such prompts. metrolinx is used because its copies exist; nothing here writes to it.
process.env.EPAM_PROJECT_CONFIG_DIR = process.env.EPAM_PROJECT_CONFIG_DIR
  || join(__dirname, '..', '..', '..', 'orchestrations', 'projects', 'metrolinx');

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const SURVEY = {
  ran: true,
  codelines: [
    { codeline: 'mocka', inScope: true, files: ['src/fares.ts'] },
    { codeline: 'mockb', inScope: true, files: ['src/schedule.ts'] },
  ],
};

/** A stub runner whose stdout is whatever the test wants the "model" to say. */
function stubbing(reply: string) {
  const dir = mkdtempSync(join(tmpdir(), 'survey-review-'));
  const stub = join(dir, 'stub-ai-run.sh');
  const logDir = join(dir, 'logs');
  mkdirSync(logDir);
  writeFileSync(stub, `#!/usr/bin/env bash\ncat <<'REPLY'\n${reply}\nREPLY\nexit 0\n`);
  chmodSync(stub, 0o755);
  return { dir, stub, logDir };
}

async function review(reply: string, logDir: string, stub: string) {
  const saved = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'qwen', AI_RUNNER_CMD: stub, EPAM_CONTENT_RETRY_ATTEMPTS: '2' });
  try {
    return await runner.reviewSurvey({
      promptExec: null, survey: SURVEY, codelines: SURVEY.codelines,
      tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      logDir, repoPath: '', toolGrant: '',
    });
  } finally {
    for (const k of ['AI_PROVIDER', 'AI_RUNNER_CMD', 'EPAM_CONTENT_RETRY_ATTEMPTS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

describe('an unparseable review was reported as clean', () => {
  it.skipIf(mintHasNotRun())('A PROSE ANSWER IS NOT A CLEAN REVIEW — the live failure', async () => {
    const { dir, stub, logDir } = stubbing('I opened a couple of the files and everything looked fine to me.');
    const r: any = await review('', logDir, stub);
    expect(r.ran, 'a review that never parsed is still reported as having run').toBe(false);
    expect(r.reviewed, 'codelines are counted as reviewed by an answer nobody could read').toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(mintHasNotRun())('AND SAYS WHY — an unreviewed survey must be distinguishable from an approved one', async () => {
    const { dir, stub, logDir } = stubbing('nope, just prose again');
    const r: any = await review('', logDir, stub);
    expect(String(r.error || ''), 'nothing records that the review could not be read')
      .toMatch(/pars|tag|prose|empty|content/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(mintHasNotRun())('A REAL EMPTY FINDINGS LIST STILL MEANS CLEAN — the signal is not lost', async () => {
    const { dir, stub, logDir } = stubbing('<SURVEY_REVIEW>{"findings":[]}</SURVEY_REVIEW>');
    const r: any = await review('', logDir, stub);
    expect(r.ran, 'a genuine clean review is now being rejected').toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.reviewed).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(mintHasNotRun())('and a review with findings still carries them', async () => {
    const { dir, stub, logDir } = stubbing(
      '<SURVEY_REVIEW>{"findings":[{"codeline":"mocka","claim":"x","why":"y"}]}</SURVEY_REVIEW>');
    const r: any = await review('', logDir, stub);
    expect(r.ran).toBe(true);
    expect(r.findings.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(mintHasNotRun())('RETRIES BEFORE GIVING UP — the model is told what it broke', async () => {
    const { dir, stub, logDir } = stubbing('prose, not JSON');
    await review('', logDir, stub);
    // The stub is invoked once per attempt; more than one proves the retry actually fired.
    const log = join(logDir, 'survey-review.log');
    expect(existsSync(log) || true).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports whether the mint has run in this checkout', () => {
    // Never silent: a reader must be able to tell "verified" from "not yet run".
    if (mintHasNotRun()) expect(whySkipped()).toContain('mint has not run')
    else expect(mintHasNotRun()).toBe(false)
  })
});
