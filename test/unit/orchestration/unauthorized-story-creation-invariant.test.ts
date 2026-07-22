/**
 * assert_no_story_ids_gained — deterministic invariant against a
 * tool-write-access agent fabricating brand-new top-level stories.
 *
 * Root cause this guards against (found live, 2026-07-10, tier3-travel-app
 * run): 6 entirely fabricated stories (SKY-005 through SKY-010 — an HTML
 * dashboard story, three "comprehensive test suite" stories, a code-review/
 * security-audit story, a mutation-testing story) appeared in prd.stories[]
 * between the Step 0.1 CPA snapshot and the end of Step 0.5 — the only two
 * steps that ran in that window. Step 0.5's own prompt explicitly says
 * "NEVER rewrite the PRD file with a different story structure. You may only
 * update agentRole fields and append to profiles.json" — its own text
 * summary claimed exactly that (agentRole updates + profile enhancements
 * only), but the actual PRD content contradicted its own summary. One
 * fabricated story even carried a `specification` block mimicking real
 * spec-pass output (same shape, same shared run ID) — spec-pass's own
 * authoritative summary.json for that exact run ID showed it only ever
 * touched SKY-001. No deterministic guardrail existed to catch an agent
 * adding stories nobody asked for.
 *
 * This does not fix the root cause (which agent turn is doing this, or why)
 * — it makes the NEXT occurrence hard-fail immediately with the exact
 * fabricated ID(s) and the step that just ran, instead of silently letting
 * the fabricated stories flow into later phases.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

describe('assert_no_story_ids_gained — wiring (static)', () => {
  it('is defined right after assert_no_story_ids_lost', () => {
    expect(orchSrc).toMatch(/assert_no_story_ids_gained\(\) \{/);
    const lostIdx = orchSrc.indexOf('assert_no_story_ids_lost() {');
    const gainedIdx = orchSrc.indexOf('assert_no_story_ids_gained() {');
    expect(gainedIdx).toBeGreaterThan(lostIdx);
  });

  // Steps 0.5 and 0.9 run BEFORE the parallel Step 1 loop — "presplit" snapshot
  // is current for them. Steps 3.5 and 6 run AFTER the loop (after TC-writer-gate
  // splits may have added new child stories) — use "post-parallel" so those
  // legitimately-added split children don't trip a false-positive.
  const GAINED_LABEL: Record<string, string> = {
    'Step 3: Skill assessment':        'presplit',
    'Step 7: PRD model coordinator':   'presplit',
    'Step 18: Post-parallel assessment':'post-parallel',
    'Step 24: Final post-phase assessment':'post-parallel',
  };
  for (const [step, label] of Object.entries(GAINED_LABEL)) {
    it(`is called alongside assert_no_story_ids_lost for ${step} (gained-label: "${label}")`, () => {
      const idx = orchSrc.indexOf(`assert_no_story_ids_lost "presplit" "${step}"`);
      expect(idx).toBeGreaterThan(-1);
      const block = orchSrc.slice(idx, idx + 200);
      expect(block).toMatch(new RegExp(`assert_no_story_ids_gained "${label}" "${step.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"`));
    });
  }

  it('post-parallel snapshot is captured immediately before Step 3.5 (after all Step 1 splits)', () => {
    // The capture must come AFTER the parallel loop closes and BEFORE the
    // Step 3.5 if-block, so split children created during Step 1 are already
    // present when we snapshot.
    const captureIdx = orchSrc.lastIndexOf('capture_story_ids_snapshot "post-parallel"');
    const step35Idx  = orchSrc.indexOf('assert_no_story_ids_gained "post-parallel" "Step 18');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(step35Idx).toBeGreaterThan(captureIdx);
  });
});

describe('assert_no_story_ids_gained — REAL execution', () => {
  function run(before: object, after: object, stepName: string): { exitCode: number; stdout: string } {
    const captureBlock = extractFunctionByLineAnchor('capture_story_ids_snapshot');
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_gained');
    const dir = mkdtempSync(join(tmpdir(), 'unauthorized-story-creation-'));
    const prdPath = join(dir, 'prd.json');
    const snapshotDir = join(dir, 'snapshots');
    writeFileSync(prdPath, JSON.stringify(before));

    const script = [
      'error() { echo "ERROR: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      captureBlock,
      assertBlock,
      'capture_story_ids_snapshot "presplit"',
      `cat > ${JSON.stringify(prdPath)} << 'PRDEOF'`,
      JSON.stringify(after),
      'PRDEOF',
      `assert_no_story_ids_gained "presplit" ${JSON.stringify(stepName)}`,
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

  it('REPRODUCES the exact live defect and proves the fix: fabricated stories appearing after Step 0.5 are caught with their exact IDs', () => {
    const before = { stories: [{ id: 'SKY-001' }, { id: 'SKY-001-impl' }, { id: 'SKY-001-test' }] };
    const after = {
      stories: [
        { id: 'SKY-001' }, { id: 'SKY-001-impl' }, { id: 'SKY-001-test' },
        { id: 'SKY-005' }, { id: 'SKY-006' }, { id: 'SKY-007' },
        { id: 'SKY-008' }, { id: 'SKY-009' }, { id: 'SKY-010' },
      ],
    };
    const { exitCode, stdout } = run(before, after, 'Step 3: Skill assessment');
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/UNAUTHORIZED STORY CREATION after Step 3: Skill assessment/);
    expect(stdout).toMatch(/- SKY-005/);
    expect(stdout).toMatch(/- SKY-010/);
    expect(stdout).not.toMatch(/ASSERT_PASSED/);
  });

  it('does NOT trip when the story set is unchanged', () => {
    const stories = { stories: [{ id: 'SKY-001' }, { id: 'SKY-002' }] };
    const { exitCode, stdout } = run(stories, stories, 'Step 7: PRD model coordinator');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('does NOT trip when stories are only removed (shrinkage is assert_no_story_ids_lost\'s job, not this one\'s)', () => {
    const before = { stories: [{ id: 'SKY-001' }, { id: 'SKY-002' }] };
    const after = { stories: [{ id: 'SKY-001' }] };
    const { exitCode, stdout } = run(before, after, 'Step 18: Post-parallel assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('is a no-op when no snapshot has been captured yet', () => {
    const assertBlock = extractFunctionByLineAnchor('assert_no_story_ids_gained');
    const dir = mkdtempSync(join(tmpdir(), 'unauthorized-story-creation-nosnap-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-001' }] }));
    const script = [
      'error() { echo "ERROR: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(join(dir, 'snapshots'))}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      assertBlock,
      'assert_no_story_ids_gained "nonexistent-label" "some step"',
      'echo NO_SNAPSHOT_OK',
    ].join('\n');
    const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(stdout).toMatch(/NO_SNAPSHOT_OK/);
    rmSync(dir, { recursive: true, force: true });
  });
});
