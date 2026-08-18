/**
 * STEP 3.545 RUNS THE ONLY AGENT IN THE PIPELINE GRANTED WRITE ACCESS TO PRE-EXISTING TESTS.
 *
 * Those tests are the codeline's accumulated oracle. If this agent edits one wrongly, the signal
 * that a fix is broken is destroyed permanently and silently, and every gate downstream sees
 * green. Its whole safety property is that it edits a test ONLY when the failure is explained by
 * the story's Verification Criteria.
 *
 * The prompt carrying that property — "Case (b) matters more than case (a) ... When in doubt,
 * choose (b)" — was a heredoc in a shell script. The most consequential prompt in the run was the
 * one no prompt review could reach and no prompt diff would show.
 *
 * And the criteria it judges against had a DEFAULT: the prompt rendered "(not supplied)" when the
 * story carried none. So the agent could be asked whether a failure was explained by the intended
 * change without being told what the intended change was, while holding the write grant — exactly
 * the path by which a wrong fix rewrites its own oracle to go green.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const UIT = join(SCRIPTS, 'update-invalidated-tests.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const ENGINE = join(SCRIPTS, 'lib/engine-prompt.js');

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

function render(values: Record<string, string>): { status: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['-e',
    'const {renderEngineTemplate}=require(process.argv[1]);'
    + 'process.stdout.write(renderEngineTemplate("update-invalidated-tests",JSON.parse(process.argv[2])));',
    ENGINE, JSON.stringify(values),
  ], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const FULL = {
  __PREEXISTING_TESTS__: 'src/fare.test.ts',
  __VERIFICATION_CRITERIA__: '- an adult fare in zone 2 is 3.75',
  __FIX_DIFF__: '--- a/src/fare.ts\n+++ b/src/fare.ts',
  __FAILING_OUTPUT__: 'FAIL src/fare.test.ts > expected 3.50',
};

describe('the only agent that edits existing tests', () => {
  it('takes its prompt from the template layer, not from a heredoc', () => {
    const body = code(UIT);
    expect(body, 'the prompt is still written in the shell script')
      .not.toContain('You are updating tests that a COMMITTED bug fix');
    expect(body, 'the prompt is no longer rendered').toMatch(/render_engine_prompt update-invalidated-tests/);
  });

  it('the rendered prompt still carries the rule that stops a broken fix going green', () => {
    // Executed, not grepped from the template file: this is the instruction the whole step rests
    // on, and it must survive rendering.
    const r = render(FULL);
    expect(r.status, `the prompt did not render: ${r.err}`).toBe(0);
    expect(r.out, 'the bias toward REGRESSION is gone').toMatch(/When in doubt, choose \(b\)/);
    expect(r.out, 'nothing forbids rewriting the run’s own new test').toMatch(/must NEVER be rewritten here/);
    expect(r.out, 'the write scope is no longer stated').toContain('src/fare.test.ts');
  });

  it('the verification criteria have NO default — the render fails without them', () => {
    // The hole: "(not supplied)" let the agent judge against nothing while holding write access.
    const { __VERIFICATION_CRITERIA__, ...missing } = FULL;
    const r = render(missing as Record<string, string>);
    expect(r.status, 'a prompt with no oracle still renders, so the agent can still be invoked')
      .not.toBe(0);
  });

  it('the script refuses before invoking when the story has no criteria', () => {
    const body = code(UIT);
    expect(body, 'the script no longer refuses on absent criteria')
      .toMatch(/-z "\$\{STORY_VERIFICATION_CRITERIA:-\}"/);
    expect(body, '"(not supplied)" is back — the agent would judge against nothing')
      .not.toContain('(not supplied)');
  });

  it('the caller skips a story with no criteria rather than passing empty ones', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('_uit_vcs=');
    expect(i, 'the 3.545 call site is gone').toBeGreaterThan(-1);
    expect(src.slice(i, i + 900), 'a story with no criteria is still handed to the agent')
      .toMatch(/-z "\$_uit_vcs"/);
  });

  it('records what it spends', () => {
    // Real cost tracking: without ORCH_JSON_RESULT ai-run.sh writes no normalized result, so this
    // agent spent money and appeared in no cost report.
    const body = code(UIT);
    expect(body, 'the call still captures no cost').toMatch(/ORCH_JSON_RESULT=/);
    expect(body, 'the captured result is never turned into a cost record').toMatch(/emit-cost\.js/);
  });

  it('a failed agent is not read as "nothing to change"', () => {
    const body = code(UIT);
    expect(body, 'the agent’s failure is still swallowed into an empty reply')
      .not.toMatch(/bash "\$AI_RUNNER_CMD" 2>"\$_agent_log" \|\| echo ""/);
    expect(body).toMatch(/_uit_rc/);
  });

  it('no branch name is guessed at the call site', () => {
    const body = code(ORCH);
    const i = body.indexOf('_uit_baseline=');
    expect(i, 'the baseline resolution is gone').toBeGreaterThan(-1);
    expect(body.slice(i - 200, i + 800), 'a branch name is hardcoded again')
      .not.toMatch(/JIRA_BASELINE_BRANCH:-(develop|main|master)/);
  });
});
