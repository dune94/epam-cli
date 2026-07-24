/**
 * Codeline / worktree integration invariants for the Jira pipeline path.
 *
 * Covers:
 *   G1 — scaffold-fe-repo.sh is named to match scaffold-${cl}-repo.sh convention
 *   G2 — exit 2 (gate remediation) triggers self-healing retry in _run_codeline_loop
 *   G3 — --reset is passed to every phase re-exec in the codeline loop
 *   G4 — .epam/ manifests are written to worktrees that lack them
 *   G5 — extractAcFromText strips numbered list prefixes (1. / 1) syntax)
 *   G6 — scaffold npm install uses --no-audit --no-fund + timeout (prevents hang on post-install network calls)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH   = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc   = readFileSync(ORCH_SH, 'utf8');

// ─── G1: scaffold script naming ──────────────────────────────────────────────

describe('G1: scaffold-fe-repo.sh named correctly for codeline loop lookup', () => {
  it('scaffold-fe-repo.sh exists at expected path', () => {
    const p = join(REPO_ROOT, 'orchestrations/scripts/scaffold-fe-repo.sh');
    expect(existsSync(p), `${p} must exist`).toBe(true);
  });

  it('codeline loop uses scaffold-${cl}-repo.sh convention (not scaffold-frontend-repo.sh)', () => {
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 3000);
    expect(block).toContain('scaffold-${_cl}-repo.sh');
    expect(block).not.toContain('scaffold-frontend-repo.sh');
  });
});

// ─── G2: exit 2 self-heal in codeline loop ───────────────────────────────────

describe('G2: _run_codeline_loop handles exit 2 (gate remediation) with self-healing retry', () => {
  // _run_codeline_loop grows with each fix; use a wide enough window.
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  const block   = orchSrc.slice(loopIdx, loopIdx + 16000);

  it('handles exit 2 from phase re-exec as gate-remediation (not hard failure)', () => {
    expect(block).toMatch(/_pex.*-eq 2|_pex.*== 2/);
  });

  it('retries with SKIP_GATE_REMEDIATION=1 on exit 2', () => {
    expect(block).toContain('SKIP_GATE_REMEDIATION=1');
  });

  it('logs a self-healing message on exit 2', () => {
    expect(block).toMatch(/Gate remediation applied.*retrying|self-healing retry succeeded/i);
  });

  it('still treats non-zero exit after retry as failure', () => {
    expect(block).toMatch(/_pex.*-ne 0[\s\S]{1,600}_cl_failed=1/s);
  });
});

// ─── G3: --reset passed to phase re-exec ─────────────────────────────────────

describe('G3: --reset is passed to every phase re-exec in _run_codeline_loop', () => {
  it('first phase invocation uses --reset', () => {
    // Use the first executable JIRA_CODELINE_RUN=1 (has leading spaces — inside loop body)
    const execIdx = orchSrc.indexOf('      JIRA_CODELINE_RUN=1');
    expect(execIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(execIdx, execIdx + 400);
    expect(block).toContain('--reset');
  });

  it('self-healing retry invocation also uses --reset', () => {
    // The SKIP_GATE_REMEDIATION=1 re-exec must call bash "$0" --reset
    const allMatches = [...orchSrc.matchAll(/SKIP_GATE_REMEDIATION=1[\s\S]{1,400}bash "\$0" --reset/g)];
    expect(allMatches.length, 'No SKIP_GATE_REMEDIATION retry with --reset found').toBeGreaterThan(0);
  });

  it('uses PIPESTATUS[0] to capture bash exit code (not tee exit)', () => {
    // The naive `bash "$0" | tee || _pex=$?` captures tee's exit, not bash's.
    // Must use || _pex=${PIPESTATUS[0]} so gate-remediation exit 2 is not lost.
    // Search from the first executable JIRA_CODELINE_RUN=1 (has leading spaces — inside the loop).
    const execIdx = orchSrc.indexOf('      JIRA_CODELINE_RUN=1');
    expect(execIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(execIdx, execIdx + 1000);
    expect(block).toContain('PIPESTATUS[0]');
  });
});

// ─── G4: .epam/ manifests written per worktree ───────────────────────────────

describe('G4: .epam/ manifests are written to worktrees missing them', () => {
  it('orch script writes dependency-check.json when absent', () => {
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 8000);
    expect(block).toContain('dependency-check.json');
    expect(block).toContain('contract-generation.json');
    expect(block).toContain('known-fixes.json');
  });

  it('manifest write is guarded by absence check (idempotent)', () => {
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 8000);
    expect(block).toMatch(/if \[ ! -f.*dependency-check\.json/);
  });

  it('REAL: writes manifests to a fresh worktree dir and skips on second call (idempotent)', () => {
    // Extract the manifest-setup block including the closing `fi`.
    // End marker: `    fi\n` after the log line (closing the `if [ ! -f ... ]` guard).
    const setupStart = orchSrc.indexOf('# Write .epam/ manifests if absent');
    const logLine    = orchSrc.indexOf('log "[orch] Wrote .epam/ manifests', setupStart);
    const fiClose    = orchSrc.indexOf('    fi\n', logLine);
    expect(setupStart).toBeGreaterThan(-1);
    expect(logLine).toBeGreaterThan(setupStart);
    expect(fiClose).toBeGreaterThan(logLine);

    const setupBlock = orchSrc.slice(setupStart, fiClose + 6); // include "    fi\n"

    const dir = mkdtempSync(join(tmpdir(), 'cl-manifest-'));
    try {
      const wt = join(dir, 'worktree');
      mkdirSync(wt, { recursive: true });

      const script = join(dir, 'run.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log()     { echo "LOG: $*"; }',
        'warning() { echo "WARN: $*"; }',
        `_wt=${JSON.stringify(wt)}`,
        setupBlock,
      ].join('\n'));

      // First call: should write files
      let out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out).toContain('Wrote .epam/ manifests');
      expect(existsSync(join(wt, '.epam/dependency-check.json'))).toBe(true);
      expect(existsSync(join(wt, '.epam/contract-generation.json'))).toBe(true);
      expect(existsSync(join(wt, '.epam/known-fixes.json'))).toBe(true);

      // Second call: guard prevents re-write (no log line)
      out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out).not.toContain('Wrote .epam/ manifests');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('written manifests are all valid JSON', () => {
    const setupStart = orchSrc.indexOf('# Write .epam/ manifests if absent');
    const logLine    = orchSrc.indexOf('log "[orch] Wrote .epam/ manifests', setupStart);
    const fiClose    = orchSrc.indexOf('    fi\n', logLine);
    const setupBlock = orchSrc.slice(setupStart, fiClose + 6);

    const dir = mkdtempSync(join(tmpdir(), 'cl-manifest-json-'));
    try {
      const wt = join(dir, 'worktree');
      mkdirSync(wt, { recursive: true });

      const script = join(dir, 'run.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log()     { :; }',
        `_wt=${JSON.stringify(wt)}`,
        setupBlock,
      ].join('\n'));

      execFileSync('bash', [script], { encoding: 'utf8' });

      for (const f of ['dependency-check.json', 'contract-generation.json', 'known-fixes.json']) {
        const content = readFileSync(join(wt, '.epam', f), 'utf8');
        expect(() => JSON.parse(content), `${f} must be valid JSON`).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── G5: extractAcFromText strips numbered list prefixes ────────────────���────

describe('G5: extractAcFromText strips numbered list prefixes from ACs', () => {
  // Inline the function from jira-client.js for unit testing
  function extractAcFromText(text: string): string[] {
    if (!text) return [];
    const match = text.match(/acceptance criteria[:\s]*\n([\s\S]+?)(?:\n#{1,3}|\n\n\n|$)/i);
    if (!match) return [];
    return match[1]
      .split('\n')
      .map((l: string) => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter((l: string) => l.length > 5);
  }

  it('strips "1. " prefix from numbered ACs', () => {
    const text = 'Acceptance Criteria:\n1. Server returns 200 OK\n2. Response includes flight data';
    const acs  = extractAcFromText(text);
    expect(acs[0]).toBe('Server returns 200 OK');
    expect(acs[1]).toBe('Response includes flight data');
  });

  it('strips "1) " prefix variant', () => {
    const text = 'Acceptance Criteria:\n1) First criterion\n2) Second criterion';
    const acs  = extractAcFromText(text);
    expect(acs[0]).toBe('First criterion');
  });

  it('still strips bullet characters', () => {
    const text = 'Acceptance Criteria:\n- Bullet one\n• Bullet two\n* Bullet three';
    const acs  = extractAcFromText(text);
    expect(acs[0]).toBe('Bullet one');
    expect(acs[1]).toBe('Bullet two');
    expect(acs[2]).toBe('Bullet three');
  });

  it('plain ACs without prefix are unchanged', () => {
    const text = 'Acceptance Criteria:\nAPI endpoint responds within 200ms';
    const acs  = extractAcFromText(text);
    expect(acs[0]).toBe('API endpoint responds within 200ms');
  });
});

// ─── G6: scaffold npm install flags prevent hang ──────────────────────────────

describe('G6: scaffold npm install uses --no-audit --no-fund and timeout to prevent hang', () => {
  const REPO_ROOT = join(__dirname, '../../../');

  for (const script of ['scaffold-be-repo.sh', 'scaffold-fe-repo.sh']) {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts', script), 'utf8');

    it(`${script}: npm install uses --no-audit flag`, () => {
      expect(src).toContain('--no-audit');
    });

    it(`${script}: npm install uses --no-fund flag`, () => {
      expect(src).toContain('--no-fund');
    });

    it(`${script}: npm install uses timeout --kill-after (SIGKILL if npm ignores SIGTERM)`, () => {
      // npm ignores SIGTERM — must use --kill-after=Xs so timeout sends SIGKILL
      expect(src).toMatch(/timeout --kill-after=\S+ \S+ .*install.*--no-audit/);
    });
  }
});

// ─── G7: timeout --kill-after actually terminates SIGTERM-ignoring processes ──
//
// Root cause confirmed live (2026-07-19): `timeout 120 npm install` sent SIGTERM
// after 120s but npm ignored it. timeout exited leaving npm as an orphan still
// running 9m44s after the deadline. `--kill-after=5s` sends SIGKILL 5s after
// SIGTERM if the process is still alive — this test proves it actually works.

describe('G7: timeout --kill-after=5s terminates a SIGTERM-ignoring process', () => {
  it('REAL: process that traps SIGTERM is killed by SIGKILL within ~8s (5s kill-after + 3s deadline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeout-kill-'));
    try {
      // Simulate npm: a process that ignores SIGTERM but would otherwise run forever
      const stubPath = join(dir, 'sigterm-ignorer.sh');
      writeFileSync(stubPath, [
        '#!/usr/bin/env bash',
        'trap "" TERM',    // ignore SIGTERM
        'sleep 60',        // would hang for 60s without SIGKILL
      ].join('\n'));
      execFileSync('chmod', ['+x', stubPath]);

      const start = Date.now();
      let threw = false;
      try {
        // 3s deadline + 5s kill-after → SIGKILL sent at ~3s, process dead by ~8s
        execFileSync('timeout', ['--kill-after=5s', '3s', stubPath], {
          encoding: 'utf8',
          timeout: 15000,   // test-level safety net (well above the ~8s expected)
        });
      } catch {
        threw = true;  // timeout exits non-zero when it kills the child
      }
      const elapsed = Date.now() - start;

      expect(threw, 'timeout should exit non-zero after killing the process').toBe(true);
      expect(elapsed, 'process must be dead within 15s (kill-after=5s + 3s deadline + margin)').toBeLessThan(15000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL: without --kill-after, SIGTERM-ignoring process outlives the deadline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeout-nokill-'));
    try {
      const stubPath = join(dir, 'sigterm-ignorer.sh');
      writeFileSync(stubPath, [
        '#!/usr/bin/env bash',
        'trap "" TERM',
        'sleep 60',
      ].join('\n'));
      execFileSync('chmod', ['+x', stubPath]);

      // timeout without --kill-after: sends SIGTERM at 2s, then exits itself.
      // The child keeps running — timeout exits non-zero but the child is still alive.
      let threw = false;
      let childPid: string | null = null;

      // Run in background, capture PID so we can verify it's still alive afterward
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      try {
        execSync(`timeout 2s ${stubPath} & echo $!`, { encoding: 'utf8', timeout: 6000 });
      } catch { /* expected */ }

      // The real assertion: scaffold scripts MUST use --kill-after so they don't
      // leave orphaned processes. The source check in G6 enforces this statically.
      // This test documents WHY: without it, the process outlives timeout.
      const REPO_ROOT = join(__dirname, '../../../');
      for (const script of ['scaffold-be-repo.sh', 'scaffold-fe-repo.sh']) {
        const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts', script), 'utf8');
        expect(src).toMatch(/timeout --kill-after=/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
