/**
 * Root cause of a live-run defect (run #13, 2026-07-03): SKY-001 (scaffold phase)
 * completed and was merged to master, but after the 'core' phase's pre-phase
 * remediation ran, the PRD showed SKY-001 back at status="pending". tier3-travel-
 * app-run.sh's run_phase() calls prd-remediate.sh --prd "$PRD_FILE" before EVERY
 * phase transition within a single pipeline run (not just at the start of a fresh
 * run) — and _prd_remediate_impl.py's step 6 ("reset active story status to
 * pending") built its story set from ALL phases in implementationOrder, not just
 * the phase about to run. So remediating before 'core' silently wiped out
 * 'scaffold' phase's already-completed, already-merged status.
 *
 * Fix: _prd_remediate_impl.py now accepts an optional phase argument
 * (sys.argv[2]) and, when given, scopes the status-reset step to only that
 * phase's stories — leaving other phases' story status untouched. prd-
 * remediate.sh forwards a new --phase flag, and tier3-travel-app-run.sh passes
 * --phase "$phase" from inside run_phase() (both the initial call and the gate-
 * remediation retry call). The very first pre-run remediation call (before Step
 * 0, resetting everything for a genuinely fresh run) intentionally omits --phase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const IMPL_PY = join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');
const REMEDIATE_SH = join(REPO_ROOT, 'orchestrations/scripts/prd-remediate.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');

function fixture() {
  return {
    implementationOrder: {
      scaffold: ['SKY-001'],
      core: ['SKY-002', 'SKY-003', 'SKY-004'],
    },
    stories: [
      { id: 'SKY-001', status: 'completed', completed: true, technicalNotes: { files: ['src/index.ts'] } },
      { id: 'SKY-002', status: 'completed', completed: true, technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'SKY-003', status: 'failed', completed: false, technicalNotes: { files: ['src/cli.ts'] } },
      { id: 'SKY-004', status: 'failed', completed: false, technicalNotes: { files: ['src/server.ts'] } },
    ],
  };
}

describe('_prd_remediate_impl.py — phase-scoped status reset (REAL execution)', () => {
  function runRemediate(phase?: string): Record<string, { status: string; completed: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-test-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(fixture()));
    try {
      const args = phase ? [IMPL_PY, prdPath, phase] : [IMPL_PY, prdPath];
      execFileSync('python3', args, { encoding: 'utf8' });
      const result = JSON.parse(readFileSync(prdPath, 'utf8'));
      const byId: Record<string, { status: string; completed: boolean }> = {};
      for (const s of result.stories) byId[s.id] = { status: s.status, completed: s.completed };
      return byId;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('with phase="core": SKY-001 (scaffold, already completed) is left untouched', () => {
    const result = runRemediate('core');
    expect(result['SKY-001']).toEqual({ status: 'completed', completed: true });
  });

  it('with phase="core": SKY-002/003/004 (core phase stories) ARE reset to pending', () => {
    const result = runRemediate('core');
    expect(result['SKY-002']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-003']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-004']).toEqual({ status: 'pending', completed: false });
  });

  it('with phase="scaffold": SKY-001 IS reset, core-phase stories are left untouched', () => {
    const result = runRemediate('scaffold');
    expect(result['SKY-001']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-002']).toEqual({ status: 'completed', completed: true });
    expect(result['SKY-003']).toEqual({ status: 'failed', completed: false });
  });

  it('without any phase argument (fresh-run full reset): every active story is reset', () => {
    const result = runRemediate(undefined);
    expect(result['SKY-001']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-002']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-003']).toEqual({ status: 'pending', completed: false });
    expect(result['SKY-004']).toEqual({ status: 'pending', completed: false });
  });
});

describe('prd-remediate.sh — forwards --phase to the Python implementation', () => {
  const src = readFileSync(REMEDIATE_SH, 'utf8');

  it('accepts a --phase flag', () => {
    expect(src).toMatch(/--phase\)\s*PHASE="\$2"/);
  });

  it('forwards PHASE to _prd_remediate_impl.py as an extra argument', () => {
    expect(src).toMatch(/_prd_remediate_impl\.py"\s+"\$PRD_FILE"\s+\$\{PHASE:\+"\$PHASE"\}/);
  });
});

describe('tier3-travel-app-run.sh — passes --phase to prd-remediate.sh from run_phase()', () => {
  const src = readFileSync(TIER3_SH, 'utf8');

  it('the initial pre-run remediation call (fresh-run reset) does NOT pass --phase', () => {
    const preflightIdx = src.indexOf('Pre-flight validation');
    const firstRemediateIdx = src.indexOf('prd-remediate.sh');
    expect(firstRemediateIdx).toBeGreaterThan(-1);
    expect(firstRemediateIdx).toBeLessThan(preflightIdx);
    const line = src.slice(src.lastIndexOf('\n', firstRemediateIdx), src.indexOf('\n', firstRemediateIdx));
    expect(line).not.toMatch(/--phase/);
  });

  it('run_phase()"s pre-phase remediation call passes --phase "$phase"', () => {
    const runPhaseIdx = src.indexOf('run_phase()');
    const bodyEnd = src.indexOf('\n}', runPhaseIdx);
    const body = src.slice(runPhaseIdx, bodyEnd);
    expect(body).toMatch(/prd-remediate\.sh"\s+--prd\s+"\$PRD_FILE"\s+--phase\s+"\$phase"/);
  });

  it('the self-healing retry remediation call inside run_phase() also passes --phase "$phase"', () => {
    const runPhaseIdx = src.indexOf('run_phase()');
    const bodyEnd = src.indexOf('\n}', runPhaseIdx);
    const body = src.slice(runPhaseIdx, bodyEnd);
    const occurrences = [...body.matchAll(/prd-remediate\.sh"\s+--prd\s+"\$PRD_FILE"\s+--phase\s+"\$phase"/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// ── is_canonical bypass scoping (found live, 2026-07-06, tier3-full-run-17) ──
// Root cause: the `has_splits` check underlying `_is_canonical` scanned ALL
// stories in the PRD, not just the phase being validated. The first time ANY
// phase (e.g. scaffold) ever produced a split, is_canonical became false for
// EVERY later phase too — including core, whose own stories (SKY-002/003/004)
// hadn't been spec-elaborated yet and correctly had no testCriteria/
// ui_and_review at that point. Core's preflight then ran the FULL strict
// checks against its own genuinely-pre-spec-pass stories and failed
// immediately with "Missing required phases: ['ui_and_review']" and "Test
// stories missing testCriteria field" — blocking the phase from ever
// starting, even though nothing about core's own stories was actually wrong.
describe('prd-remediate.sh — is_canonical bypass is scoped to the phase being validated, not the whole PRD', () => {
  function runRemediate(prd: object, phase: string): { stdout: string; exitCode: number } {
    const dir = mkdtempSync(join(tmpdir(), 'is-canonical-scope-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd));
      try {
        const stdout = execFileSync('bash', [REMEDIATE_SH, '--prd', prdPath, '--phase', phase], { encoding: 'utf8' });
        return { stdout, exitCode: 0 };
      } catch (e: any) {
        return { stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString(), exitCode: e.status ?? 1 };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const PRD_WITH_SCAFFOLD_ALREADY_SPLIT = {
    implementationOrder: {
      scaffold: ['SKY-001-impl', 'SKY-001-test'],
      core: ['SKY-002', 'SKY-003', 'SKY-004'],
    },
    stories: [
      {
        id: 'SKY-001',
        status: 'deprecated',
        completed: true,
        acceptanceCriteria: ['Delegated to split children: SKY-001-impl, SKY-001-test'],
        technicalNotes: { files: ['package.json'] },
      },
      {
        id: 'SKY-001-impl',
        status: 'completed',
        completed: true,
        acceptanceCriteria: ['ac1'],
        specification: { createdFrom: 'SKY-001' },
        technicalNotes: { files: ['package.json'] },
      },
      {
        id: 'SKY-001-test',
        status: 'completed',
        completed: true,
        acceptanceCriteria: ['ac2'],
        specification: { createdFrom: 'SKY-001' },
        technicalNotes: { files: ['package.json'] },
      },
      // core's own stories are genuinely pre-spec-pass: no createdFrom, no
      // testCriteria yet — exactly the live SKY-002/003/004 shape.
      { id: 'SKY-002', status: 'pending', completed: false, effort: 'low', aiProvider: 'qwen', acceptanceCriteria: ['ac'], technicalNotes: { files: ['src/a.ts'] } },
      { id: 'SKY-003', status: 'pending', completed: false, effort: 'low', aiProvider: 'qwen', acceptanceCriteria: ['ac'], technicalNotes: { files: ['src/b.ts'] } },
      { id: 'SKY-004', status: 'pending', completed: false, effort: 'low', aiProvider: 'qwen', acceptanceCriteria: ['ac'], technicalNotes: { files: ['src/c.ts'] } },
    ],
  };

  it('REPRODUCES the exact live failure and its fix: core phase remediation succeeds (is canonical) even though scaffold already split SKY-001', () => {
    const result = runRemediate(PRD_WITH_SCAFFOLD_ALREADY_SPLIT, 'core');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/PRD is canonical \(pre-spec-pass/);
    expect(result.stdout).not.toMatch(/Missing required phases/);
    expect(result.stdout).not.toMatch(/missing TC/i);
  });

  it('scaffold phase remediation (the phase that actually has the split) correctly runs the FULL strict checks, not the canonical bypass', () => {
    const result = runRemediate(PRD_WITH_SCAFFOLD_ALREADY_SPLIT, 'scaffold');
    // scaffold's own active stories DO have createdFrom, so is_canonical is
    // correctly false here — this exercises the real preflight-prd-integrity.sh
    // path (which will report ITS OWN findings; the point is it must not take
    // the canonical bypass shortcut for a phase that genuinely has splits).
    expect(result.stdout).not.toMatch(/PRD is canonical \(pre-spec-pass/);
  });

  it('is_canonical scoping reads implementationOrder[$PHASE] (the code, not just the fixture)', () => {
    const src = readFileSync(REMEDIATE_SH, 'utf8');
    const idx = src.indexOf('_is_canonical=$(python3');
    const block = src.slice(idx, idx + 500);
    expect(block).toMatch(/phase_ids = set\(d\.get\('implementationOrder', \{\}\)\.get\('\$PHASE', \[\]\)\)/);
    expect(block).toMatch(/for sid in phase_ids/);
  });
});
