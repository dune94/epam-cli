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

/**
 * A plan nobody can read is a plan that cannot be judged.
 *
 * The seam builds a plan, feeds it to the execute pass, and discarded it. So we
 * could see THAT two calls happened — cost, latency — but never WHAT any agent
 * intended. That is most of the value: runs 8 and 9 produced byte-identical
 * logs and different answers, and without the plans there is nothing to compare.
 *
 * Two readers, because they fail independently: Langfuse (rich, but off in
 * mock1 and in any run without LANGFUSE_* configured) and a plain JSONL file
 * that always exists.
 */
describe('the plan is observable', () => {
  it('labels the planning call distinctly for tracing', () => {
    // Both passes inherit EPAM_AGENT_NAME, so Langfuse showed two identical
    // traces per agent with no way to tell plan from answer.
    const r = run({ env: { EPAM_AGENT_NAME: 'code-graph-detective' } });
    expect(r.prompts.length).toBe(2);
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/ai-run.sh'), 'utf8');
    expect(src, 'the plan pass is indistinguishable from the answer in tracing')
      .toMatch(/EPAM_AGENT_NAME="?\$\{?EPAM_AGENT_NAME[^\n]*:plan/);
  });

  it('writes the plan to a file, since Langfuse is often off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-log-'));
    dirs.push(dir);
    const r = run({ env: { LOG_DIR: dir, PHASE: 'core', EPAM_AGENT_NAME: 'code-graph-detective' } });
    expect(r.prompts.length).toBe(2);
    const f = join(dir, 'plans-core.jsonl');
    expect(existsSync(f), 'no plan record was written').toBe(true);
    const rec = JSON.parse(readFileSync(f, 'utf8').trim().split('\n')[0]);
    expect(rec.agent).toBe('code-graph-detective');
    expect(rec.plan, 'the plan text itself was not recorded')
      .toContain('inspect the service that computes it');
  });

  it('does not fail the call when the plan cannot be written', () => {
    const r = run({ env: { LOG_DIR: '/nonexistent-xyz/nope', PHASE: 'core' } });
    expect(r.code, 'an unwritable log directory broke the agent call').toBe(0);
    expect(r.stdout).toContain('FINAL ANSWER');
  });
});

/**
 * The plan must not repeat the exploration it exists to precede.
 *
 * The first cut inherited EPAM_ALLOWED_TOOLS and EPAM_MAX_TOOL_CALLS unchanged,
 * so the detective explored TWICE — seven tool calls to plan, seven more to
 * answer. Double the cost and latency for work already done, and the mock1
 * rerun was ~40% behind the previous run at the same step.
 *
 * Worse, the agent timeout wraps the whole ai-run.sh invocation, which is now
 * both passes. An agent that took 200s had 360s; now it needs ~400s and is
 * killed at 360 — plan-execute would manufacture timeouts that look like model
 * failures.
 *
 * So the plan pass gets no tools and its own short deadline. The detective
 * prompt already carries pre-seeded CodeGraph output, so a hypothesis can be
 * formed without spending a call — and a plan made BEFORE looking is the more
 * useful artefact, because the answer can be checked against it. The execute
 * pass keeps its full budget and is told to abandon the plan if what it finds
 * contradicts it.
 */
describe('planning is cheap by construction', () => {
  it('gives the planning call no tools', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/ai-run.sh'), 'utf8');
    const i = src.indexOf('_EPAM_IN_PLAN_PASS=1');
    expect(i, 'the plan pass is not marked').toBeGreaterThan(-1);
    const block = src.slice(i, i + 700);
    expect(block, 'the plan pass inherits the tool budget and explores twice')
      .toMatch(/EPAM_MAX_TOOL_CALLS=(")?0/);
    expect(block, 'the plan pass inherits tool permissions')
      .toMatch(/EPAM_ALLOWED_TOOLS=/);
  });

  it('bounds the planning call so it cannot eat the execute budget', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/ai-run.sh'), 'utf8');
    const i = src.indexOf('_EPAM_IN_PLAN_PASS=1');
    expect(src.slice(Math.max(0, i - 400), i + 700),
      'a hung planning call consumes the whole agent deadline')
      .toMatch(/timeout\s+"?\$\{?EPAM_PLAN_TIMEOUT_SECS/);
  });

  it('tells the execute pass it may abandon a wrong plan', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/ai-run.sh'), 'utf8');
    expect(src, 'the agent is bound to a plan it made before looking')
      .toMatch(/showed it to be wrong|abandon/i);
  });

  it('still produces a plan and an answer with tools disabled', () => {
    const r = run();
    expect(r.prompts.length).toBe(2);
    expect(r.stdout).toContain('FINAL ANSWER');
  });
});

/**
 * An anonymous plan is barely worth recording.
 *
 * The first live run wrote its plans to `plans-unknown.jsonl`, with empty
 * `agent` and `story` fields — because PHASE is never exported, and most
 * spec-mode agents never set EPAM_AGENT_NAME (only the detective does). So the
 * records existed but could not be attributed, and Langfuse showed `agent:plan`
 * instead of the agent's real name — blunting the very labelling that makes
 * plan and answer comparable.
 */
describe('a plan can be attributed', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('exports PHASE, so plans are filed under the phase that produced them', () => {
    expect(ORCH, 'PHASE never reaches ai-run.sh, so every plan files as "unknown"')
      .toMatch(/^export PHASE$/m);
  });

  it('names every spec-mode agent, not only the detective', () => {
    const SPEC = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    // Named from the costAgent label each call already declares, in runClaude —
    // one place, so a new agent cannot be added without a name.
    expect(SPEC, "agents are named per-call-site, so any site that forgets is anonymous")
      .toMatch(/EPAM_AGENT_NAME\s*=\s*opts\.costAgent/);
    expect(SPEC, 'the story is not carried onto the plan record either')
      .toMatch(/EPAM_STORY_ID\s*=\s*opts\.costStoryId/);
  });
});
