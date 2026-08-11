/**
 * run_external_verification (claude.sh) must NOT leak the orchestrator's own
 * .env vars into the npm install / test-command subprocess it runs for a
 * generated app.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run):
 * SKY-002-test's "should throw error when no API key is provided" test kept
 * failing identically across 6+ retries, escalating through the full model
 * ladder, because the constructor under test (SkyscannerClient) legitimately
 * falls back to `process.env.RAPIDAPI_KEY` when no explicit apiKey is
 * passed — and epam-cli's OWN `.env` file (sourced by
 * run-agent-orchestration.sh for its own Anthropic/OpenRouter/MiniMax keys)
 * happens to also define RAPIDAPI_KEY, a real credential. That var leaks
 * all the way down through claude.sh's child `npm test` process, so the
 * constructor always found a real key and never threw — the generated
 * app's code was correct the entire time; the TEST's environment was
 * contaminated by a secret belonging to the orchestrator, not the app under
 * test. No amount of model escalation or skill guidance can ever fix a test
 * that's structurally unwinnable this way.
 *
 * Fix: before running npm install or the test command, read the
 * orchestrator's own .env file (same path convention as
 * run-agent-orchestration.sh: $(dirname "$AUTOMATION_DIR")/.env) and build
 * an `unset VAR1; unset VAR2; ...` prefix that's prepended to the child
 * `bash -c` command.
 *
 * Deliberately does NOT use `env -u VAR1 -u VAR2 ... cmd` (the more obvious
 * approach): this environment's PATH shadows the real GNU coreutils `env`
 * with an unrelated PATH-setup shell shim at ~/.local/bin/env that silently
 * no-ops on `-u` (confirmed live: `env -u FOO bash -c 'echo hi > marker'`
 * produced no output and no marker file — the wrapper never actually execs
 * the given command with the flag honored). A pure `unset` prefix has no
 * dependency on any external binary, so it can't be shadowed this way.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('run_external_verification — env sanitization wiring (static)', () => {
  it('computes _orch_env_unset_prefix from the orchestrator .env file using pure bash unset (not env -u)', () => {
    expect(claudeSrc).toMatch(/_orch_env_file="\$\(dirname "\$AUTOMATION_DIR"\)\/\.env"/);
    expect(claudeSrc).toMatch(
      /_orch_env_unset_prefix="\$\{_orch_env_unset_prefix\}unset \$\{_envkey\}; "/
    );
  });

  it('does NOT rely on `env -u` (shadowed by a broken PATH shim in this environment)', () => {
    expect(claudeSrc).not.toMatch(/env "\$\{_orch_env_unset_args/);
  });

  it('the npm install invocation is wrapped with the unset prefix via bash -c', () => {
    // The literal `npm install --silent` is gone: the command comes from the project's
    // dependency-check.json (installCommand). The INVARIANT is unchanged — whatever the project
    // declares must still be wrapped by the unset prefix, or the orchestrator's own .env leaks
    // into the child and the install resolves against the wrong registry/credentials.
    const idx = claudeSrc.indexOf('${_orch_env_unset_prefix}${_dep_install_all}');
    const block = claudeSrc.slice(Math.max(0, idx - 200), idx + 50);
    expect(block).toMatch(/bash -c "\$\{_orch_env_unset_prefix\}\$\{_dep_install_all\}"/);
  });

  it('the test-command invocation is wrapped with the unset prefix via bash -c', () => {
    const idx = claudeSrc.indexOf('${_orch_env_unset_prefix}${test_cmd}');
    expect(idx).toBeGreaterThan(-1);
  });

  it('the sanitization is computed BEFORE the npm install call site (so it protects both install and test)', () => {
    const unsetIdx = claudeSrc.indexOf('_orch_env_unset_prefix=""');
    const installIdx = claudeSrc.indexOf('${_orch_env_unset_prefix}${_dep_install_all}');
    expect(unsetIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(unsetIdx);
  });
});

describe('run_external_verification — env sanitization REAL execution', () => {
  function extractFunctionByBraceCount(name: string): string {
    const start = claudeSrc.indexOf(`${name}() {`);
    if (start === -1) throw new Error(`Function ${name} not found`);
    const braceStart = claudeSrc.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < claudeSrc.length; i++) {
      if (claudeSrc[i] === '{') depth++;
      else if (claudeSrc[i] === '}') {
        depth--;
        if (depth === 0) return claudeSrc.slice(start, i + 1);
      }
    }
    throw new Error(`Could not find end of function ${name}`);
  }

  function buildHarness(opts: {
    scriptsDir: string;
    projectRoot: string;
    testCommand: string;
  }): string {
    const fnBody = extractFunctionByBraceCount('run_external_verification');
    const prd = {
      stories: [
        {
          id: 'SKY-002-test',
          technicalNotes: { files: ['src/skyscanner/client.test.ts'], testCommand: opts.testCommand },
        },
      ],
    };
    return [
      '#!/usr/bin/env bash',
      'set -e',
      `SCRIPT_DIR="${opts.scriptsDir}"`,
      `AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"`,
      `PROJECT_ROOT="${opts.projectRoot}"`,
      'log() { :; }',
      'warning() { echo "WARN: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      'success() { :; }',
      // Stub every helper run_external_verification calls before the test
      // command, so this test isolates ONLY the env-sanitization behavior —
      // none of these checks are what's under test here.
      'run_vendor_integrity_check() { return 0; }',
      '_vendor_unlock() { :; }',
      'run_dynamic_tools_in_unlocked_window() { :; }',
      'run_dependency_check() { :; }',
      'run_relative_import_check() { return 0; }',
      'run_named_import_check() { return 0; }',
      'run_anti_pattern_check() { return 0; }',
      'run_mock_completeness_check() { return 0; }',
      // THE SUITE COMMAND IS NOW A PROJECT DECLARATION, read through
      // orchestrations/plugins/verification-plugin.js. These helpers are what run_external_
      // verification calls to obtain it; stubbed here because this test isolates ONLY the
      // env-sanitization behaviour, exactly like the checks stubbed above. The PRD fixture
      // supplies technicalNotes.testCommand, so the declaration path is not exercised.
      '_project_repo_has_tests() { echo "true"; }',
      '_project_test_command() { :; }',
      '_project_owned_test_files() { :; }',
      '_project_scoped_test_command() { :; }',
      '_project_dep_config_value() { :; }',
      '_project_manifest_file() { :; }',
      '_project_install_command() { :; }',
      fnBody,
      'PRD_FILE=$(mktemp)',
      `cat > "$PRD_FILE" <<'PRDEOF'`,
      JSON.stringify(prd),
      'PRDEOF',
      'run_external_verification "SKY-002-test" /dev/null',
    ].join('\n');
  }

  it('REPRODUCES the exact live defect and proves the fix: a var defined in the orchestrator .env is invisible to the test command, even though the calling process has it set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-sanitize-'));
    try {
      const scriptsDir = join(dir, 'orchestrations', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'RAPIDAPI_KEY=leaked-orchestrator-secret\n# a comment\n\nMINIMAX_API_KEY=also-leaked\n');
      const projectRoot = join(dir, 'app');
      mkdirSync(projectRoot, { recursive: true });
      const markerFile = join(dir, 'marker.txt');

      const scriptPath = join(scriptsDir, 'harness.sh');
      writeFileSync(
        scriptPath,
        buildHarness({
          scriptsDir,
          projectRoot,
          testCommand: `echo "RAPIDAPI_KEY=[\${RAPIDAPI_KEY:-unset}]" > ${JSON.stringify(markerFile)}`,
        }),
      );
      execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, RAPIDAPI_KEY: 'leaked-orchestrator-secret' },
      });
      const markerContent = readFileSync(markerFile, 'utf8');
      expect(markerContent).toMatch(/RAPIDAPI_KEY=\[unset\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT strip a var that is NOT defined in the orchestrator .env (e.g. a story-relevant var set elsewhere)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-sanitize-keep-'));
    try {
      const scriptsDir = join(dir, 'orchestrations', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'RAPIDAPI_KEY=leaked-orchestrator-secret\n');
      const projectRoot = join(dir, 'app');
      mkdirSync(projectRoot, { recursive: true });
      const markerFile = join(dir, 'marker.txt');

      const scriptPath = join(scriptsDir, 'harness.sh');
      writeFileSync(
        scriptPath,
        buildHarness({
          scriptsDir,
          projectRoot,
          testCommand: `echo "OTHER_VAR=[\${OTHER_VAR:-unset}]" > ${JSON.stringify(markerFile)}`,
        }),
      );
      execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, OTHER_VAR: 'still-here' },
      });
      const markerContent = readFileSync(markerFile, 'utf8');
      expect(markerContent).toMatch(/OTHER_VAR=\[still-here\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a safe no-op when there is no orchestrator .env file at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-sanitize-no-env-'));
    try {
      const scriptsDir = join(dir, 'orchestrations', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      // Deliberately no .env file written here.
      const projectRoot = join(dir, 'app');
      mkdirSync(projectRoot, { recursive: true });
      const markerFile = join(dir, 'marker.txt');

      const scriptPath = join(scriptsDir, 'harness.sh');
      writeFileSync(
        scriptPath,
        buildHarness({ scriptsDir, projectRoot, testCommand: `echo OK > ${JSON.stringify(markerFile)}` }),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(readFileSync(markerFile, 'utf8')).toMatch(/OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips MULTIPLE vars defined in the orchestrator .env, not just the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-sanitize-multi-'));
    try {
      const scriptsDir = join(dir, 'orchestrations', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(dir, '.env'), 'FIRST_SECRET=one\nSECOND_SECRET=two\nTHIRD_SECRET=three\n');
      const projectRoot = join(dir, 'app');
      mkdirSync(projectRoot, { recursive: true });
      const markerFile = join(dir, 'marker.txt');

      const scriptPath = join(scriptsDir, 'harness.sh');
      writeFileSync(
        scriptPath,
        buildHarness({
          scriptsDir,
          projectRoot,
          testCommand: `echo "F=[\${FIRST_SECRET:-unset}] S=[\${SECOND_SECRET:-unset}] T=[\${THIRD_SECRET:-unset}]" > ${JSON.stringify(markerFile)}`,
        }),
      );
      execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, FIRST_SECRET: 'one', SECOND_SECRET: 'two', THIRD_SECRET: 'three' },
      });
      const markerContent = readFileSync(markerFile, 'utf8');
      expect(markerContent).toMatch(/F=\[unset\] S=\[unset\] T=\[unset\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
