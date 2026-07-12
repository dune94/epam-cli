/**
 * prd-remediate.sh --mid-phase-retry — the gate-remediation self-heal retry
 * path (tier3-travel-app-run.sh's run_phase(), exit-2 branch) must not be
 * blocked by the canonical/stale-spec check.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run): Step
 * 4.2 (testing gates) applied a real remediation to SKY-001 (3 ACs added)
 * and returned exit 2 ("remediated, retry required"). tier3's self-heal
 * branch then re-runs prd-remediate.sh mid-phase — AFTER Step 0 (spec-pass)
 * had already elaborated SKY-001 for real this invocation. prd-remediate's
 * own `_is_canonical` heuristic only detects split children
 * (`.specification.createdFrom`); SKY-001 was never split (a single combo
 * story), so it looked "canonical." Its stale-spec sub-check then flagged
 * SKY-001's legitimate, this-run `specification` block as prior-run
 * contamination, because the status-reset step moments earlier
 * (_prd_remediate_impl.py) had just set completed=false on it as routine
 * active-story reset — making "not completed" indistinguishable from
 * genuine staleness in this specific call context. Result: the self-heal
 * retry hard-failed and the whole pipeline aborted instead of retrying.
 *
 * Fix: a new --mid-phase-retry flag, passed only by tier3's self-heal call
 * site, skips the stale-spec check — the caller already knows unambiguously
 * that spec-pass ran this invocation, so any specification block here is
 * real, not prior-run contamination.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PRD_REMEDIATE_SH = join(REPO_ROOT, 'orchestrations/scripts/prd-remediate.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const prdRemediateSrc = readFileSync(PRD_REMEDIATE_SH, 'utf8');
const tier3Src = readFileSync(TIER3_SH, 'utf8');

describe('prd-remediate.sh --mid-phase-retry — wiring (static)', () => {
  it('accepts a --mid-phase-retry flag', () => {
    expect(prdRemediateSrc).toMatch(/--mid-phase-retry\)\s*MID_PHASE_RETRY=1/);
  });

  it('the self-heal retry call site in tier3-travel-app-run.sh passes --mid-phase-retry', () => {
    const idx = tier3Src.indexOf('Self-healing: gate remediation applied');
    expect(idx).toBeGreaterThan(-1);
    const block = tier3Src.slice(idx, idx + 300);
    expect(block).toMatch(/prd-remediate\.sh" --prd "\$PRD_FILE" --phase "\$phase" --mid-phase-retry/);
  });

  it('the FIRST (pre-phase) prd-remediate.sh call site does NOT pass --mid-phase-retry', () => {
    const idx = tier3Src.indexOf('Pre-phase PRD remediation');
    expect(idx).toBeGreaterThan(-1);
    const block = tier3Src.slice(idx, idx + 300);
    expect(block).toMatch(/prd-remediate\.sh" --prd "\$PRD_FILE" --phase "\$phase"/);
    expect(block).not.toMatch(/--mid-phase-retry/);
  });
});

describe('prd-remediate.sh --mid-phase-retry — REAL execution', () => {
  function buildPrd(dir: string, opts: { completed: boolean }) {
    const prdPath = join(dir, 'prd.json');
    const prd = {
      implementationOrder: { scaffold: ['SKY-001'] },
      stories: [
        {
          id: 'SKY-001',
          status: opts.completed ? 'completed' : 'pending',
          completed: opts.completed,
          agentRole: 'typescript-engineer',
          acceptanceCriteria: Array.from({ length: 20 }, (_, i) => `AC ${i + 1}`),
          technicalNotes: { files: ['src/cli.ts'] },
          // Real, this-run spec-pass elaboration on a story that was never
          // split (no createdFrom) — the exact shape that fooled the old
          // canonical/stale-spec heuristic.
          specification: { testCriteria: { facts: ['fact 1'] }, elaboratedAt: '2026-07-11T00:00:00Z' },
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    return prdPath;
  }

  function run(prdPath: string, extraArgs: string[]): { exitCode: number; output: string } {
    try {
      const output = execFileSync(
        'bash',
        [PRD_REMEDIATE_SH, '--prd', prdPath, '--phase', 'scaffold', ...extraArgs],
        { encoding: 'utf8' },
      );
      return { exitCode: 0, output };
    } catch (e: any) {
      return { exitCode: e.status ?? -1, output: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    }
  }

  it('REPRODUCES the exact live defect: WITHOUT --mid-phase-retry, a never-split story carrying this-run specification data is wrongly flagged as stale and aborts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-mid-retry-'));
    try {
      const prdPath = buildPrd(dir, { completed: true });
      const { exitCode, output } = run(prdPath, []);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/pre-baked 'specification' blocks on base stories/);
      expect(output).toMatch(/SKY-001/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PROVES the fix: WITH --mid-phase-retry, the same PRD remediates successfully instead of aborting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-mid-retry-fixed-'));
    try {
      const prdPath = buildPrd(dir, { completed: true });
      const { exitCode, output } = run(prdPath, ['--mid-phase-retry']);
      expect(exitCode).toBe(0);
      expect(output).not.toMatch(/pre-baked 'specification' blocks/);
      expect(output).toMatch(/skipping stale-spec check/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--mid-phase-retry does not disable OTHER remediation steps (ACs still trimmed to 24)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-mid-retry-other-steps-'));
    try {
      const prdPath = buildPrd(dir, { completed: true });
      let prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      prd.stories[0].acceptanceCriteria = Array.from({ length: 28 }, (_, i) => `AC ${i + 1}`);
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));
      const { exitCode } = run(prdPath, ['--mid-phase-retry']);
      expect(exitCode).toBe(0);
      prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      expect(prd.stories[0].acceptanceCriteria.length).toBe(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a GENUINELY stale, never-completed base story with no split (real prior-run contamination shape minus the retry context) still fails WITHOUT the flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-genuine-stale-'));
    try {
      const prdPath = buildPrd(dir, { completed: false });
      const { exitCode, output } = run(prdPath, []);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/pre-baked 'specification' blocks on base stories/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
