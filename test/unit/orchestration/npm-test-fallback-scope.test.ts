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

/**
 * THE GUARD ASKED THE WRONG QUESTION, AND THAT IS WHY IT IS GONE.
 *
 * It required the STORY to own a .test/.spec file (`_owns_test_file > 0`) before the suite would
 * run. It was added 2026-07-08 for a scaffold story whose only job was writing a manifest: the
 * suite then failed because no test files existed ANYWHERE, the analyst misdiagnosed "missing
 * test files", tried to create one, and the scope-guard blocked the write — a guaranteed
 * infinite loop. That state is real and is still skipped, via repoHasTests.
 *
 * But a BROWNFIELD story modifying existing code declares source files, never test files, so the
 * condition was 0 by definition. Live 2026-08-11 (AMSD-2041/gotransit): the command stayed empty,
 * run_external_verification returned 0 = PASS, and the writer was told its change passed the
 * tests. Nothing had run, and ten previously-green suites were broken by an import it had just
 * added — invisible to all 8 retry attempts.
 *
 * "This repo has no tests" and "this story declares no test file" are different states, and only
 * the first justifies skipping. The suite command and the test-file convention are now PROJECT
 * declarations read through orchestrations/plugins/verification-plugin.js.
 */
describe('run_external_verification() — the suite is skipped only when the REPO has no tests', () => {
  // COMMENTS STRIPPED. Mutation-verified 2026-08-11 across three files today: a `toContain`
  // assertion is satisfied by explanatory prose that NAMES the thing it forbids, so it passes
  // while the code says the opposite. Only executable lines count.
  const body = extractHeredocAwareFunctionBody('run_external_verification')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('asks whether the repository has tests, not whether the story owns one', () => {
    expect(body).toContain('_project_repo_has_tests');
    expect(
      body,
      'the story-ownership condition is what made every brownfield change skip its suite',
    ).not.toContain('_owns_test_file');
  });

  it('an UNDECLARED test-file convention does not silently skip the suite', () => {
    // "unknown" must not be read as "no tests" — that re-creates the fail-open one layer down.
    expect(body).toMatch(/"\$_repo_has_tests" = "false"/);
  });

  it('the suite command comes from the project, not from the engine', () => {
    expect(body).toContain('_project_test_command');
    for (const banned of ['npm test', 'scripts.test', 'package.json']) {
      expect(body, `'${banned}' is a project fact`).not.toContain(banned);
    }
  });
});

describe('run_external_verification() — REAL execution, scope-aware npm-test fallback', () => {
  function runVerification(opts: { prdStories: object[]; hasPackageJsonTestScript: boolean; repoHasTests?: boolean }): {
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
          `run_anti_pattern_check() { return 0; }`,
          `run_vendor_integrity_check() { return 0; }`,
          `run_dynamic_tools_in_unlocked_window() { :; }`,
          `_vendor_unlock() { :; }`,
          `run_mock_completeness_check() { return 0; }`,
          // The suite command and the "does this repo have tests" answer are PROJECT
          // declarations now, read through orchestrations/plugins/verification-plugin.js. These
          // fixtures stand in for a project that declares both — the behaviour under test is
          // WHEN the suite runs, not how the declaration is read.
          `_project_repo_has_tests() { echo ${JSON.stringify(String(opts.repoHasTests ?? true))}; }`,
          `_project_test_command() { ${opts.hasPackageJsonTestScript ? 'echo "npm test"' : ':'}; }`,
          `_project_owned_test_files() { :; }`,
          `_project_scoped_test_command() { :; }`,
          `_project_dep_config_value() { :; }`,
          `_project_manifest_file() { :; }`,
          `_project_install_command() { :; }`,
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

  it('SCAFFOLD CASE: a repo with NO test files anywhere is not gated on the suite', () => {
    // This is what the removed `_owns_test_file` guard was really protecting: a scaffold story
    // whose only job is writing a manifest, in a repo that has no tests yet. Running the suite
    // then fails, the analyst misdiagnoses "missing test files", tries to create one, and the
    // scope-guard blocks the write — a guaranteed infinite loop (live 2026-07-08, SKY-001A).
    // The condition is now the REPO's state, not the story's declared files.
    const result = runVerification({
      hasPackageJsonTestScript: true,
      repoHasTests: false,
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

  it('skips when the project declares no suite command at all', () => {
    const result = runVerification({
      hasPackageJsonTestScript: false,
      prdStories: [{ id: 'SKY-001A', technicalNotes: { files: ['package.json'] } }],
    });
    expect(result.stdout).not.toMatch(/External verification failed/);
    expect(result.stdout).toMatch(/EXIT:0/);
  });
});
