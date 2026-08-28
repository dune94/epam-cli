/**
 * The canonical PRD must record the work that actually happened.
 *
 * mock1 run 10, 2026-07-27. The pipeline succeeded completely:
 *
 *   ✓ MOCK-HW-1-impl: Update getGreeting to return hello dolly [completed]
 *   ✓ MOCK-HW-1-test: Update hello.test.ts to assert hello dolly [completed]
 *   [orch] ✅ Pipeline complete.
 *
 * The canonical PRD then said the story was `deprecated`, with no completed
 * children anywhere in it.
 *
 * The spec pass splits a story into `<id>-impl` / `<id>-test` inside the
 * PER-CODELINE PRD and marks the parent deprecated. The merge-back is:
 *
 *   canonical.stories = canonical.stories.map(s => ...)
 *
 * A map can only rewrite entries that already exist. The children exist solely
 * in the per-codeline PRD, so they are silently dropped, and the one story left
 * in canonical is the deprecated parent. Everything downstream that reads the
 * PRD — the run report, a rerun deciding what is outstanding, a human — sees a
 * story that was abandoned and no evidence of the delivered work.
 *
 * This is the defect shape this codebase keeps producing: state that reports
 * LESS than what happened, with nothing checking the difference. It survived
 * because the assertion that catches it lives in a test gated behind
 * RUN_REAL_PIPELINE_MOCK, so it only runs against a real 40-minute pipeline.
 * These tests exercise the same merge with plain files, in milliseconds.
 *
 * The merge is lifted verbatim out of run-agent-orchestration.sh rather than
 * re-implemented, so a test cannot pass against a merge the pipeline does not
 * actually run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS_DIR = join(__dirname, '../../../orchestrations/scripts');
const ORCH = join(SCRIPTS_DIR, 'run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// THE MERGE MOVED TO ITS OWN HANDLER.
//
// This lifted an inline `"$NODE_BIN" -e "..."` block out of the orchestrator and rewrote its bash
// interpolations. That block no longer exists: the merge is
// lib/handlers/merge-lane-into-canonical.js, invoked with (SCRIPT_DIR, canonical, lane, name).
// The extraction found nothing, so every case failed with "merge-back block not found" — an
// extraction assumption about the implementation, breaking when the implementation moved.
//
// Running the REAL handler is better than the old surgery: no interpolation rewriting, and the
// test exercises exactly what production runs.
const MERGE_HANDLER = join(SCRIPTS_DIR, 'lib/handlers/merge-lane-into-canonical.js');

/** Run the real merge and return the canonical PRD as it lands on disk. */
function merge(canonical: any, perCodeline: any, codeline = 'mockhelloworld') {
  const dir = mkdtempSync(join(tmpdir(), 'merge-back-'));
  dirs.push(dir);
  const canonicalPath = join(dir, 'canonical.json');
  const codelinePath = join(dir, 'codeline.json');
  writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2));
  writeFileSync(codelinePath, JSON.stringify(perCodeline, null, 2));

  // No 2>/dev/null here: the pipeline swallows this call's stderr, so a merge that throws is
  // invisible in production. The test must see it.
  execFileSync(process.execPath,
    [MERGE_HANDLER, SCRIPTS_DIR, canonicalPath, codelinePath, codeline],
    { encoding: 'utf8', timeout: 20000 });

  return JSON.parse(readFileSync(canonicalPath, 'utf8'));
}

const parentPending = {
  id: 'MOCK-HW-1', title: 'Hello world greeting should say hello dolly',
  status: 'pending', completed: false,
};

/** What the spec pass leaves in the per-codeline PRD after splitting. */
const afterSplit = {
  stories: [
    { ...parentPending, status: 'deprecated', completed: false },
    { id: 'MOCK-HW-1-impl', title: 'Update getGreeting', status: 'completed', completed: true, completedAt: '2026-07-27T21:13:22-04:00' },
    { id: 'MOCK-HW-1-test', title: 'Update hello.test.ts', status: 'completed', completed: true, completedAt: '2026-07-27T21:15:00-04:00' },
  ],
};

describe('split children survive the merge back into canonical', () => {
  it('records the children that actually ran', () => {
    const out = merge({ stories: [parentPending] }, afterSplit);
    const ids = out.stories.map((s: any) => s.id);
    expect(ids,
      'the pipeline implemented, tested and committed two child stories, and the ' +
      'canonical PRD kept no record of either — only the deprecated parent')
      .toEqual(expect.arrayContaining(['MOCK-HW-1-impl', 'MOCK-HW-1-test']));
  });

  it('carries their completion state, not just their ids', () => {
    const out = merge({ stories: [parentPending] }, afterSplit);
    for (const id of ['MOCK-HW-1-impl', 'MOCK-HW-1-test']) {
      const st = out.stories.find((s: any) => s.id === id);
      expect(st?.status, `${id} status`).toBe('completed');
      expect(st?.completed, `${id} completed`).toBe(true);
      expect(st?.completedAt, `${id} completedAt`).toBeTruthy();
    }
  });

  it('leaves at least one story that is not deprecated', () => {
    // The exact condition the live assertion tripped on: every story matching the
    // ticket was deprecated, so "what did this run deliver?" answers "nothing".
    const out = merge({ stories: [parentPending] }, afterSplit);
    const live = out.stories.filter((s: any) =>
      (s.id === 'MOCK-HW-1' || String(s.id).startsWith('MOCK-HW-1-')) && s.status !== 'deprecated');
    expect(live.length, 'every story for this ticket reads as abandoned').toBeGreaterThan(0);
  });

  it('still marks the parent deprecated', () => {
    // The split is real: the parent must not look like outstanding work either.
    const out = merge({ stories: [parentPending] }, afterSplit);
    expect(out.stories.find((s: any) => s.id === 'MOCK-HW-1')?.status).toBe('deprecated');
  });
});

describe('the merge does not disturb what it should leave alone', () => {
  it('keeps canonical stories the codeline never touched', () => {
    const other = { id: 'OTHER-1', status: 'pending', completed: false };
    const out = merge({ stories: [parentPending, other] }, afterSplit);
    expect(out.stories.find((s: any) => s.id === 'OTHER-1'),
      'a story belonging to another codeline was dropped or rewritten')
      .toMatchObject({ status: 'pending', completed: false });
  });

  it('does not duplicate a story already present in canonical', () => {
    const canonical = { stories: [parentPending, { id: 'MOCK-HW-1-impl', status: 'pending', completed: false }] };
    const out = merge(canonical, afterSplit);
    const impl = out.stories.filter((s: any) => s.id === 'MOCK-HW-1-impl');
    expect(impl.length, 'the child was appended on top of the existing entry').toBe(1);
    expect(impl[0].status, 'the existing entry was not updated').toBe('completed');
  });

  it('preserves top-level PRD fields', () => {
    const out = merge(
      { project: { name: 'mock' }, implementationOrder: { core: ['MOCK-HW-1'] }, stories: [parentPending] },
      afterSplit);
    expect(out.project?.name).toBe('mock');
    expect(out.implementationOrder?.core).toEqual(['MOCK-HW-1']);
  });

  it('leaves a single-codeline story merging wholesale, as before', () => {
    // The pre-existing contract for the ordinary case must be untouched.
    const out = merge(
      { stories: [parentPending] },
      { stories: [{ ...parentPending, status: 'completed', completed: true, completedAt: 'x' }] });
    expect(out.stories[0]).toMatchObject({ status: 'completed', completed: true });
  });
});
