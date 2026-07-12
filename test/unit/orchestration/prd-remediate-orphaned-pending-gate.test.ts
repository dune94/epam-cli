/**
 * Deterministic gate: no pending story may be orphaned from every
 * implementationOrder phase.
 *
 * Root cause this catches (found live, 2026-07-08/09, tier3-travel-app run):
 * Step 0.9's prd-model-coordinator has tool write access and processes ALL
 * pending stories PRD-wide (not scoped to the phase currently running); its
 * own reviewer gate only diffs the LAST 1000 CHARACTERS of before/after PRD
 * content — for any real multi-KB PRD, that reviewer is structurally blind to
 * a rewrite corrupting a story earlier in stories[]. That corruption silently
 * stripped technicalNotes.files from SKY-002/003/004 during the scaffold
 * phase; _prd_remediate_impl.py's step 2 ("remove no-files stories from
 * implementationOrder") then — correctly per its own logic, but disastrously
 * here — dropped those now-fileless stories from implementationOrder.core.
 * The 'core' phase then silently ran as a no-op ("phase core has no stories;
 * skipping") with ZERO error: no crash, no failed exit code, nothing — the
 * defect was completely invisible until the PRD was manually inspected.
 *
 * Fix: _prd_remediate_impl.py now hard-fails (exit 1, clear diagnostic) if
 * ANY pending, non-completed story ends up absent from every
 * implementationOrder[phase] array after remediation — regardless of WHICH
 * step caused the orphaning, and regardless of whether the CURRENT phase
 * looks "canonical" (this check runs unconditionally, not gated behind
 * prd-remediate.sh's is_canonical fast path, since the exact failure scenario
 * above looked canonical from core's own perspective).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const IMPL_PY = join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');

function runRemediate(prd: object, phase?: string): { exitCode: number; stdout: string; stderr: string; prdAfter: any } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-orphan-gate-'));
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  try {
    const args = phase ? [IMPL_PY, prdPath, phase] : [IMPL_PY, prdPath];
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('python3', args, { encoding: 'utf8' });
    } catch (e: any) {
      exitCode = e.status ?? -1;
      stdout = (e.stdout ?? '').toString();
      stderr = (e.stderr ?? '').toString();
    }
    let prdAfter: any = null;
    try {
      prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
    } catch {
      /* file may be unchanged/original if the script aborted before writing */
    }
    return { exitCode, stdout, stderr, prdAfter };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('_prd_remediate_impl.py — orphaned-pending-story gate (static)', () => {
  const src = readFileSync(IMPL_PY, 'utf8');

  it('checks every story against the union of all implementationOrder phase arrays', () => {
    expect(src).toMatch(/all_active_ids = set\(sid for ids in impl_order\.values\(\) for sid in ids\)/);
  });

  it('flags a pending, non-completed story missing from all_active_ids as FATAL', () => {
    const idx = src.indexOf('orphaned_pending = []');
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/s\.get\('status'\) == 'pending'/);
    expect(block).toMatch(/not s\.get\('completed'\)/);
    expect(block).toMatch(/sys\.exit\(1\)/);
  });

  it('the gate is not conditioned on any canonical/pre-spec-pass check — it runs for every remediation call', () => {
    const idx = src.indexOf('orphaned_pending = []');
    const block = src.slice(Math.max(0, idx - 100), idx);
    expect(block).not.toMatch(/if\s+.*canonical/i);
  });
});

describe('_prd_remediate_impl.py — REAL execution, reproduces the exact live bug and proves the gate catches it', () => {
  it('REPRODUCES the exact live defect: SKY-002/003/004 stripped of technicalNotes.files, orphaned from implementationOrder.core, phase would silently no-op — now hard-fails instead', () => {
    const prd = {
      implementationOrder: {
        scaffold: ['SKY-001-impl', 'SKY-001-test'],
        core: [], // already emptied by step 2's no-files removal, matching the live symptom
      },
      stories: [
        { id: 'SKY-001-impl', status: 'completed', completed: true, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-001-test', status: 'completed', completed: true, technicalNotes: { files: ['src/index.test.ts'] } },
        // Corrupted exactly as observed live: technicalNotes present but .files stripped
        { id: 'SKY-002', status: 'pending', completed: false, technicalNotes: { workingDir: '/tmp/x' } },
        { id: 'SKY-003', status: 'pending', completed: false, technicalNotes: { workingDir: '/tmp/x' } },
        { id: 'SKY-004', status: 'pending', completed: false, technicalNotes: { workingDir: '/tmp/x' } },
      ],
    };

    const { exitCode, stderr } = runRemediate(prd, 'core');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/FATAL/);
    expect(stderr).toMatch(/SKY-002/);
    expect(stderr).toMatch(/SKY-003/);
    expect(stderr).toMatch(/SKY-004/);
  });

  it('does NOT fire for a healthy PRD where every pending story is present in some implementationOrder phase', () => {
    const prd = {
      implementationOrder: {
        scaffold: ['SKY-001-impl', 'SKY-001-test'],
        core: ['SKY-002', 'SKY-003', 'SKY-004'],
      },
      stories: [
        { id: 'SKY-001-impl', status: 'completed', completed: true, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-001-test', status: 'completed', completed: true, technicalNotes: { files: ['src/index.test.ts'] } },
        { id: 'SKY-002', status: 'pending', completed: false, technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', status: 'pending', completed: false, technicalNotes: { files: ['src/cli.ts'] } },
        { id: 'SKY-004', status: 'pending', completed: false, technicalNotes: { files: ['src/server.ts'] } },
      ],
    };

    const { exitCode, prdAfter } = runRemediate(prd, 'core');

    expect(exitCode).toBe(0);
    expect(prdAfter.implementationOrder.core).toEqual(['SKY-002', 'SKY-003', 'SKY-004']);
  });

  it('does NOT fire for a genuinely deprecated/completed story missing from implementationOrder (expected, not a bug)', () => {
    const prd = {
      implementationOrder: {
        scaffold: ['SKY-001-impl', 'SKY-001-test'],
        core: ['SKY-002-impl', 'SKY-002-test'],
      },
      stories: [
        { id: 'SKY-001-impl', status: 'completed', completed: true, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-001-test', status: 'completed', completed: true, technicalNotes: { files: ['src/index.test.ts'] } },
        // SKY-002 was split and correctly deprecated — its own absence from
        // implementationOrder is expected, not corruption, since its real
        // work lives in the child IDs which ARE present.
        { id: 'SKY-002', status: 'deprecated', completed: false, technicalNotes: {} },
        { id: 'SKY-002-impl', status: 'pending', completed: false, technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002-test', status: 'pending', completed: false, technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
      ],
    };

    const { exitCode } = runRemediate(prd, 'core');
    expect(exitCode).toBe(0);
  });

  it('catches the orphan even when the phase argument is omitted (fresh-run full reset path)', () => {
    const prd = {
      implementationOrder: {
        scaffold: ['SKY-001-impl'],
        core: [],
      },
      stories: [
        { id: 'SKY-001-impl', status: 'pending', completed: false, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', completed: false, technicalNotes: {} },
      ],
    };

    const { exitCode, stderr } = runRemediate(prd);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/FATAL/);
    expect(stderr).toMatch(/SKY-002/);
  });
});
