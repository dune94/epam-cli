/**
 * A dynamic-tool recipe must never re-invoke the project's OWN configured
 * test command as part of its own recipe.
 *
 * Root cause this fixes (found live, 2026-07-11/12, tier3-travel-app run,
 * SKY-004-test): the failure-analyst wrote a dynamic tool,
 * build-before-test.sh, whose STATED purpose was "ensure TypeScript is built
 * before tests run" — but its actual recipe was `npm run build && npx vitest
 * run`, independently re-running the FULL test suite a second time, outside
 * the orchestrator's own dedicated, captured run_external_verification()
 * step. That duplicate, uncoordinated invocation is a real contamination
 * risk: nothing isolates its output/side effects from the orchestrator's own
 * subsequent capture of $test_output, which is fed directly into the
 * failure-analyst's NEXT diagnosis as trusted ground truth. Traced via direct
 * log forensics: a stray, LLM-narration-flavored line ("The server starts
 * but port 3000 is already in use. Let me try with a different port:") ended
 * up as literally the LAST line of the captured test output at exactly the
 * point an LLM reader weights most heavily — and the failure-analyst then
 * hallucinated an unrelated IPv6-binding diagnosis, even though the actual,
 * correct root cause (a stale-env-capture bug) had already been correctly
 * diagnosed and persisted as a skill note two retries earlier.
 *
 * Fix: a deterministic pre-check, _tool_recipe_reinvokes_test_cmd(), rejects
 * (does not write) any tool_creation recipe that contains the project's own
 * resolved test command (exposed via LAST_TEST_CMD, set by
 * run_external_verification right after it resolves test_cmd) as a
 * substring. Generic/config-driven — compares against THIS project's actual
 * resolved command, not a hardcoded vitest/jest/mocha pattern list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const fnStart = claudeSrc.indexOf(`${name}() {`);
  const fnEnd = claudeSrc.indexOf('\n}', fnStart + 50);
  return claudeSrc.slice(fnStart, fnEnd + 2);
}

describe('_tool_recipe_reinvokes_test_cmd — wiring (static)', () => {
  it('the helper function exists and does a substring match against the passed test_cmd', () => {
    const body = extractFunctionBody('_tool_recipe_reinvokes_test_cmd');
    expect(body).toBeTruthy();
    expect(body).toMatch(/grep -qF -- "\$test_cmd"/);
  });

  it('run_external_verification exports LAST_TEST_CMD right after resolving test_cmd', () => {
    const idx = claudeSrc.indexOf("[ -z \"$test_cmd\" ] && return 0");
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx, idx + 400);
    expect(block).toMatch(/LAST_TEST_CMD="\$test_cmd"/);
    expect(block).toMatch(/export LAST_TEST_CMD/);
  });

  it("run_failure_analyst's tool) case calls the guard before writing, using LAST_TEST_CMD", () => {
    const body = extractFunctionBody('run_failure_analyst');
    const idx = body.indexOf('tool)');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 500);
    expect(block).toMatch(/_tool_recipe_reinvokes_test_cmd "\$tool_recipe" "\$\{LAST_TEST_CMD:-\}"/);
  });
});

describe('_tool_recipe_reinvokes_test_cmd — REAL execution', () => {
  function run(recipe: string, testCmd: string): number {
    const dir = mkdtempSync(join(tmpdir(), 'tool-recipe-guard-'));
    try {
      const fnBody = extractFunctionBody('_tool_recipe_reinvokes_test_cmd');
      const script = `
${fnBody}
_tool_recipe_reinvokes_test_cmd '${recipe.replace(/'/g, "'\\''")}' '${testCmd.replace(/'/g, "'\\''")}'
exit $?
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      try {
        execFileSync('bash', [scriptPath], { encoding: 'utf8' });
        return 0;
      } catch (e: any) {
        return e.status ?? -1;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('flags a recipe that re-invokes the exact resolved test command', () => {
    expect(run('npm run build && npm test', 'npm test')).toBe(0);
  });

  it('does NOT flag a recipe that only performs its own distinct mechanical step', () => {
    expect(run('npm run build', 'npm test')).toBe(1);
  });

  it('does NOT flag when no test_cmd was resolved (LAST_TEST_CMD unset/empty)', () => {
    expect(run('npm run build && npm test', '')).toBe(1);
  });

  it('flags a custom project-specific test command too (config-driven, not hardcoded to any runner name)', () => {
    expect(run('some-setup-step && yarn test:integration', 'yarn test:integration')).toBe(0);
  });
});

describe('run_failure_analyst — REAL execution: a tool_creation targeting the project\'s own test command is NOT written', () => {
  function runWithStub(analystResponse: string, testCmd: string): { output: string; toolWritten: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'analyst-tool-guard-'));
    try {
      const aiRunPath = join(dir, 'ai-run.sh');
      writeFileSync(
        aiRunPath,
        `#!/usr/bin/env bash\necho '${analystResponse.replace(/'/g, "'\\''")}'\n`,
      );
      chmodSync(aiRunPath, 0o755);

      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [
            {
              id: 'SKY-004-test',
              agentRole: 'test-engineer',
              acceptanceCriteria: ['server.test.ts covers the search endpoint'],
            },
          ],
        }),
      );

      const fnBody = extractFunctionBody('run_failure_analyst');
      const helperBody = extractFunctionBody('_tool_recipe_reinvokes_test_cmd');
      const script = `
exec 2>&1
SCRIPT_DIR="${dir}"
PROJECT_ROOT="${dir}"
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="fake-model"
MAIN_PRD_FILE=""
PRD_FILE="${prdPath}"
VERIFICATION_FAILURE="npm test failed"
LAST_TEST_CMD="${testCmd}"
warning() { echo "WARN: $*" >&2; }
log() { echo "LOG: $*" >&2; }
run_prd_change_reviewer() { echo "pass"; }
run_change_with_reviewer_retry() { echo "pass"; }
run_healing_recorder() { :; }
check_healing_effectiveness() { :; }
check_syntax_class_error() { :; }
check_failure_diversity() { :; }
${helperBody}
${fnBody}
run_failure_analyst "SKY-004-test" "/dev/null" "0"
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15_000 });
      const toolWritten = existsSync(join(dir, '.epam/dynamic-tools/rerun-tests.sh'));
      return { output, toolWritten };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a tool_spec whose recipe re-invokes the project\'s own test command is rejected and NOT written to disk', () => {
    const { output, toolWritten } = runWithStub(
      JSON.stringify({
        diagnosis: 'Build must run before tests',
        target: 'tool',
        tool_spec: {
          name: 'rerun-tests',
          purpose: 'ensure the build runs before tests',
          recipe: 'npm run build && npm test',
        },
        reason: 'Avoids stale build artifacts',
      }),
      'npm test',
    );
    expect(toolWritten).toBe(false);
    expect(output).toMatch(/re-invokes this project's own test command/);
  });

  it('a tool_spec whose recipe performs only its own distinct mechanical step IS written to disk', () => {
    const { toolWritten } = runWithStub(
      JSON.stringify({
        diagnosis: 'Build must run before tests',
        target: 'tool',
        tool_spec: {
          name: 'rerun-tests',
          purpose: 'ensure the build runs before tests',
          recipe: 'npm run build',
        },
        reason: 'Avoids stale build artifacts',
      }),
      'npm test',
    );
    expect(toolWritten).toBe(true);
  });
});
