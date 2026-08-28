/**
 * ONE RUNG PER FAILED ANALYST ATTEMPT.
 *
 * run_failure_analyst escalates in two places, and both were live on the same failure.
 *
 *   the unusable-answer branch   fires when the response could not be parsed
 *   the call-failure branch      fires when analyst_json is empty
 *
 * The first branch sets `analyst_json=""` three lines before it runs. So its own condition
 * GUARANTEES the second branch's condition, and every unparseable answer recorded two failures
 * and stepped the ladder twice. The analyst reached the top of its chain in half the attempts
 * it was configured for, and then reported "ladder exhausted" while attempts remained.
 *
 * Deleting one is wrong: the second branch is the only escalation on the path where the CALL
 * failed and the first never runs. They have to be exclusive, not merged.
 *
 * This executes the REAL function out of the shipped claude.sh against a stubbed runner, and
 * counts the rungs on disk. A source-text check could not tell a live duplicate from a
 * commented-out one — which is exactly how the duplicate survived being noticed once already,
 * in a comment that says the escalation is "a few lines above".
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionAnalystPrompt, analystPromptEnv } from '../../helpers/analyst-prompt';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const LADDER_LIB = join(ROOT, 'orchestrations/scripts/lib/agent-ladder.sh');

/** The shipped function body, brace-matched — never a restatement of it. */
function extractFn(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf(`${name}() {`);
  expect(start, `${name} not found in claude.sh`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is unbalanced`);
}

/**
 * Run one analyst cycle whose every attempt fails, and report how many rungs were recorded.
 *
 * `mode` picks WHICH failure: an answer that arrives but cannot be parsed (the branch that
 * double-stepped), or a call that fails outright (the branch that must still step alone).
 */
function rungsRecordedFor(mode: 'unparseable' | 'call-fails'): { rungs: number; attempts: number } {
  const dir = mkdtempSync(join(tmpdir(), 'analyst-rungs-'));
  try {
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });

    // A runner that never yields usable JSON. Prose for the parse path; a non-zero exit for the
    // call path. Either way the loop must climb exactly one rung per attempt.
    const runner = join(dir, 'ai-run.sh');
    // It also RECORDS each call. Comparing rungs against a guessed attempt count is what let
    // the first version of this test pass under the very mutation it exists to catch: with two
    // attempts, the buggy two-rungs-per-failure still landed under a hardcoded ceiling of three.
    // The only sound comparison is against the attempts that actually happened.
    const calls = join(dir, 'calls');
    const body = mode === 'unparseable'
      ? 'echo "I was unable to determine the cause."'
      : 'exit 1';
    writeFileSync(runner, `#!/usr/bin/env bash\ncat > /dev/null\necho x >> ${JSON.stringify(calls)}\n${body}\n`);

    // The function builds its prompt through prompt-library before it calls anything, so
    // without a provisioned prompt it exits before the retry loop and records no rung at all.
    provisionAnalystPrompt(dir);
    // PRD: the analyst reads the story it is diagnosing.
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{ id: 'S-RUNGS', agentRole: 'test-engineer', acceptanceCriteria: ['it works'], dependencies: [] }],
    }));

    const script = join(dir, 'run.sh');
    writeFileSync(script, `
set -uo pipefail
exec 2>&1
LOG_DIR=${JSON.stringify(logDir)}
export LOG_DIR
SCRIPT_DIR=${JSON.stringify(dir)}
${analystPromptEnv(dir)}
PROJECT_ROOT=${JSON.stringify(dir)}
PRD_FILE=${JSON.stringify(prd)}
MAIN_PRD_FILE=""
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="m0"
VERIFICATION_FAILURE="something failed"
# Everything the invocation line references. Under set -u an unset one fails the whole command
# substitution, which sends every attempt down the CALL-FAILED path -- so the stub is never
# reached and the parse path this test is about is never exercised at all.
EPAM_CLI="true"
ORCH_GATE_ALLOWED_TOOLS=""
output_file=${JSON.stringify(join(dir, 'analyst.out'))}
FAILURE_ANALYST_MAX_TOOL_CALLS="1"
. ${JSON.stringify(LADDER_LIB)}

# The ladder this seam climbs, with room for more rungs than attempts — so running out is never
# what limits the count, and a double-step shows up as a count rather than as exhaustion.
export EPAM_MODEL_LADDER="m0=m1|m1=m2|m2=m3|m3=m4|m4=m5"
export EPAM_MODEL_LADDER_TIER_ORDER="low mid top"

warning() { :; }
log()     { :; }
error()   { echo "ERR: $*" >&2; }
run_prd_change_reviewer()   { echo "pass"; }
run_healing_recorder()      { :; }
check_healing_effectiveness() { :; }
record_agent_activity()     { :; }

gate_model="m0"
story_id="S-RUNGS"
${extractFn('run_failure_analyst')}
run_failure_analyst "S-RUNGS" "/dev/null" "0" >/dev/null 2>&1 || true
`);
    spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });

    const attempts = existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
    const stateDir = join(logDir, 'agent-ladder');
    if (!existsSync(stateDir)) return { rungs: 0, attempts };
    // Whatever key the function used — the point is how many rungs, not what it was filed under.
    const rungs = readdirSync(stateDir)
      .map((n) => Number(readFileSync(join(stateDir, n), 'utf8').trim()) || 0)
      .reduce((a, b) => a + b, 0);
    return { rungs, attempts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the analyst climbs one rung per failed attempt', () => {
  it('is not vacuous — the function really is exercised and really does record rungs', () => {
    // If the harness recorded nothing, every count below would be 0 and "no double-step" would
    // pass while proving the opposite of what it claims.
    const { rungs, attempts } = rungsRecordedFor('unparseable');
    expect(attempts, 'the stub runner was never called — the harness never reached the retry loop')
      .toBeGreaterThan(1);
    expect(rungs, 'no rungs recorded at all — the harness never reached the ladder').toBeGreaterThan(0);
  });

  it('an unparseable answer costs ONE rung, not two', () => {
    const { rungs, attempts } = rungsRecordedFor('unparseable');
    // Every attempt but the last escalates: the last has nowhere to go.
    expect(
      rungs,
      'both escalation branches fired on the same failure: the unusable-answer branch sets ' +
      'analyst_json="" immediately before running, which is exactly the call-failure branch\'s ' +
      'condition. The analyst reached the top of its chain in half its attempts and then ' +
      'reported exhaustion with attempts still to spend.',
    ).toBe(attempts - 1);
  });

  it('a failed CALL still costs one rung — the second branch is not dead', () => {
    // The branch that must NOT simply be deleted: on this path the first branch never runs, and
    // without the second the analyst would re-ask a model that could not be reached at all.
    expect(
      rungsRecordedFor('call-fails').rungs,
      'a failing call recorded no rung, so the analyst re-asks an unreachable model until its ' +
      'attempts are gone',
    ).toBeGreaterThan(0);
  });
});
