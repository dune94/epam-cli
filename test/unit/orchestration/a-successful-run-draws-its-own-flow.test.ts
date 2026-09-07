/**
 * A SUCCESSFUL RUN DRAWS ITS OWN FLOW.
 *
 * The operator keeps a hand-drawn execution-flow diagram of the pipeline's stages. A drawing kept
 * by hand describes the pipeline someone believed was running on the day they drew it; the run
 * knows which stages it ACTUALLY executed, in what order, and how each one ended. So the run
 * emits its own — flow.html, beside narrative.html and qa-summary.html — built from the same
 * timeline the narrative is built from.
 *
 * THE RULE THIS ENCODES: no project details in the engine. The page must carry no stage list,
 * no codeline name and no model name of its own — feed it a different project's run and it must
 * draw that project. A diagram with a built-in stage list is a drawing again, just checked in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'orchestrations', 'scripts');
const REPORT = join(SCRIPTS, 'generate-run-report.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Drives the real generator over a synthetic run log and returns the emitted flow page. */
function flowFor(lines: string[]): string {
  const out = tmp('out-');
  const logFile = join(tmp('log-'), 'run.log');
  writeFileSync(logFile, lines.join('\n'));
  execFileSync('python3', [REPORT, '--launch-log', logFile,
    '--logs-dir', tmp('logs-'), '--out', out], { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
  const f = join(out, 'flow.html');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

const RUN_A = [
  "Codeline 'gotransit' → /tmp/cl/next.gotransit.com",
  '▶ Step 6: Code graph detective',
  '✓ Step 6: Code graph detective — passed',
  '▶ Step 8: Main-branch stories',
  '✓ Step 8: Main-branch stories — passed',
  '⊘ Step 23: Browser E2E — did not apply',
  '✓ Pipeline complete',
];

describe('a run emits its own execution flow', () => {
  it('emits flow.html at all', () => {
    expect(flowFor(RUN_A), 'no flow.html — the run drew nothing').toBeTruthy();
  });

  it('draws the stages THIS run executed, in order, as a real diagram', () => {
    const h = flowFor(RUN_A);
    expect(h, 'not a diagram — a flow of stages needs drawn nodes and edges').toContain('<svg');
    const iDetective = h.indexOf('Code graph detective');
    const iStories = h.indexOf('Main-branch stories');
    expect(iDetective, 'a stage this run ran is missing from its own flow').toBeGreaterThan(-1);
    expect(iStories, 'a stage this run ran is missing from its own flow').toBeGreaterThan(-1);
    expect(iDetective, 'stages are not drawn in execution order').toBeLessThan(iStories);
  });

  it('shows how each stage ENDED — a flow that hides a skip is a lie about the run', () => {
    const h = flowFor(RUN_A);
    expect(h, 'a stage that did not apply is drawn as though it ran').toMatch(/did not apply|skip/i);
  });

  it('each stage carries HOW it was run — model, effort, cost — read, never assumed', () => {
    /**
     * A stage name alone does not say how the work was done. The operator's own diagram carries a
     * settings line under every agent box, and the run records all of it: resolvedModel and
     * effort and cost in phase-cost.jsonl, ladder rungs and retries and self-heal in the activity
     * stream. A box with no record shows NOTHING rather than a plausible default.
     */
    const logs = tmp('logs-');
    writeFileSync(join(logs, 'phase-cost.jsonl'), JSON.stringify({
      agent_name: 'checkout-form-engineer', resolvedModel: 'claude-sonnet-5',
      effort: 'high', task_tokens_out: 10726, task_cost_usd: 0.4687,
    }) + '\n');
    writeFileSync(join(logs, 'agent-activity.jsonl'), JSON.stringify({
      agent: 'checkout-form-engineer', type: 'retry',
      detail: { message: 'Retry R1 Rung0: model=claude-sonnet-5 (self-heal active)' },
    }) + '\n');
    const out = tmp('out-');
    const logFile = join(tmp('log-'), 'run.log');
    writeFileSync(logFile, [
      "Codeline 'gotransit' → /tmp/cl/x",
      '▶ Step 8: checkout-form-engineer',
      '✓ Step 8: checkout-form-engineer — passed',
      '⊘ Step 23: Browser E2E — did not apply',
      '✓ Pipeline complete',
    ].join('\n'));
    execFileSync('python3', [REPORT, '--launch-log', logFile, '--logs-dir', logs, '--out', out],
      { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
    const h = readFileSync(join(out, 'flow.html'), 'utf8');

    expect(h, 'the model that answered is not on the stage').toContain('claude-sonnet-5');
    expect(h, 'the effort asked for is not shown').toContain('high');
    expect(h, 'output tokens are not shown').toContain('10,726');
    expect(h, 'cost is not shown').toContain('$0.4687');
    expect(h, 'a retry is not shown').toMatch(/1 retry/);
    expect(h, 'self-heal firing is not shown').toContain('self-heal');
    expect(h, 'the models this run used are not summarised').toMatch(/Models this run used/i);

    // A stage with no record must not be decorated with someone else's settings.
    const e2e = h.indexOf('Browser E2E');
    expect(h.slice(e2e, e2e + 400), 'a deterministic stage was given invented settings')
      .not.toContain('claude-sonnet-5');
  });

  it('NO PROJECT DETAILS: a different project gets a different drawing', () => {
    // The engine is generic. Same code, another project's log — nothing from the first may leak.
    const h = flowFor([
      "Codeline 'shop' → /tmp/cl/checkout-api",
      '▶ Step 4: Estate survey',
      '✓ Step 4: Estate survey — passed',
      '✓ Pipeline complete',
    ]);
    expect(h, "the other project's stage was not drawn").toContain('Estate survey');
    expect(h, 'a stage from a DIFFERENT run leaked into this page — the stage list is hardcoded')
      .not.toContain('Code graph detective');
    expect(h.toLowerCase(), 'a project name is baked into the engine')
      .not.toContain('gotransit');
  });
});
