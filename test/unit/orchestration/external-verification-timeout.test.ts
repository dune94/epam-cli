/**
 * run_external_verification() — bounded timeout on the test command.
 *
 * Root cause this fixes (found live, 2026-07-06, tier3-full-run-15): SKY-004-
 * config's own implementation succeeded (deliverables verified), but the
 * story-level 600s watchdog killed the entire claude.sh subprocess with ZERO
 * further log output — the new [post-story] diagnostic logging (added
 * earlier the same session for generate_story_contract/commit_completed_
 * story) never even fired, proving those weren't the culprit. Tracing the
 * log pinpointed the actual hang: "Running external verification: npm test"
 * was the LAST line before 600s of silence. `test_output=$(cd "$PROJECT_ROOT"
 * && eval "$test_cmd" 2>&1)` had no timeout at all — if a test starts a
 * server (app.listen()) without closing it (server.close()) in afterAll,
 * Node's event loop never drains and the test process hangs forever, with
 * the ONLY signal being the outer 600s watchdog eventually firing with a
 * generic, unhelpful "story timed out" message.
 *
 * Fix: wrap the test command with `timeout $EPAM_TEST_TIMEOUT_SECS` (default
 * 300s — comfortably under the lowest story-level watchdog ceiling of 600s,
 * so this always fires first) and give exit 124 (timeout) a distinct,
 * actionable VERIFICATION_FAILURE message that names the likely cause
 * (unclosed server/resource) instead of falling through to the generic
 * "tests failed" path.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// run_external_verification() calls run_dependency_check() and
// run_mock_completeness_check(), both of which embed python heredocs — a
// naive `indexOf('\n}', start)` would truncate inside one of those. Scan
// line-by-line tracking heredoc state, same pattern used for
// check_healing_effectiveness/generate_story_contract elsewhere in this suite.
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

describe('run_external_verification() — bounded test-command timeout (static)', () => {
  const body = extractHeredocAwareFunctionBody('run_external_verification');

  it('wraps the test command with `timeout`, not a bare eval', () => {
    expect(body).toMatch(/timeout "\$_test_timeout" bash -c "\$\{_orch_env_unset_prefix\}\$\{test_cmd\}"/);
    expect(body).not.toMatch(/\$\(cd "\$PROJECT_ROOT" && eval "\$test_cmd" 2>&1\)/);
  });

  it('the timeout duration is configurable via EPAM_TEST_TIMEOUT_SECS, defaulting to 300s', () => {
    expect(body).toMatch(/_test_timeout="\$\{EPAM_TEST_TIMEOUT_SECS:-300\}"/);
  });

  it('300s default is comfortably under the lowest story-level watchdog ceiling (600s)', () => {
    const match = body.match(/_test_timeout="\$\{EPAM_TEST_TIMEOUT_SECS:-(\d+)\}"/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1], 10)).toBeLessThan(600);
  });

  it('detects timeout (exit 124) with a distinct code path from a generic test failure', () => {
    expect(body).toMatch(/\[ "\$test_exit" -eq 124 \]/);
    const timeoutIdx = body.indexOf('"$test_exit" -eq 124');
    const genericFailIdx = body.indexOf('"$test_exit" -ne 0');
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(genericFailIdx).toBeGreaterThan(timeoutIdx);
  });

  it('the timeout diagnosis names the likely root cause (unclosed server/resource), not a generic message', () => {
    const timeoutIdx = body.indexOf('"$test_exit" -eq 124');
    const block = body.slice(timeoutIdx, timeoutIdx + 1200);
    expect(block).toMatch(/server\.close\(\)/);
    expect(block).toMatch(/app\.listen\(\)/);
    expect(block).toMatch(/TIMED OUT/);
  });

  it('both timeout and generic-failure paths still populate VERIFICATION_FAILURE (self-heal loop unaffected)', () => {
    const timeoutIdx = body.indexOf('"$test_exit" -eq 124');
    const timeoutBlock = body.slice(timeoutIdx, timeoutIdx + 400);
    expect(timeoutBlock).toMatch(/VERIFICATION_FAILURE=/);
    const genericIdx = body.indexOf('"$test_exit" -ne 0');
    // Window must be large enough to skip past the warning + comment block + local
    // var declarations that precede the VERIFICATION_FAILURE= assignment (~650 chars).
    const genericBlock = body.slice(genericIdx, genericIdx + 1200);
    expect(genericBlock).toMatch(/VERIFICATION_FAILURE=/);
  });
});

describe('run_external_verification() — REAL execution, proves the timeout actually bounds a hang', () => {
  function runVerification(opts: {
    testScript: string; // shell script body for the fake `npm`/test command
    prdStories: object[];
  }): { stdout: string; exitCode: number; durationMs: number } {
    const dir = mkdtempSync(join(tmpdir(), 'ext-verify-timeout-test-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'npm'), opts.testScript, { mode: 0o755 });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm-stub-marker' } }));
      // A node_modules dir must already exist, or run_external_verification's
      // pre-check ("Ensure node_modules exist in the worktree") runs `npm
      // install` FIRST using the same stubbed npm binary — isolate the test
      // to just the test-command timeout path, not that unrelated install step.
      mkdirSync(join(dir, 'node_modules'), { recursive: true });

      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }));

      const fnBody = extractHeredocAwareFunctionBody('run_external_verification');
      // Stub every dependency function this calls so the test isolates just
      // the timeout-wrapping behavior, not the full verification pipeline.
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `export PATH="${binDir}:$PATH"`,
          `PROJECT_ROOT="${dir}"`,
          `PRD_FILE="${prdPath}"`,
          `EPAM_TEST_TIMEOUT_SECS=1`,
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
          // The suite command is a PROJECT declaration now, read via
          // orchestrations/plugins/verification-plugin.js. Stubbed like the checks above so this
          // test isolates only the timeout behaviour; the PRD fixture supplies testCommand.
          `_project_repo_has_tests() { echo "true"; }`,
          `_project_test_command() { echo "npm test"; }`,
          `_project_owned_test_files() { :; }`,
          `_project_scoped_test_command() { :; }`,
          `_project_dep_config_value() { :; }`,
          // The worktree provisioning install is declaration-driven now: WHICH manifest, WHICH
          // vendor dir and WHICH command all come from dependency-check.json. Supplied here so
          // the install branch actually runs — the invariant under test (a hang is bounded by a
          // timeout) is unchanged, only its source is.
          `_project_manifest_file() { echo "package.json"; }`,
          `_project_install_command() { echo "npm install --silent"; }`,
          `_get_vendor_dirs() { echo "node_modules"; }`,
          fnBody,
          `run_external_verification "SKY-TEST" "/dev/null"`,
          `echo "EXIT:$?"`,
          `echo "VERIFICATION_FAILURE:$VERIFICATION_FAILURE"`,
        ].join('\n')
      );
      const start = Date.now();
      let stdout = '';
      let exitCode = 0;
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
        exitCode = e.status ?? -1;
      }
      return { stdout, exitCode, durationMs: Date.now() - start };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const BASE_STORY = [{ id: 'SKY-TEST', technicalNotes: { files: ['src/index.test.ts'] } }];

  it('REPRODUCES the exact live failure mode: a hanging test command (simulating an unclosed server) is killed by the timeout instead of blocking indefinitely', () => {
    // Simulates vitest hanging forever because a test left an http.Server open.
    const hangingNpm = '#!/usr/bin/env bash\nsleep 300\n';
    const result = runVerification({ testScript: hangingNpm, prdStories: BASE_STORY });
    expect(result.stdout).toMatch(/External verification TIMED OUT for SKY-TEST after 1s/);
    expect(result.stdout).toMatch(/EXIT:1/);
    // Must return well within the test's own 15s ceiling — proves the 1s
    // EPAM_TEST_TIMEOUT_SECS actually bounded the hang rather than running
    // to the full simulated 300s sleep (or the outer story-level watchdog).
    expect(result.durationMs).toBeLessThan(10000);
  });

  it('the VERIFICATION_FAILURE message on timeout names the likely root cause', () => {
    const hangingNpm = '#!/usr/bin/env bash\nsleep 300\n';
    const result = runVerification({ testScript: hangingNpm, prdStories: BASE_STORY });
    expect(result.stdout).toMatch(/server\.close\(\)/);
  });

  it('a normal (fast, passing) test command is unaffected by the timeout wrapper', () => {
    const fastPassingNpm = '#!/usr/bin/env bash\necho "5 passed"\nexit 0\n';
    const result = runVerification({ testScript: fastPassingNpm, prdStories: BASE_STORY });
    expect(result.stdout).toMatch(/External verification passed for SKY-TEST/);
    expect(result.stdout).not.toMatch(/TIMED OUT|timed out/);
    expect(result.stdout).toMatch(/EXIT:0/);
  });

  it('a normal (fast, failing) test command still reports a regular failure, not a timeout', () => {
    const fastFailingNpm = '#!/usr/bin/env bash\necho "1 failed"\nexit 1\n';
    const result = runVerification({ testScript: fastFailingNpm, prdStories: BASE_STORY });
    expect(result.stdout).toMatch(/External verification failed for SKY-TEST \(exit 1\)/);
    expect(result.stdout).not.toMatch(/TIMED OUT/);
    expect(result.stdout).toMatch(/EXIT:1/);
  });
});

describe('run_external_verification() — bounded npm-install timeout (found live, 2026-07-06, tier3-full-run-16)', () => {
  // Root cause: SKY-001-impl's watchdog fired even though the agent's own
  // implementation call finished in 11s (confirmed via the per-story
  // result.json timestamp) — the LAST log line before 600s of silence was
  // "Installing dependencies (node_modules missing in worktree)...". The
  // `npm install --silent` call that follows had no timeout at all, the
  // third unbounded external command found this session (after the test
  // command and git operations).
  function runVerificationNoNodeModules(opts: { npmScript: string; prdStories: object[] }): {
    stdout: string;
    exitCode: number;
    durationMs: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'ext-verify-install-timeout-test-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'npm'), opts.npmScript, { mode: 0o755 });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm-stub-marker' } }));
      // Deliberately NOT creating node_modules — this is what triggers the
      // "Ensure node_modules exist" branch and its npm install call.

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
          `EPAM_INSTALL_TIMEOUT_SECS=1`,
          `EPAM_TEST_TIMEOUT_SECS=1`,
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
          // The suite command is a PROJECT declaration now, read via
          // orchestrations/plugins/verification-plugin.js. Stubbed like the checks above so this
          // test isolates only the timeout behaviour; the PRD fixture supplies testCommand.
          `_project_repo_has_tests() { echo "true"; }`,
          `_project_test_command() { echo "npm test"; }`,
          `_project_owned_test_files() { :; }`,
          `_project_scoped_test_command() { :; }`,
          `_project_dep_config_value() { :; }`,
          // The worktree provisioning install is declaration-driven now: WHICH manifest, WHICH
          // vendor dir and WHICH command all come from dependency-check.json. Supplied here so
          // the install branch actually runs — the invariant under test (a hang is bounded by a
          // timeout) is unchanged, only its source is.
          `_project_manifest_file() { echo "package.json"; }`,
          `_project_install_command() { echo "npm install --silent"; }`,
          `_get_vendor_dirs() { echo "node_modules"; }`,
          fnBody,
          `run_external_verification "SKY-TEST" "/dev/null"`,
          `echo "EXIT:$?"`,
        ].join('\n')
      );
      const start = Date.now();
      let stdout = '';
      let exitCode = 0;
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
        exitCode = e.status ?? -1;
      }
      return { stdout, exitCode, durationMs: Date.now() - start };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const BASE_STORY = [{ id: 'SKY-TEST', technicalNotes: { files: ['src/index.test.ts'] } }];

  it('REPRODUCES the exact live failure: a hanging `npm install` (simulating a slow/unreachable registry) is killed by the timeout instead of blocking indefinitely', () => {
    const hangingNpm = '#!/usr/bin/env bash\nsleep 300\n';
    const result = runVerificationNoNodeModules({ npmScript: hangingNpm, prdStories: BASE_STORY });
    expect(result.stdout).toMatch(/dependency install TIMED OUT after 1s/);
    expect(result.durationMs).toBeLessThan(10000);
  });

  it('a normal (fast) npm install proceeds to the test command afterward, unaffected by the timeout wrapper', () => {
    const fastNpm = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "install" ]; then exit 0; fi',
      'echo "5 passed"',
      'exit 0',
    ].join('\n') + '\n';
    const result = runVerificationNoNodeModules({ npmScript: fastNpm, prdStories: BASE_STORY });
    expect(result.stdout).not.toMatch(/npm install TIMED OUT/);
    expect(result.stdout).toMatch(/External verification passed for SKY-TEST/);
  });
});
