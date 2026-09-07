/**
 * A RESUMED RUN'S FLOW SHOWS THE WHOLE CHAIN, NOT ITS OWN SEGMENT.
 *
 * THE LIVE CONFUSION (2026-09-07). Successful-Run-Sept-07-1's flow page showed 14 of 29 stages as
 * "did not apply" and looked like a run that had barely executed. It was in fact a RESUME from the
 * pre-writer checkpoint of an earlier run: everything upstream of the writer had already run, in
 * the parent, and was deliberately not repeated. The page reported its own segment truthfully and
 * still gave a false impression of the work, because the half that did the upstream stages was in
 * another directory the page never mentioned.
 *
 * A resume is one continuing piece of work across several run directories. The flow must say so:
 * the parent's stages, then this run's, in order, each attributed to the run that executed it.
 *
 * AND THE SKIPS MUST BE ACCOUNTABLE. That same resume carried SKIP_REGRESSION_GUARD=true while the
 * project's own config.env declares it false — which stood down BOTH the regression guard and the
 * regression delta gate on a run recorded as passed. A resume flag that overrides a stage is part
 * of how the run happened; it belongs on the page, not only at line 79 of a 2.5MB log.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'orchestrations', 'scripts');
const REPORT = join(SCRIPTS, 'generate-run-report.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const PARENT_LOG = [
  "Codeline 'gotransit' → /tmp/cl/next.gotransit.com",
  '▶ Step 2: CPA pre-pass',
  '✓ Step 2: CPA pre-pass — passed',
  '▶ Step 5: Regression guard',
  '✓ Step 5: Regression guard — passed',
  '⏸ Paused before the writer',
];

const CHILD_LOG = (parentId: string) => [
  "Codeline 'gotransit' → /tmp/cl/next.gotransit.com",
  `[checkpoint] resumed run '${parentId}' — 1 story(ies), taken at 2026-09-07T02:21:00Z`,
  '[INFO] [orch]   resume: EPAM_RESUMED_FROM_STAGE=pre-writer',
  '[INFO] [orch]   resume: SKIP_CPA=1',
  '[INFO] [orch]   resume: SKIP_REGRESSION_GUARD=true',
  '⊘ Step 2: CPA pre-pass — did not apply',
  '▶ Step 8: Main-branch stories',
  '✓ Step 8: Main-branch stories — passed',
  '✓ Pipeline complete',
];

/** Builds a runs/ tree the way a real install has it: one directory per run, siblings. */
function runsTree(): { runs: string; make: (id: string, log: string[]) => string } {
  const runs = tmp('runs-');
  return {
    runs,
    make(id: string, log: string[]) {
      const dir = join(runs, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'run.log'), log.join('\n'));
      execFileSync('python3', [REPORT, '--launch-log', join(dir, 'run.log'),
        '--logs-dir', tmp('logs-'), '--out', dir], { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
      return dir;
    },
  };
}

describe('a resumed run', () => {
  it('draws the parent run\'s stages as well as its own', () => {
    const t = runsTree();
    const parentId = '20260906T225844Z';
    t.make(parentId, PARENT_LOG);
    const child = t.make('20260907T031002Z', CHILD_LOG(parentId));
    const h = readFileSync(join(child, 'flow.html'), 'utf8');

    expect(h, 'the run it resumed from is not named anywhere').toContain(parentId);
    expect(h, "a stage only the PARENT executed is missing — the page shows half the work")
      .toContain('Regression guard');
    expect(h, "this run's own stage is missing").toContain('Main-branch stories');

    // Order: the parent's work came first.
    expect(h.indexOf('Regression guard'), 'the chain is drawn out of order')
      .toBeLessThan(h.indexOf('Main-branch stories'));
  });

  it('says which run executed each part, so the chain is not read as one run', () => {
    const t = runsTree();
    const parentId = '20260906T225844Z';
    t.make(parentId, PARENT_LOG);
    const child = t.make('20260907T031002Z', CHILD_LOG(parentId));
    const h = readFileSync(join(child, 'flow.html'), 'utf8');
    expect(h, 'nothing marks where the resume picked up').toMatch(/resum/i);
    expect(h, 'the resumed-from stage is not stated').toContain('pre-writer');
  });

  it('surfaces the skip flags the resume carried', () => {
    // The one that hid two gates on a run reported as passed.
    const t = runsTree();
    const parentId = '20260906T225844Z';
    t.make(parentId, PARENT_LOG);
    const child = t.make('20260907T031002Z', CHILD_LOG(parentId));
    const h = readFileSync(join(child, 'flow.html'), 'utf8');
    expect(h, 'a resume flag that stood a gate down is not on the page')
      .toContain('SKIP_REGRESSION_GUARD');
  });

  it('a run that resumed nothing is unchanged — no invented ancestry', () => {
    const t = runsTree();
    const solo = t.make('20260907T090000Z', [
      "Codeline 'gotransit' → /tmp/cl/next.gotransit.com",
      '▶ Step 8: Main-branch stories',
      '✓ Step 8: Main-branch stories — passed',
      '✓ Pipeline complete',
    ]);
    const h = readFileSync(join(solo, 'flow.html'), 'utf8');
    expect(h).toContain('Main-branch stories');
    expect(h, 'a solo run was given an ancestry it does not have').not.toMatch(/resumed from run/i);
  });

  it("recovers the parent's stages from the archive when the pause kept no log", () => {
    /**
     * THE CONTIGUITY REQUIREMENT. A run that PAUSES saves a checkpoint, not its launch log, so a
     * resumed run's parent has no run.log at all — and the first cut of this page therefore
     * announced that the parent's stages "cannot be drawn" for a run whose work is plainly on
     * disk. It is not gone: the next run's pre-run reset archives the whole logs directory, and
     * every phase-cost record in there carries the run id that produced it. That is the key that
     * finds it. A resume is one continuous run and must be drawn as one.
     */
    const t = runsTree();
    const parentId = '20260906T225844Z';
    mkdirSync(join(t.runs, parentId), { recursive: true });   // checkpoint dir, no log — as live

    // The archive the pre-run reset left behind, correlated by run id in phase-cost.jsonl.
    const logs = tmp('logs-');
    const arch = join(logs, 'archive', 'pre-run-20260907T020524Z');
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, 'phase-cost.jsonl'),
      JSON.stringify({ run_id: parentId, agent_name: 'codeline-discovery' }) + '\n');
    writeFileSync(join(arch, 'agent-activity.jsonl'), [
      JSON.stringify({ timestamp: '2026-09-06T23:01:44+00:00', agent: 'codeline-discovery', type: 'info' }),
      JSON.stringify({ timestamp: '2026-09-07T00:23:51+00:00', agent: 'prd-model-coordinator', type: 'story_start' }),
    ].join('\n') + '\n');

    const dir = join(t.runs, '20260907T031002Z');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.log'), CHILD_LOG(parentId).join('\n'));
    execFileSync('python3', [REPORT, '--launch-log', join(dir, 'run.log'),
      '--logs-dir', logs, '--out', dir], { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
    const h = readFileSync(join(dir, 'flow.html'), 'utf8');

    expect(h, "the parent's recovered stages are not drawn — the flow is still only half the run")
      .toContain('codeline-discovery');
    expect(h, "the parent's later stage is missing").toContain('prd-model-coordinator');
    expect(h, "this run's own stage is missing").toContain('Main-branch stories');
    expect(h.indexOf('codeline-discovery'), 'the chain is out of order')
      .toBeLessThan(h.indexOf('Main-branch stories'));
    expect(h, 'the page still claims the parent cannot be drawn')
      .not.toMatch(/cannot be drawn/i);
  });

  it('a parent whose evidence is gone is SAID to be missing, not silently dropped', () => {
    // The parent directory is never created. A page that just omits it would show the same
    // partial flow that caused the confusion, with nothing to explain it.
    const t = runsTree();
    const child = t.make('20260907T031002Z', CHILD_LOG('20260101T000000Z'));
    const h = readFileSync(join(child, 'flow.html'), 'utf8');
    expect(h, 'the missing parent run is not mentioned at all').toContain('20260101T000000Z');
    expect(h, "the page does not say the parent's stages are undrawable, or why")
      .toMatch(/cannot be drawn/i);
    expect(h, 'the reason the parent could not be read is not given')
      .toMatch(/run directory not found|kept no log/i);
  });
});
