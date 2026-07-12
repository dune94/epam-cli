/**
 * run_external_verification() — npm-test fallback must be scoped to stories
 * that actually own a test file.
 *
 * Root cause this fixes (found live, 2026-07-08, tier3-travel-app run):
 * SKY-001A's only job is writing package.json (technicalNotes.files =
 * ["package.json"]), and its own ACs require scripts.test="vitest run" in
 * that file. The moment it wrote package.json correctly, the "fall back to
 * npm test if package.json has a test script" heuristic fired — even though
 * SKY-001A never declared ownership of any .test.ts file. `npm test` then
 * failed because no test files exist ANYWHERE yet (true on the very first
 * scaffold story), the failure-analyst misdiagnosed "missing test files" and
 * tried to create one, and the scope-guard correctly blocked that write
 * since the story didn't own it — a structurally guaranteed infinite retry
 * loop (3 HEALING_BROKEN escalations observed before the run was killed).
 *
 * Fix: only treat package.json's scripts.test as a signal to run npm test
 * when the CURRENT story's own technicalNotes.files includes at least one
 * .test./.spec. file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractHeredocAwareFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  let inHeredoc = false;
  let heredocDelim = '';
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    if (!inHeredoc) {
      const m = line.match(/<<-?\s*'?(\w+)'?/);
      if (m) {
        inHeredoc = true;
        heredocDelim = m[1];
        continue;
      }
      if (line === '}') return body.join('\n');
    } else if (line.trim() === heredocDelim) {
      inHeredoc = false;
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('run_external_verification() — npm-test fallback is scope-aware (static)', () => {
  const body = extractHeredocAwareFunctionBody('run_external_verification');

  it('checks the story\'s own declared files for a test file before falling back to npm test', () => {
    expect(body).toMatch(/technicalNotes\.files.*test\|spec/);
  });

  it('only sets test_cmd="npm test" when the story owns a test file, not merely when package.json has one', () => {
    const fallbackIdx = body.indexOf('Fall back to npm test');
    const block = body.slice(fallbackIdx, fallbackIdx + 2500);
    expect(block).toMatch(/_owns_test_file/);
    expect(block).toMatch(/\[ -n "\$has_test" \] && \[ "\$\{_owns_test_file:-0\}" -gt 0 \]/);
  });
});

describe('run_external_verification() — REAL execution, scope-aware npm-test fallback', () => {
  function runVerification(opts: { prdStories: object[]; hasPackageJsonTestScript: boolean }): {
    stdout: string;
    exitCode: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'npm-test-fallback-scope-test-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      // If npm test actually runs, it fails loudly and distinctly so the
      // test can tell whether the fallback fired at all.
      writeFileSync(
        join(binDir, 'npm'),
        '#!/usr/bin/env bash\necho "NPM_TEST_ACTUALLY_RAN"\nexit 1\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: opts.hasPackageJsonTestScript ? { test: 'vitest run' } : {},
        })
      );
      mkdirSync(join(dir, 'node_modules'), { recursive: true });

      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }));

      const fnBody = extractHeredocAwareFunctionBody('run_external_verification');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `export PATH="${binDir}:$PATH"`,
          `PROJECT_ROOT="${dir}"`,
          `PRD_FILE="${prdPath}"`,
          `EPAM_TEST_TIMEOUT_SECS=5`,
          `log() { echo "LOG: $*"; }`,
          `warning() { echo "WARN: $*"; }`,
          `success() { echo "SUCCESS: $*"; }`,
          `run_dependency_check() { :; }`,
          `run_relative_import_check() { return 0; }`,
          `run_named_import_check() { return 0; }`,
          `run_vendor_integrity_check() { return 0; }`,
          `run_dynamic_tools_in_unlocked_window() { :; }`,
          `_vendor_unlock() { :; }`,
          `run_mock_completeness_check() { return 0; }`,
          fnBody,
          `run_external_verification "SKY-001A" "/dev/null"`,
          `echo "EXIT:$?"`,
        ].join('\n')
      );

      let stdout = '';
      let exitCode = 0;
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
        exitCode = e.status ?? -1;
      }
      return { stdout, exitCode };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Note: run_external_verification only echoes the test command's own
  // stdout/stderr into $output_file (here /dev/null), never onto the
  // process's own stdout — so "did npm test actually run and fail" is
  // observed via the warning()/EXIT:N calls made directly in claude.sh
  // (which the test's inline `warning() { echo "WARN: $*"; }` stub captures),
  // not via the stubbed npm binary's own echoed marker text.

  it('REPRODUCES the exact live bug scenario: a package.json-only story (no owned test file) is NOT gated on npm test', () => {
    const result = runVerification({
      hasPackageJsonTestScript: true,
      prdStories: [{ id: 'SKY-001A', technicalNotes: { files: ['package.json'] } }],
    });
    expect(result.stdout).not.toMatch(/External verification failed/);
    expect(result.stdout).toMatch(/EXIT:0/);
  });

  it('DOES run npm test for a story that owns a .test.ts file', () => {
    const result = runVerification({
      hasPackageJsonTestScript: true,
      prdStories: [
        { id: 'SKY-001A', technicalNotes: { files: ['package.json', 'src/server.test.ts'] } },
      ],
    });
    expect(result.stdout).toMatch(/External verification failed for SKY-001A \(exit 1\)/);
    expect(result.stdout).toMatch(/EXIT:1/);
  });

  it('DOES run npm test for a story that owns a .spec.ts file', () => {
    const result = runVerification({
      hasPackageJsonTestScript: true,
      prdStories: [{ id: 'SKY-001A', technicalNotes: { files: ['src/util.spec.ts'] } }],
    });
    expect(result.stdout).toMatch(/External verification failed for SKY-001A \(exit 1\)/);
  });

  it('still skips verification entirely when package.json has no test script at all', () => {
    const result = runVerification({
      hasPackageJsonTestScript: false,
      prdStories: [{ id: 'SKY-001A', technicalNotes: { files: ['package.json'] } }],
    });
    expect(result.stdout).not.toMatch(/External verification failed/);
    expect(result.stdout).toMatch(/EXIT:0/);
  });
});
