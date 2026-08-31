/**
 * THE REVIEW STEPS, DRIVEN WITHOUT A MODEL.
 *
 * Both take `promptExec` as a parameter, so every one of these paths runs for nothing: the model
 * call is an injection point, not a reason to need a paid run. 173 lines of review logic had no test
 * because I never checked whether the call was injectable — the same mistake that had me claim twice
 * that seams needed a paid run when both were parameters.
 *
 * SCOPE: the early returns. Driving the POSITIVE path needs a fully populated spec-story-block
 * render (nine placeholders sourced from the spec pass's own state, not from the story object), so
 * those cases belong with a spec-pass harness rather than here. Everything below is a decision NOT
 * to spend money, and that is the half that fails silently: if a guard stops working the run still
 * succeeds, it just costs more and reviews nothing.
 *
 * What matters most here is the EARLY RETURNS. Each one is a decision not to spend money, and a
 * decision not to spend is exactly the kind that fails silently: if a guard stops working the run
 * still succeeds, it just costs more and reviews nothing. Nothing downstream can tell.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
const { reviewTicketLinks, reviewSurvey } = runner;

const logDir = () => mkdtempSync(join(tmpdir(), 'reviewlog-'));

// THE PROMPTS THESE SEAMS REFUSE TO RUN WITHOUT, FOR £0. Each specialised copy is produced by
// stubbing the model call that specialises it — buildProjectPrompts takes runText as a parameter.
// Without this the positive cases cannot execute at all, and only the early returns would be tested,
// which is how a guard ends up proven while the thing it guards is not.
let provisioned = '';
const savedConfigDir = process.env.EPAM_PROJECT_CONFIG_DIR;
beforeAll(async () => {
  const { provisionProject } = await import('../../helpers/provisioned-project');
  const p = await provisionProject();
  provisioned = p.dir;
  process.env.EPAM_PROJECT_CONFIG_DIR = provisioned;
}, 120_000);
afterAll(() => { process.env.EPAM_PROJECT_CONFIG_DIR = savedConfigDir; });

/** A promptExec that records what it was asked and answers with whatever we choose. */
function recordingExec(reply: string) {
  const calls: any[] = [];
  const exec = vi.fn(async (...args: any[]) => { calls.push(args); return reply; });
  return { exec, calls };
}

describe('reviewTicketLinks does not spend when there is nothing to review', () => {
  it('a story with NO ticket links makes no model call at all', async () => {
    const { exec, calls } = recordingExec('[]');
    const out = await reviewTicketLinks({ promptExec: exec, story: { id: 'S-1' }, logDir: logDir() });
    expect(out).toEqual([]);
    expect(calls.length, 'a model was called to review zero links').toBe(0);
  });

  it('an EMPTY ticketLinks array is the same — empty is not "unknown"', async () => {
    const { exec, calls } = recordingExec('[]');
    const out = await reviewTicketLinks({
      promptExec: exec, story: { id: 'S-1', ticketLinks: [] }, logDir: logDir() });
    expect(out).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('and a non-array ticketLinks does not crash the pass', async () => {
    const { exec } = recordingExec('[]');
    for (const bad of [null, 'https://x', 42, {}]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await reviewTicketLinks({
        promptExec: exec, story: { id: 'S-1', ticketLinks: bad }, logDir: logDir() });
      expect(out, `ticketLinks=${JSON.stringify(bad)} was not handled`).toEqual([]);
    }
  });


});

describe('reviewSurvey refuses to falsify a survey that never ran', () => {
  it('a survey that did not run is reported as not-run, with no model call', async () => {
    // Findings about a failure are findings about nothing. The distinction matters: `ran: false`
    // tells a reader the review did not happen, where an empty findings list would say it did and
    // found nothing.
    const { exec, calls } = recordingExec('{}');
    const out = await reviewSurvey({ promptExec: exec, survey: { ran: false }, logDir: logDir() });
    expect(out.ran, 'a survey that never ran was reported as reviewed').toBe(false);
    expect(out.findings).toEqual([]);
    expect(out.reviewed).toBe(0);
    expect(calls.length, 'a model was paid to review a survey that did not run').toBe(0);
  });

  it('the same for a missing survey, a missing codelines array, and an empty one', async () => {
    const { exec, calls } = recordingExec('{}');
    for (const survey of [null, undefined, {}, { ran: true }, { ran: true, codelines: [] },
      { ran: true, codelines: 'not an array' }]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await reviewSurvey({ promptExec: exec, survey, logDir: logDir() });
      expect(out.ran, `survey=${JSON.stringify(survey)} was treated as reviewable`).toBe(false);
      expect(out.findings).toEqual([]);
    }
    expect(calls.length, 'a model was called for a survey with nothing in it').toBe(0);
  });

});
