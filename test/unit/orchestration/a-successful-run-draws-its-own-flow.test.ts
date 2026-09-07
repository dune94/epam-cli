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
