/**
 * capture_story_ids_snapshot / assert_no_story_ids_lost — deterministic
 * invariant check against silent story deletion from prd.stories[].
 *
 * Root cause this guards against (found live, 2026-07-09, tier3-travel-app
 * run): SKY-002/003/004 vanished ENTIRELY from prd.stories[] — not merely
 * stripped of technicalNotes.files (the already-fixed orphaned-pending-story
 * gate scenario) — sometime during the scaffold phase. A deliberate repro
 * attempt (fresh teardown + a poller watching the story-ID list every
 * second) did NOT reproduce it, meaning the defect is intermittent, most
 * likely tied to a specific LLM response shape in one of the three steps
 * that give an agent full Bash/WriteFile tool access to the PRD (Step 0.5,
 * Step 0.9, and run_phase_assessment's Step 3.5/Step 6 calls).
 *
 * SELF-HEALING (added 2026-07-11, after this fired live a SECOND time —
 * Step 0.5 wiped SKY-002/003/004, which belong to the "core" phase, while
 * running against "scaffold"): capture_story_ids_snapshot now also snapshots
 * the full story OBJECTS (not just IDs) alongside the ID list.
 * assert_no_story_ids_lost restores any vanished story from that snapshot
 * and continues, instead of hard-aborting the whole pipeline every time this
 * intermittent LLM tool-use defect recurs. It only still hard-fails if a
 * missing story ID has no full-object snapshot to restore from.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertNoStoryIdsLost } = require('../../../orchestrations/scripts/spec-mode-runner.js');
const SPEC_MODE_RUNNER_SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8'
);

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = orchSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(startIdx, i + 1).join('\n');
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('capture_story_ids_snapshot / assert_no_story_ids_lost — wiring (static)', () => {
  it('both helper functions are defined', () => {
    expect(orchSrc).toMatch(/capture_story_ids_snapshot\(\) \{/);
    expect(orchSrc).toMatch(/assert_no_story_ids_lost\(\) \{/);
  });

  it('the snapshot is captured right after Step 0 (specification pass) completes', () => {
    const idx = orchSrc.indexOf('run_specification_pass "$PHASE"');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/capture_story_ids_snapshot "presplit"/);
  });

  it('an assertion is wired after Step 0.5 (pre-phase skill assessment)', () => {
    const idx = orchSrc.indexOf('run_pre_phase_assessment "$PHASE"');
    const block = orchSrc.slice(idx, idx + 200);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 0\.5/);
  });

  it('an assertion is wired after Step 0.9 (PRD model coordinator)', () => {
    const idx = orchSrc.indexOf('step_emit "0.9" "pass" "Step 0.9: PRD model coordinator"');
    const block = orchSrc.slice(idx, idx + 200);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 0\.9/);
  });

  it('an assertion is wired after the Step 3.5 run_phase_assessment call site', () => {
    const idx = orchSrc.indexOf('step_emit "3.5" "skip" "Step 3.5: Post-parallel assessment" "no cost data"');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 3\.5/);
  });

  it('an assertion is wired after the Step 6 run_phase_assessment call site', () => {
    const idx = orchSrc.indexOf('Step 6: Running final post-phase assessment');
    // Widened (2026-07-12): the call site grew an explanatory comment block
    // plus if/else step_emit wiring (see phase-assessment-real-output-gate.
    // test.ts's "Step 6 call site" describe block for why) that pushed the
    // assert calls further from the anchor than the old 400-char window.
    const block = orchSrc.slice(idx, idx + 1400);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 6/);
  });
});

describe('capture_story_ids_snapshot / assert_no_story_ids_lost — REAL execution', () => {
  function run(prdBefore: object, prdAfter: object, stepName: string): { exitCode: number; stdout: string } {
    const captureBlock = extractFunctionByLineAnchor('capture_story_ids_snapshot');
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_lost');
    const dir = mkdtempSync(join(tmpdir(), 'story-id-loss-invariant-'));
    const prdPath = join(dir, 'prd.json');
    const snapshotDir = join(dir, 'snapshots');
    writeFileSync(prdPath, JSON.stringify(prdBefore));

    const script = [
      'error() { echo "ERROR: $*"; }',
      'warning() { echo "WARN: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      captureBlock,
      assertBlock,
      'capture_story_ids_snapshot "presplit"',
      // Simulate the PRD-mutating step by overwriting the file, then assert.
      `cat > ${JSON.stringify(prdPath)} << 'PRDEOF'`,
      JSON.stringify(prdAfter),
      'PRDEOF',
      `assert_no_story_ids_lost "presplit" ${JSON.stringify(stepName)}`,
      'echo ASSERT_PASSED',
    ].join('\n');

    try {
      const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      return { exitCode: 0, stdout };
    } catch (e: any) {
      return { exitCode: e.status ?? -1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the SELF-HEALING fix: a story vanishing entirely from stories[] is restored from the pre-step snapshot instead of aborting', () => {
    const before = { stories: [{ id: 'SKY-002' }, { id: 'SKY-003' }, { id: 'SKY-004' }] };
    const after = { stories: [{ id: 'SKY-002' }, { id: 'SKY-004' }] }; // SKY-003 vanished
    const { exitCode, stdout } = run(before, after, 'Step 0.9: PRD model coordinator');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/STORY-ID-LOSS after Step 0\.9: PRD model coordinator/);
    expect(stdout).toMatch(/restored: SKY-003/);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('the restored story is spliced back into prd.stories[] with its original content intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'story-id-loss-restore-content-'));
    const prdPath = join(dir, 'prd.json');
    const snapshotDir = join(dir, 'snapshots');
    const before = { stories: [{ id: 'SKY-002' }, { id: 'SKY-003', agentRole: 'backend-engineer', technicalNotes: { files: ['src/x.ts'] } }, { id: 'SKY-004' }] };
    writeFileSync(prdPath, JSON.stringify(before));
    const captureBlock = extractFunctionByLineAnchor('capture_story_ids_snapshot');
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_lost');
    const script = [
      'error() { echo "ERROR: $*"; }',
      'warning() { echo "WARN: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      captureBlock,
      assertBlock,
      'capture_story_ids_snapshot "presplit"',
      `cat > ${JSON.stringify(prdPath)} << 'PRDEOF'`,
      JSON.stringify({ stories: [{ id: 'SKY-002' }, { id: 'SKY-004' }] }),
      'PRDEOF',
      'assert_no_story_ids_lost "presplit" "Step 0.5: Skill assessment"',
    ].join('\n');
    execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    const restored = JSON.parse(readFileSync(prdPath, 'utf8'));
    const sky003 = restored.stories.find((s: any) => s.id === 'SKY-003');
    expect(sky003.agentRole).toBe('backend-engineer');
    expect(sky003.technicalNotes.files).toEqual(['src/x.ts']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to a hard failure when a story is missing AND has no full-object snapshot to restore from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'story-id-loss-no-restore-'));
    const prdPath = join(dir, 'prd.json');
    const snapshotDir = join(dir, 'snapshots');
    writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-002' }, { id: 'SKY-003' }] }));
    const captureBlock = extractFunctionByLineAnchor('capture_story_ids_snapshot');
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_lost');
    const script = [
      'error() { echo "ERROR: $*"; }',
      'warning() { echo "WARN: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      captureBlock,
      assertBlock,
      'capture_story_ids_snapshot "presplit"',
      // Simulate a corrupted/unavailable full-object snapshot (e.g. an
      // interrupted capture) — the ID list still exists, so the assertion
      // still runs, but there's nothing to restore SKY-003 from.
      ': > "$STORY_ID_SNAPSHOT_DIR/stories-presplit.json"',
      `cat > ${JSON.stringify(prdPath)} << 'PRDEOF'`,
      JSON.stringify({ stories: [{ id: 'SKY-002' }] }),
      'PRDEOF',
      'assert_no_story_ids_lost "presplit" "Step 0.5: Skill assessment"',
      'echo ASSERT_PASSED',
    ].join('\n');
    try {
      execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      expect.fail('expected a non-zero exit');
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const out = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      expect(out).toMatch(/STORY-ID-LOSS INVARIANT VIOLATED after Step 0\.5: Skill assessment/);
      expect(out).toMatch(/- SKY-003/);
      expect(out).not.toMatch(/ASSERT_PASSED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT trip when a legitimate split ADDS new story IDs', () => {
    const before = { stories: [{ id: 'SKY-002' }] };
    const after = { stories: [{ id: 'SKY-002' }, { id: 'SKY-002-impl' }, { id: 'SKY-002-test' }] };
    const { exitCode, stdout } = run(before, after, 'Step 0.5: Skill assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('does NOT trip when a story is only marked deprecated (legitimate archival, record stays in the array)', () => {
    const before = { stories: [{ id: 'SKY-001', status: 'pending' }] };
    const after = { stories: [{ id: 'SKY-001', status: 'deprecated', completed: true }] };
    const { exitCode, stdout } = run(before, after, 'Step 3.5: Post-parallel assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('restores MULTIPLE missing IDs when more than one story vanishes', () => {
    const before = { stories: [{ id: 'SKY-002' }, { id: 'SKY-003' }, { id: 'SKY-004' }] };
    const after = { stories: [{ id: 'SKY-002' }] };
    const { exitCode, stdout } = run(before, after, 'Step 6: Final post-phase assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/restored: SKY-003/);
    expect(stdout).toMatch(/restored: SKY-004/);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('is a no-op (returns success) when no snapshot has been captured yet for that label', () => {
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_lost');
    const dir = mkdtempSync(join(tmpdir(), 'story-id-loss-no-snapshot-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-001' }] }));
    const script = [
      'error() { echo "ERROR: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(join(dir, 'snapshots'))}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      assertBlock,
      'assert_no_story_ids_lost "nonexistent-label" "some step"',
      'echo NO_SNAPSHOT_OK',
    ].join('\n');
    const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(stdout).toMatch(/NO_SNAPSHOT_OK/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('assertNoStoryIdsLost (spec-mode-runner.js) — JS-side mirror of the bash helper', () => {
  it('REPRODUCES the exact live defect and proves the fix: throws naming the exact missing ID(s)', () => {
    const before = new Set(['SKY-002', 'SKY-003', 'SKY-004']);
    const after = new Set(['SKY-002', 'SKY-004']);
    expect(() => assertNoStoryIdsLost(before, after, 'run()')).toThrow(
      /STORY-ID-LOSS INVARIANT VIOLATED.*during run\(\): SKY-003/
    );
  });

  it('does not throw when the set only grows (legitimate split)', () => {
    const before = new Set(['SKY-002']);
    const after = new Set(['SKY-002', 'SKY-002-impl', 'SKY-002-test']);
    expect(() => assertNoStoryIdsLost(before, after, 'run()')).not.toThrow();
  });

  it('does not throw when the set is unchanged', () => {
    const ids = new Set(['SKY-001', 'SKY-002']);
    expect(() => assertNoStoryIdsLost(ids, new Set(ids), 'validateMidExecutionSplits()')).not.toThrow();
  });

  it('run() calls assertNoStoryIdsLost right before its final atomic write (writeFileSync + renameSync)', () => {
    // Anchor moved (2026-07-11): the PRD write is now atomic — write to a
    // temp file, then fs.renameSync into place — instead of a bare
    // fs.writeFileSync(prdPath, ...) directly on the target (see
    // atomic-json-writes.test.ts for why).
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('const _tmpPrdPath = `${prdPath}.tmp`;');
    expect(idx).toBeGreaterThan(-1);
    const block = SPEC_MODE_RUNNER_SRC.slice(idx - 700, idx);
    expect(block).toMatch(/assertNoStoryIdsLost\(_initialStoryIds,.*'run\(\)'\)/);
    const afterBlock = SPEC_MODE_RUNNER_SRC.slice(idx, idx + 300);
    expect(afterBlock).toMatch(/fs\.renameSync\(_tmpPrdPath, prdPath\)/);
  });

  it('validateMidExecutionSplits() calls assertNoStoryIdsLost right before its final atomic write (writeFileSync + renameSync)', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('const _tmpPrdFile = `${prdFile}.tmp`;');
    expect(idx).toBeGreaterThan(-1);
    const block = SPEC_MODE_RUNNER_SRC.slice(idx - 500, idx);
    expect(block).toMatch(/assertNoStoryIdsLost\(_initialStoryIds,.*'validateMidExecutionSplits\(\)'\)/);
    const afterBlock = SPEC_MODE_RUNNER_SRC.slice(idx, idx + 300);
    expect(afterBlock).toMatch(/fs\.renameSync\(_tmpPrdFile, prdFile\)/);
  });
});
