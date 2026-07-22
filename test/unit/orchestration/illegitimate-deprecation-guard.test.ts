/**
 * assert_no_illegitimate_deprecation — closes a gap assert_no_story_ids_lost/
 * gained don't cover: a story whose ID survives (so ID-loss doesn't fire) but
 * whose `status` field gets silently flipped to "deprecated" by one of the
 * unrestricted-tool-write steps (Step 0.5, Step 0.9).
 *
 * Root cause this guards against (found live, 2026-07-12, tier3-travel-app
 * run): SKY-001 was legitimately split into SKY-001-impl/SKY-001-test by
 * Step 0 (spec-pass), both created with status="pending" — the correct,
 * executable state captured in the "presplit" snapshot. By the time Step 1
 * reached them, both had status="deprecated" (the signature applySpecChanges
 * writes onto a PARENT once ITS OWN split succeeds), even though neither was
 * ever a parent of a further split — no grandchild story IDs exist anywhere
 * in the PRD, and the mid-execution split-gate logged "No unvalidated
 * mid-execution splits" for this phase, so nothing legitimate deprecated
 * them. The only steps with PRD write access in that window (Step 0.5,
 * Step 0.9) are each explicitly instructed to touch only narrow fields —
 * same class of prompt-vs-actual-write mismatch already documented for
 * assert_no_story_ids_gained. Net effect: the two stories that were supposed
 * to actually write package.json/tsconfig.json/etc. were silently skipped
 * all run, and the phase "completed" having done zero real scaffolding work.
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

describe('assert_no_illegitimate_deprecation — wiring (static)', () => {
  it('is defined', () => {
    expect(orchSrc).toMatch(/assert_no_illegitimate_deprecation\(\) \{/);
  });

  it('is called after Step 0.5 (pre-phase skill assessment), alongside the ID-loss/gain checks', () => {
    const idx = orchSrc.indexOf('run_pre_phase_assessment "$PHASE"');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 3/);
    expect(block).toMatch(/assert_no_illegitimate_deprecation "presplit" "Step 3/);
  });

  it('is called after Step 0.9 (PRD model coordinator), alongside the ID-loss/gain checks', () => {
    const idx = orchSrc.indexOf('step_emit "7" "pass" "Step 7: PRD model coordinator"');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/assert_no_story_ids_lost "presplit" "Step 7/);
    expect(block).toMatch(/assert_no_illegitimate_deprecation "presplit" "Step 7/);
  });
});

describe('assert_no_illegitimate_deprecation — REAL execution', () => {
  function run(prdBefore: object, prdAfter: object, stepName: string): { exitCode: number; stdout: string; prd: any } {
    const captureBlock = extractFunctionByLineAnchor('capture_story_ids_snapshot');
    const assertBlock = extractFunctionByLineAnchor('assert_no_illegitimate_deprecation');
    const dir = mkdtempSync(join(tmpdir(), 'illegitimate-deprecation-'));
    const prdPath = join(dir, 'prd.json');
    const snapshotDir = join(dir, 'snapshots');
    writeFileSync(prdPath, JSON.stringify(prdBefore));

    const script = [
      'error() { echo "ERROR: $*"; exit 1; }',
      'warning() { echo "WARN: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      captureBlock,
      assertBlock,
      'capture_story_ids_snapshot "presplit"',
      `cat > ${JSON.stringify(prdPath)} << 'PRDEOF'`,
      JSON.stringify(prdAfter),
      'PRDEOF',
      `assert_no_illegitimate_deprecation "presplit" ${JSON.stringify(stepName)}`,
      'echo ASSERT_PASSED',
    ].join('\n');

    try {
      const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      return { exitCode: 0, stdout, prd: JSON.parse(readFileSync(prdPath, 'utf8')) };
    } catch (e: any) {
      return {
        exitCode: e.status ?? -1,
        stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString(),
        prd: JSON.parse(readFileSync(prdPath, 'utf8')),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: split children silently flipped pending->deprecated are restored to pending', () => {
    const before = {
      stories: [
        { id: 'SKY-001', status: 'deprecated', completed: true },
        { id: 'SKY-001-impl', status: 'pending', agentRole: 'typescript-engineer' },
        { id: 'SKY-001-test', status: 'pending', agentRole: 'test-engineer' },
      ],
    };
    // Simulates the corruption: an untrusted tool-write step flips both
    // children to deprecated+completed, matching the exact signature a
    // legitimate parent-delegation write would leave — but on the wrong
    // stories, with no grandchildren ever created.
    const after = {
      stories: [
        { id: 'SKY-001', status: 'deprecated', completed: true },
        { id: 'SKY-001-impl', status: 'deprecated', completed: true, agentRole: 'typescript-engineer' },
        { id: 'SKY-001-test', status: 'deprecated', completed: true, agentRole: 'test-engineer' },
      ],
    };
    const { exitCode, stdout, prd } = run(before, after, 'Step 0.5: Skill assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/STATUS-CORRUPTION after Step 0\.5: Skill assessment/);
    expect(stdout).toMatch(/restored: SKY-001-impl/);
    expect(stdout).toMatch(/restored: SKY-001-test/);
    expect(stdout).toMatch(/ASSERT_PASSED/);

    const impl = prd.stories.find((s: any) => s.id === 'SKY-001-impl');
    const test = prd.stories.find((s: any) => s.id === 'SKY-001-test');
    expect(impl.status).toBe('pending');
    expect(test.status).toBe('pending');
    // Fields unaffected by the corruption (agentRole) must survive the restore.
    expect(impl.agentRole).toBe('typescript-engineer');
  });

  it('does NOT flag a story that was ALREADY deprecated at snapshot time (legitimate parent-delegation, unchanged)', () => {
    const before = { stories: [{ id: 'SKY-001', status: 'deprecated', completed: true }] };
    const after = { stories: [{ id: 'SKY-001', status: 'deprecated', completed: true }] };
    const { exitCode, stdout } = run(before, after, 'Step 0.9: PRD model coordinator');
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/STATUS-CORRUPTION/);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('does NOT flag a pending story that stays pending (no-op steps)', () => {
    const before = { stories: [{ id: 'SKY-002', status: 'pending' }] };
    const after = { stories: [{ id: 'SKY-002', status: 'pending', model: 'MiniMax-M3' }] };
    const { exitCode, stdout } = run(before, after, 'Step 0.9: PRD model coordinator');
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/STATUS-CORRUPTION/);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('does NOT flag a story that vanished entirely (that is assert_no_story_ids_lost\'s job, not this guard\'s)', () => {
    const before = { stories: [{ id: 'SKY-002', status: 'pending' }, { id: 'SKY-003', status: 'pending' }] };
    const after = { stories: [{ id: 'SKY-002', status: 'pending' }] };
    const { exitCode, stdout } = run(before, after, 'Step 0.5: Skill assessment');
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/STATUS-CORRUPTION/);
    expect(stdout).toMatch(/ASSERT_PASSED/);
  });

  it('is a no-op when no snapshot has been captured yet for that label', () => {
    const assertBlock = extractFunctionByLineAnchor('assert_no_illegitimate_deprecation');
    const dir = mkdtempSync(join(tmpdir(), 'illegitimate-deprecation-no-snapshot-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-001', status: 'deprecated' }] }));
    const script = [
      'error() { echo "ERROR: $*"; exit 1; }',
      'warning() { echo "WARN: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `STORY_ID_SNAPSHOT_DIR=${JSON.stringify(join(dir, 'snapshots'))}`,
      'mkdir -p "$STORY_ID_SNAPSHOT_DIR"',
      assertBlock,
      'assert_no_illegitimate_deprecation "nonexistent-label" "some step"',
      'echo NO_SNAPSHOT_OK',
    ].join('\n');
    const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(stdout).toMatch(/NO_SNAPSHOT_OK/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores multiple flipped stories in one pass', () => {
    const before = {
      stories: [
        { id: 'SKY-002', status: 'pending' },
        { id: 'SKY-003', status: 'pending' },
        { id: 'SKY-004', status: 'pending' },
      ],
    };
    const after = {
      stories: [
        { id: 'SKY-002', status: 'deprecated' },
        { id: 'SKY-003', status: 'pending' },
        { id: 'SKY-004', status: 'deprecated' },
      ],
    };
    const { exitCode, stdout, prd } = run(before, after, 'Step 0.5: Skill assessment');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/restored: SKY-002/);
    expect(stdout).toMatch(/restored: SKY-004/);
    expect(prd.stories.find((s: any) => s.id === 'SKY-002').status).toBe('pending');
    expect(prd.stories.find((s: any) => s.id === 'SKY-003').status).toBe('pending');
    expect(prd.stories.find((s: any) => s.id === 'SKY-004').status).toBe('pending');
  });
});
