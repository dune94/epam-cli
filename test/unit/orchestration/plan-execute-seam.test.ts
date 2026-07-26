/**
 * Every agent plans before it answers.
 *
 * Live metrolinx runs 8 and 9, same ticket, same model, temperature 0. The
 * detective explored the IDENTICAL eight files and hit the identical tool
 * budget; the logs are byte-identical for 282 of 283 lines. Then run 8 named
 * the function that computes the discount and run 9 named the function that
 * displays it — a pass-through whose whole body copies a value.
 *
 * There was nothing in between. The agent explored and answered in one breath,
 * so no stage existed at which "I am going to blame the mapper" could be read,
 * checked against the prompt's own requirement (why THIS computes the value,
 * not just displays it), and rejected before it became the plan of record.
 *
 * A plan pass makes the reasoning an artefact instead of an interior event. The
 * agent states its hypothesis and targets, that statement is recorded, and only
 * then does it produce the answer — with its own plan in front of it.
 *
 * This lives at ai-run.sh because every agent in the pipeline goes through it:
 * run-agent-orchestration.sh, claude.sh, team-lead-review.sh, the repro-test
 * writer, the analysts, the QA gates, and spec-mode-runner.js. One seam, so no
 * agent can be quietly left behind — the failure mode of the thirty-seven
 * call-site edits this replaces.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AI_RUN = join(__dirname, '../../../orchestrations/scripts/ai-run.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Runs ai-run.sh against a stub `epam` CLI that records every prompt it is
 * given and replies with canned text, so the seam's real control flow is
 * exercised without a model call.
 */
function run(opts: { replies?: string[]; env?: Record<string, string>; prompt?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-exec-'));
  dirs.push(dir);

  const calls = join(dir, 'calls');           // one prompt file per invocation
  const replies = opts.replies ?? ['PLAN: inspect the service that computes it', 'FINAL ANSWER'];
  const stub = join(dir, 'epam');
  writeFileSync(stub, `#!/usr/bin/env bash
mkdir -p ${JSON.stringify(calls)}
n=$(ls ${JSON.stringify(calls)} | wc -l | tr -d ' ')
cat > ${JSON.stringify(calls)}/$n.prompt
case "$n" in
${replies.map((r, i) => `  ${i}) printf '{"result":%s,"total_cost_usd":0.5,"tokens":100}\\n' ${JSON.stringify(JSON.stringify(r))} ;;`).join('\n')}
  *) printf '{"result":"extra","total_cost_usd":0.5,"tokens":100}\\n' ;;
esac
`);
  chmodSync(stub, 0o755);

  const jsonOut = join(dir, 'result.json');
  const r = spawnSync('bash', [AI_RUN, '--provider', 'qwen', '--model', 'z-ai/glm-5.2'], {
    input: opts.prompt ?? 'Find the broken line.',
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ORCH_JSON_RESULT: jsonOut,
      EPAM_AGENT_NAME: 'code-graph-detective',
      ...(opts.env ?? {}),
    },
  });

  const prompts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const f = join(calls, `${i}.prompt`);
    if (existsSync(f)) prompts.push(readFileSync(f, 'utf8'));
  }
  return {
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: r.stderr || '',
    prompts,
    json: existsSync(jsonOut) ? JSON.parse(readFileSync(jsonOut, 'utf8') || '{}') : null,
  };
}

describe('the seam plans, then executes', () => {
  it('calls the model twice — once to plan, once to answer', () => {
    expect(run().prompts.length,
      'the agent still explores and answers in a single breath, with no ' +
      'inspectable stage in between').toBe(2);
  });

  it('asks the first call for a plan, not an answer', () => {
    const p = run().prompts[0] ?? '';
    expect(p, 'the first call is not a planning call').toMatch(/plan|hypothesis|before you answer/i);
  });

  it('puts the plan in front of the agent when it answers', () => {
    const p = run().prompts[1] ?? '';
    expect(p, 'the execute pass cannot see its own plan, so the plan changes nothing')
      .toContain('inspect the service that computes it');
  });

  it('keeps the original prompt in the execute pass', () => {
    expect(run({ prompt: 'Find the broken line in apply-report-discounts.' }).prompts[1] ?? '')
      .toContain('apply-report-discounts');
  });

  it('returns the ANSWER, never the plan', () => {
    const r = run();
    expect(r.stdout).toContain('FINAL ANSWER');
    expect(r.stdout, 'the plan leaked into the output the caller parses')
      .not.toContain('PLAN: inspect');
  });
});

describe('it cannot become a new way to fail', () => {
  it('still answers when the planning call fails', () => {
    // A dead planning call must degrade to today's behaviour, not to no answer.
    const r = run({ replies: [] , env: { PLAN_STUB_FAIL: '1' } });
    expect(r.code, 'a failed plan pass killed the whole invocation').toBe(0);
  });

  it('does not recurse — the planning call is not itself planned', () => {
    expect(run().prompts.length).toBe(2);
  });

  it('can be turned off', () => {
    expect(run({ env: { EPAM_PLAN_EXECUTE: '0' } }).prompts.length).toBe(1);
  });
});

describe('cost stays truthful', () => {
  it('reports the cost of BOTH calls, not just the answer', () => {
    // Real billed cost is the pipeline's first-priority signal. A plan pass that
    // bills but is not counted makes every run look cheaper than it was.
    const r = run();
    expect(r.json?.total_cost_usd,
      'the planning call billed real money and was not counted').toBe(1.0);
  });

  it('still emits a single result object for the caller', () => {
    expect(typeof run().json?.result).toBe('string');
  });
});
