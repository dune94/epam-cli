/**
 * run_dynamic_tools_in_unlocked_window() — REAL execution tests.
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run):
 * _vendor_lock() chmods configured vendor dirs (e.g. node_modules) read-only
 * for the WHOLE story turn, before the agent runs. When the failure-analyst
 * diagnoses a missing dependency and writes a dynamic tool that runs
 * `npm install X`, the agent invokes that tool via Bash DURING the same
 * locked turn — the install can never actually succeed (permission denied),
 * so the exact same diagnosis repeats every retry. Confirmed live:
 * SKY-002-test and SKY-002-test-1 each burned all 8 retries on "vitest
 * command not found" without install-vitest.sh (rewritten 5 times by the
 * failure-analyst under slightly different wording) ever actually installing
 * vitest — a structural conflict between two existing safety mechanisms
 * (vendor-guard's lock and the self-healing dynamic-tool pathway), not a
 * one-off fluke.
 *
 * Fix: run every REVIEWED dynamic tool deterministically, in the genuinely
 * unlocked window right after _vendor_unlock() (inside
 * run_external_verification()), instead of leaving it to the agent to invoke
 * mid-turn while locked. Tools are already required to be idempotent by the
 * tool_creation reviewer, so running them unconditionally here is safe.
 *
 * Safety gates added alongside this fix (explicit, not implicit):
 *   - only a tool with a sidecar `<tool>.sh.reviewed` marker is ever executed
 *     or surfaced to an agent — "only reviewed tools are used" is now a
 *     checkable invariant, not an assumption about there being no other
 *     writer to .epam/dynamic-tools/
 *   - `bash -n` syntax-checked before execution, since the orchestrator (not
 *     just the agent) now runs these unconditionally every retry
 */

import { describe, it, expect } from 'vitest';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('run_dynamic_tools_in_unlocked_window — design (static)', () => {
  it('is wired into run_external_verification right after _vendor_unlock, before the test command', () => {
    const unlockIdx = claudeSrc.indexOf('_vendor_unlock "$PROJECT_ROOT"');
    const runToolsIdx = claudeSrc.indexOf('run_dynamic_tools_in_unlocked_window "$PROJECT_ROOT"');
    const testCmdIdx = claudeSrc.indexOf("test_cmd=$(jq -r --arg id");
    expect(unlockIdx).toBeGreaterThan(-1);
    expect(runToolsIdx).toBeGreaterThan(unlockIdx);
    expect(testCmdIdx).toBeGreaterThan(runToolsIdx);
  });

  it('only executes a tool that has a .reviewed sidecar marker', () => {
    const body = extractFunctionByLineAnchor('run_dynamic_tools_in_unlocked_window');
    expect(body).toMatch(/\[ ! -f "\$\{_tool_file\}\.reviewed" \]/);
  });

  it('syntax-checks each tool with bash -n before executing it', () => {
    const body = extractFunctionByLineAnchor('run_dynamic_tools_in_unlocked_window');
    expect(body).toMatch(/bash -n "\$_tool_file"/);
  });

  it('the tool-writing code path writes a .reviewed marker only after an approved verdict', () => {
    const idx = claudeSrc.indexOf('if [ "$_tool_review_verdict" = "fail" ]');
    const block = claudeSrc.slice(idx, idx + 2000);
    expect(block).toMatch(/NOT written/);
    expect(block).toMatch(/\$\{tool_path\}\.reviewed/);
  });

  it('the agent-prompt tool listing also requires the .reviewed marker before surfacing a tool', () => {
    const idx = claudeSrc.indexOf('## Available Dynamic Tools');
    const block = claudeSrc.slice(idx, idx + 800);
    expect(block).toMatch(/\[ -f "\$\{_tool_file\}\.reviewed" \] \|\| continue/);
  });
});

describe('run_dynamic_tools_in_unlocked_window — REAL execution', () => {
  function setupProject(): string {
    return mkdtempSync(join(tmpdir(), 'dynamic-tools-unlocked-'));
  }

  function writeTool(dir: string, name: string, body: string, reviewed = true): string {
    const toolsDir = join(dir, '.epam', 'dynamic-tools');
    mkdirSync(toolsDir, { recursive: true });
    const toolPath = join(toolsDir, `${name}.sh`);
    writeFileSync(toolPath, body);
    chmodSync(toolPath, 0o755);
    if (reviewed) {
      writeFileSync(`${toolPath}.reviewed`, `reviewed_at=2026-01-01T00:00:00Z\nstory_id=TEST-1\n`);
    }
    return toolPath;
  }

  function run(dir: string): { stdout: string; exitCode: number } {
    const fnBody = extractFunctionByLineAnchor('run_dynamic_tools_in_unlocked_window');
    const scriptPath = join(dir, 'run.sh');
    const outputFile = join(dir, 'output.log');
    writeFileSync(
      scriptPath,
      [
        `log() { echo "LOG: $*"; }`,
        `warning() { echo "WARN: $*"; }`,
        fnBody,
        `run_dynamic_tools_in_unlocked_window "${dir}" "${outputFile}"`,
        `echo "EXIT:$?"`,
      ].join('\n')
    );
    writeFileSync(outputFile, '');
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      exitCode = e.status ?? -1;
    }
    let outputLog = '';
    try {
      outputLog = readFileSync(outputFile, 'utf8');
    } catch {
      /* no output file written — fine */
    }
    return { stdout: stdout + outputLog, exitCode };
  }

  it('REPRODUCES the exact live conflict: a dependency-install tool fails while vendor dirs are locked, but succeeds when run in the unlocked window', () => {
    const dir = setupProject();
    try {
      // Simulate the vendor-dir lock (chmod -R a-w) exactly as _vendor_lock does.
      const vendorDir = join(dir, 'node_modules');
      mkdirSync(vendorDir, { recursive: true });
      writeFileSync(join(vendorDir, '.keep'), '');
      chmodSync(vendorDir, 0o555); // read-only, matching a-w lock on the dir itself

      // A tool that "installs a dependency" by writing a new file into
      // node_modules — exactly what a real `npm install vitest` does.
      writeTool(dir, 'install-vitest', [
        '#!/usr/bin/env bash',
        '# installs vitest as a dev dependency if not already present',
        'set -e',
        `echo "installed" > "${vendorDir}/vitest-marker"`,
      ].join('\n'));

      // While locked: the write must fail (reproducing the live defect).
      let lockedFailed = false;
      try {
        execFileSync('bash', ['-c', `echo installed > "${vendorDir}/vitest-marker"`]);
      } catch {
        lockedFailed = true;
      }
      expect(lockedFailed).toBe(true);

      // Unlock (matching _vendor_unlock), THEN run the tool via the fix.
      chmodSync(vendorDir, 0o755);
      const { stdout } = run(dir);
      expect(stdout).toMatch(/Running install-vitest\.sh in sanctioned unlocked window/);
      expect(statSync(join(vendorDir, 'vitest-marker')).isFile()).toBe(true);
    } finally {
      chmodSync(join(dir, 'node_modules'), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT execute a tool missing its .reviewed marker', () => {
    const dir = setupProject();
    try {
      const marker = join(dir, 'unreviewed-marker.txt');
      writeTool(dir, 'unreviewed-tool', [
        '#!/usr/bin/env bash',
        '# does something unreviewed',
        'set -e',
        `echo "ran" > "${marker}"`,
      ].join('\n'), /* reviewed */ false);

      const { stdout } = run(dir);
      expect(stdout).toMatch(/Skipping unreviewed-tool\.sh — no \.reviewed marker/);
      expect(() => statSync(marker)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT execute a tool that fails bash -n syntax check', () => {
    const dir = setupProject();
    try {
      const marker = join(dir, 'broken-marker.txt');
      writeTool(dir, 'broken-tool', [
        '#!/usr/bin/env bash',
        '# has a syntax error',
        'set -e',
        'if [ true ; then', // missing closing bracket — genuine syntax error
        `  echo "ran" > "${marker}"`,
      ].join('\n'));

      const { stdout } = run(dir);
      expect(stdout).toMatch(/Skipping broken-tool\.sh — fails bash syntax check/);
      expect(() => statSync(marker)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs multiple reviewed tools and continues even if one exits non-zero', () => {
    const dir = setupProject();
    try {
      const markerA = join(dir, 'a-marker.txt');
      const markerB = join(dir, 'b-marker.txt');
      writeTool(dir, 'a-tool', [
        '#!/usr/bin/env bash',
        '# tool A, exits non-zero',
        `echo "ran a" > "${markerA}"`,
        'exit 1',
      ].join('\n'));
      writeTool(dir, 'b-tool', [
        '#!/usr/bin/env bash',
        '# tool B, succeeds',
        `echo "ran b" > "${markerB}"`,
      ].join('\n'));

      const { stdout } = run(dir);
      expect(stdout).toMatch(/a-tool\.sh exited non-zero \(continuing\)/);
      expect(statSync(markerA).isFile()).toBe(true);
      expect(statSync(markerB).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the dynamic-tools directory does not exist', () => {
    const dir = setupProject();
    try {
      const { exitCode } = run(dir);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
