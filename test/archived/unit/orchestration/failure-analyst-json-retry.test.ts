/**
 * Live-run defect (run #13, 2026-07-03): "Could not parse JSON from analyst
 * response — proceeding with retry as-is" fired on SKY-004's final attempt.
 * Before this fix, a single malformed gate-model response threw away the
 * failure-analyst's entire diagnosis for that retry — the coordinator got no
 * structural guidance at all, even though a second call to the same model
 * might easily have returned a parseable response.
 *
 * Fix: the gate-model call + JSON extraction in run_failure_analyst() now runs
 * in a loop of up to 3 attempts. It only retries when the JSON extraction
 * fails (not when the LLM call itself fails to execute — that's a separate,
 * unretried failure mode with its own warning). Static structural checks plus
 * a REAL bash execution against a stub ai-run.sh that returns garbage twice
 * before returning valid JSON on the 3rd call.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionAnalystPrompt, analystPromptEnv } from '../../helpers/analyst-prompt';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('claude.sh — run_failure_analyst retries on unparseable JSON', () => {
  const fnStart = claudeSrc.indexOf('run_failure_analyst() {');
  const fnEnd = claudeSrc.indexOf('\n}', fnStart + 50);
  const body = claudeSrc.slice(fnStart, fnEnd);

  it('sets a max attempt count of 3', () => {
    expect(body).toMatch(/_analyst_max_attempts=3/);
  });

  it('loops the gate-model call while attempts remain', () => {
    expect(body).toMatch(/while \[ "\$_analyst_attempt" -le "\$_analyst_max_attempts" \]/);
  });

  it('breaks out of the retry loop as soon as valid JSON is extracted', () => {
    const loopIdx = body.indexOf('while [ "$_analyst_attempt"');
    const loopEnd = body.indexOf('\n    done', loopIdx);
    const loopBody = body.slice(loopIdx, loopEnd);
    expect(loopBody).toMatch(/jq empty 2>\/dev\/null; then\s*\n\s*break/);
  });

  it('logs a distinct retry warning (not the final give-up warning) between attempts', () => {
    expect(body).toMatch(/retrying gate call \(attempt/);
  });

  it('only retries on parse failure, not on the gate-model call itself failing (separate warning path)', () => {
    expect(body).toMatch(/Gate model call failed — proceeding with retry as-is/);
    // The "call failed" case sets _analyst_call_ok=false and does NOT re-invoke ai-run.sh
    // within the same loop iteration's parse-retry branch.
    const callFailIdx = body.indexOf('_analyst_call_ok="false"');
    expect(callFailIdx).toBeGreaterThan(-1);
  });

  it('final give-up warning reports the actual attempt count used, not a hardcoded number', () => {
    expect(body).toMatch(/after \$\{_analyst_max_attempts\} attempts/);
  });
});

describe('run_failure_analyst — REAL execution: recovers from 2 unparseable responses before a 3rd valid one', () => {
  function runWithStub(responses: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'analyst-json-retry-test-'));
    try {
      const countFile = join(dir, 'call-count');
      writeFileSync(countFile, '0');
      const responsesFile = join(dir, 'responses.txt');
      // Separate stub responses with a unique delimiter since responses may be multi-line
      writeFileSync(responsesFile, responses.join('\n%%%DELIM%%%\n'));

      const aiRunPath = join(dir, 'ai-run.sh');
      writeFileSync(
        aiRunPath,
        `#!/usr/bin/env bash
cat > /dev/null
n=$(cat "${countFile}")
n=$((n + 1))
echo "$n" > "${countFile}"
awk -v RS='%%%DELIM%%%' -v n="$n" 'NR==n' "${responsesFile}" | sed '/^$/d' | head -c 2000
`,
      );
      chmodSync(aiRunPath, 0o755);

      const fnStart = claudeSrc.indexOf('run_failure_analyst() {');
      const fnEnd = claudeSrc.indexOf('\n}', fnStart + 50);
      const fnBody = claudeSrc.slice(fnStart, fnEnd + 2);

      provisionAnalystPrompt(dir);

      const script = `
exec 2>&1
SCRIPT_DIR="${dir}"
${analystPromptEnv(dir)}
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="fake-model"
MAIN_PRD_FILE=""
PRD_FILE="${dir}/prd.json"
VERIFICATION_FAILURE="TypeError: cannot read property 'x' of undefined"
warning() { echo "WARN: $*" >&2; }
log() { echo "LOG: $*" >&2; }
run_prd_change_reviewer() { echo "pass"; }
run_healing_recorder() { :; }
check_healing_effectiveness() { :; }
jq() { command jq "$@" 2>/dev/null || echo "null"; }
echo '{"stories":[{"id":"SKY-004","agentRole":"typescript-engineer","acceptanceCriteria":[]}]}' > "${dir}/prd.json"
${fnBody}
run_failure_analyst "SKY-004" "/dev/null" "0"
echo "DIAGNOSIS_AMENDMENT=[$COORDINATOR_PROMPT_AMENDMENT]"
echo "CALL_COUNT=$(cat "${countFile}")"
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      return execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('extracts the diagnosis from the 3rd attempt after 2 garbage responses', () => {
    const output = runWithStub([
      'not json at all, just prose explaining nothing useful',
      '{"incomplete": tr',
      '{"diagnosis":"Off-by-one in loop bound","target":"none","reason":"transient mistake"}',
    ]);
    expect(output).toContain('CALL_COUNT=3');
    expect(output).toContain('Off-by-one in loop bound');
  });

  it('gives up after 3 attempts and proceeds without analyst guidance when all 3 are unparseable', () => {
    const output = runWithStub([
      'garbage one',
      'garbage two',
      'garbage three, still no json here',
    ]);
    expect(output).toContain('CALL_COUNT=3');
    expect(output).toContain('WARN: ');
    expect(output).toMatch(/Could not parse JSON from analyst response after 3 attempts/);
  });
});
