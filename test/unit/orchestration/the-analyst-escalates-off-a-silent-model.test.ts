/**
 * RETRYING A MODEL THAT SAID NOTHING IS NOT A RECOVERY STRATEGY.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * run_failure_analyst picks its model once and never reconsiders:
 *
 *     local gate_model="${ESCALATION_MODEL:-${ORCH_GATE_MODEL:-}}"
 *
 * One fixed value. Its own profile in invocation-profiles.json declares
 * `impl-failure-analyst: { "ladder": "high" }`, and the function never reads it. So when the
 * model returns nothing, the retry loop calls THE SAME MODEL twice more and then gives up.
 *
 * LIVE 2026-08-12: the analyst returned 0-byte responses on roughly half its first calls. One
 * call burned all three attempts on z-ai/glm-5.2 and produced no diagnosis at all, so that
 * writer retry ran with no corrective guidance. Three identical calls to a silent endpoint is
 * the definition of a gamble the ladder exists to avoid.
 *
 * Nothing new is needed. agent_ladder_model(model, tier) already resolves the next rung
 * from EPAM_MODEL_LADDER_<TIER>, claude.sh's own loader exports those from llm-settings.json,
 * and the `high` ladder already contains exactly the hop required:
 *
 *     z-ai/glm-5.2 -> moonshotai/kimi-k3
 *
 * SCOPE. This escalates the ANALYST when the ANALYST fails. It must not touch the writer's
 * rung: the writer is not the thing that failed, and moving it would spend the story's
 * escalation budget on a diagnostic problem.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));

function analystFn(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('run_failure_analyst() {');
  expect(start, 'run_failure_analyst is gone — the test is stale').toBeGreaterThan(-1);
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const code = () => analystFn().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** Run the REAL agent_ladder_model against the REAL project ladder. */
function step(model: string, tier: string): string {
  // THE SHARED HANDLER, sourced from the library that defines it. The analyst stopped carrying
  // its own escalation step -- it climbs through lib/agent-ladder.sh like every other agent now
  // -- so extracting a function body out of claude.sh finds nothing to extract.
  const fn = `. ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/agent-ladder.sh'))}`;
  const chain = (t: string) => (CFG.ladders[t]?.modelLadder || [])
    .map((p: any) => `${p.from}=${p.to}`).join('|');
  const script = [
    'warning() { :; }',
    `EPAM_MODEL_LADDER_HIGH='${chain('high')}'`,
    `EPAM_MODEL_LADDER_MEDIUM='${chain('medium')}'`,
    `EPAM_MODEL_LADDER_HIGHEST='${chain('highest')}'`,
    fn,
    `agent_ladder_model '${model}' '${tier}'`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe('the machinery already exists — this reuses it, it does not reinvent it', () => {
  // THE LADDER THE ANALYST ACTUALLY CLIMBS, asked of the data.
  //
  // These called a two-argument step(model, tier). The analyst climbs through the shared
  // handler now, whose signature is (agent, story, model) and whose rung count comes off disk —
  // so the old call resolved nothing and the assertion failed for a reason unrelated to the
  // ladder's contents. What was being asked is a question about the project's declared rungs,
  // and it is asked of them directly. It no longer names a tier either: the profile declares a
  // POSITION, and which tier that is belongs to the project.
  const analystChain = (): Array<{ from: string; to: string }> => {
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { resolveTierPosition } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    const tier = resolveTierPosition(reg.profiles['impl-failure-analyst'].ladder, {
      EPAM_MODEL_LADDER_TIER_ORDER: (CFG.ladderTierOrder || []).join(' '),
    });
    expect(tier, "the analyst's declared position resolves to no tier this project declares").toBeTruthy();
    return CFG.ladders[tier].modelLadder;
  };

  it('the analyst has somewhere to escalate to', () => {
    const chain = analystChain();
    expect(chain.length, 'the analyst has nowhere to escalate to — one bad answer ends the diagnosis')
      .toBeGreaterThan(0);
  });

  it('exhaustion is expressible — the chain has a top with no hop off it', () => {
    // Every rung's destination that is itself never a source. Without one the walk could never
    // terminate, and "exhausted" would be unreachable.
    const chain = analystChain();
    const sources = new Set(chain.map((r) => r.from));
    expect(chain.some((r) => !sources.has(r.to)), 'every model hops onward, so the top is unreachable')
      .toBe(true);
  });

  it('the analyst profile declares its tier', () => {
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    // HIGHEST since 2026-08-12: this analyst diagnoses why an attempt failed and its answer
    // drives model escalation, so it runs on the strongest ladder — and it now has tools, so
    // it can actually look at the code it is diagnosing.
    // 'top', the POSITION. The engine holds no tier vocabulary, so naming metrolinx's top tier
    // here would make the assertion false for any project that calls its tiers something else.
    expect(String(reg.profiles['impl-failure-analyst'].ladder).toLowerCase()).toBe('top');
  });
});

describe('THE ANALYST ESCALATES WHEN THE ANALYST FAILS', () => {
  it('THE DEFECT: it no longer retries the same model unconditionally', () => {
    expect(code(), 'the retry loop still calls one fixed gate_model every time')
      .toMatch(/agent_ladder_model/);
  });

  it('the escalation happens inside the analyst retry loop', () => {
    const c = code();
    const loopStart = c.indexOf('_analyst_attempt');
    const loopEnd = c.indexOf('_analyst_call_ok" = "true"');
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(c.slice(loopStart, loopEnd), 'the step is resolved outside the retry loop')
      .toMatch(/agent_ladder_model/);
  });

  it('it steps the ANALYST model, not the story model', () => {
    const c = code();
    const i = c.indexOf('agent_ladder_model');
    const call = c.slice(i, i + 200);
    expect(call, 'it is stepping the wrong model').toMatch(/gate_model/);
    expect(call, 'the writer must not be escalated for a diagnostic failure')
      .not.toMatch(/STORY_MODEL/);
  });

  it('the escalation is announced with both models', () => {
    // A silent model swap makes the next failure unattributable.
    expect(code()).toMatch(/FailureAnalyst\].*escalat/i);
  });

  it('exhaustion is handled — no empty model is ever invoked', () => {
    // agent_ladder_model returns "" at the top of the ladder. Assigning that to gate_model
    // would invoke with no model at all, which fails in a new and more confusing way.
    const c = code();
    const i = c.indexOf('agent_ladder_model');
    // Matches the guard on whatever the next-model variable is called, rather than on the two
    // names it happened to have when this was written.
    expect(c.slice(i, i + 400), 'an empty step result is assigned without a guard')
      .toMatch(/-n "\$\{?_?[a-z_]*(next|escalated)/i);
  });
});

describe('THE WRITER IS UNTOUCHED', () => {
  it('the analyst path never assigns STORY_MODEL', () => {
    const c = code();
    expect(c, 'a diagnostic failure moved the writer up the ladder').not.toMatch(/^\s*STORY_MODEL=/m);
  });
});
