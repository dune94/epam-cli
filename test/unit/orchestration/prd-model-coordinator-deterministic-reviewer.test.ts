/**
 * prd-model-coordinator's reviewer gate — deterministic full-file diff,
 * REAL execution tests.
 *
 * Root cause this fixes (found live, 2026-07-08/09, tier3-travel-app run):
 * the reviewer gate for model_assignment changes used to be an LLM call fed
 * only the LAST 1000 CHARACTERS of the before/after PRD as a text excerpt.
 * For any real multi-KB PRD, that is structurally blind to a change
 * anywhere earlier in the file — the coordinator (which has tool write
 * access) silently stripped technicalNotes.files from SKY-002/003/004
 * (stories nowhere near the tail of the file) and the excerpt-based
 * reviewer approved it, seeing nothing.
 *
 * Fix: "only model/aiProvider/reasoningEffort may change" is a mechanically
 * checkable invariant, not a judgment call — replaced the LLM call with a
 * deterministic Python diff comparing EVERY story, by ID, field-by-field,
 * plus checks for added/removed stories and implementationOrder changes.
 * These tests extract that exact embedded Python block and run it for real
 * against synthetic before/after PRD fixtures.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH_SH, 'utf8');

function extractReviewerPython(): string {
  const startMarker = "python3 - \"$_mc_before_file\" \"$_mc_after_file\" << 'MC_REVIEW_PY'";
  const startIdx = src.indexOf(startMarker) + startMarker.length;
  const endIdx = src.indexOf('\nMC_REVIEW_PY', startIdx);
  if (startIdx <= startMarker.length - 1 || endIdx === -1) {
    throw new Error('Could not extract the reviewer Python block — did the marker text change?');
  }
  return src.slice(startIdx, endIdx);
}

function runReviewer(before: object, after: object): { verdict: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mc-reviewer-test-'));
  const beforePath = join(dir, 'before.json');
  const afterPath = join(dir, 'after.json');
  writeFileSync(beforePath, JSON.stringify(before));
  writeFileSync(afterPath, JSON.stringify(after));
  try {
    const script = extractReviewerPython();
    // spawnSync (not execFileSync) — the real script always exits 0 and
    // communicates its verdict via stdout text, never a nonzero exit code,
    // so execFileSync's throw-on-nonzero-exit path never fires and its
    // stderr is only ever captured from that (never-taken) catch branch.
    const result = spawnSync('python3', ['-c', script, beforePath, afterPath], { encoding: 'utf8' });
    return { verdict: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('prd-model-coordinator reviewer — REAL execution, deterministic diff', () => {
  it('REPRODUCES the exact live bug scenario and proves the fix catches it: technicalNotes.files stripped from an unrelated story', () => {
    const before = {
      implementationOrder: { scaffold: ['SKY-001'], core: ['SKY-002', 'SKY-003'] },
      stories: [
        { id: 'SKY-001', status: 'pending', model: null, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
      ],
    };
    // Coordinator assigns model/aiProvider/reasoningEffort to SKY-001 (fine)
    // but ALSO — the exact live corruption — silently strips
    // technicalNotes.files from an unrelated story, SKY-002, nowhere near
    // whatever the coordinator was actually asked to touch.
    const after = {
      implementationOrder: { scaffold: ['SKY-001'], core: ['SKY-002', 'SKY-003'] },
      stories: [
        { id: 'SKY-001', status: 'pending', model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'low', technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', technicalNotes: { workingDir: '/tmp/x' } }, // files silently stripped
        { id: 'SKY-003', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
      ],
    };

    const result = runReviewer(before, after);
    expect(result.verdict).toBe('fail');
    expect(result.stderr).toMatch(/SKY-002\.technicalNotes changed/);
  });

  it('PASSES a legitimate model-assignment write touching only the allowed fields', () => {
    const before = {
      implementationOrder: { scaffold: ['SKY-001'] },
      stories: [
        { id: 'SKY-001', status: 'pending', technicalNotes: { files: ['src/index.ts'] } },
      ],
    };
    const after = {
      implementationOrder: { scaffold: ['SKY-001'] },
      stories: [
        { id: 'SKY-001', status: 'pending', model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'low', technicalNotes: { files: ['src/index.ts'] } },
      ],
    };

    const result = runReviewer(before, after);
    expect(result.verdict).toBe('pass');
  });

  it('FAILS when a story is silently removed from stories[]', () => {
    const before = {
      implementationOrder: { scaffold: ['SKY-001', 'SKY-002'] },
      stories: [
        { id: 'SKY-001', status: 'pending', technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
      ],
    };
    const after = {
      implementationOrder: { scaffold: ['SKY-001', 'SKY-002'] },
      stories: [
        { id: 'SKY-001', status: 'pending', model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'low', technicalNotes: { files: ['src/index.ts'] } },
      ],
    };

    const result = runReviewer(before, after);
    expect(result.verdict).toBe('fail');
    expect(result.stderr).toMatch(/stories removed:.*SKY-002/);
  });

  it('FAILS when implementationOrder itself is modified', () => {
    const before = {
      implementationOrder: { scaffold: ['SKY-001'], core: ['SKY-002', 'SKY-003'] },
      stories: [
        { id: 'SKY-001', status: 'pending', technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
      ],
    };
    const after = {
      implementationOrder: { scaffold: ['SKY-001'], core: ['SKY-002'] }, // SKY-003 silently dropped
      stories: [
        { id: 'SKY-001', status: 'pending', model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'low', technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
      ],
    };

    const result = runReviewer(before, after);
    expect(result.verdict).toBe('fail');
    expect(result.stderr).toMatch(/implementationOrder was modified/);
  });

  it('FAILS when a story\'s acceptanceCriteria or effort field is touched (not just technicalNotes)', () => {
    const before = {
      implementationOrder: { scaffold: ['SKY-001'] },
      stories: [
        { id: 'SKY-001', status: 'pending', effort: 'medium', acceptanceCriteria: ['a', 'b'] },
      ],
    };
    const after = {
      implementationOrder: { scaffold: ['SKY-001'] },
      stories: [
        { id: 'SKY-001', status: 'pending', effort: 'high', acceptanceCriteria: ['a', 'b'], model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'low' },
      ],
    };

    const result = runReviewer(before, after);
    expect(result.verdict).toBe('fail');
    expect(result.stderr).toMatch(/SKY-001\.effort changed/);
  });

  it('FAILS with a clear diagnostic when the "after" file is not valid JSON (write got corrupted/truncated)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-reviewer-badjson-'));
    const beforePath = join(dir, 'before.json');
    const afterPath = join(dir, 'after.json');
    writeFileSync(beforePath, JSON.stringify({ stories: [] }));
    writeFileSync(afterPath, '{"stories": [}{"stories": []}'); // malformed / concatenated
    try {
      const script = extractReviewerPython();
      const result = spawnSync('python3', ['-c', script, beforePath, afterPath], { encoding: 'utf8' });
      expect((result.stdout ?? '').trim()).toBe('fail');
      expect(result.stderr ?? '').toMatch(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
