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
 * Nothing new is needed. get_model_ladder_step(model, tier) already resolves the next rung
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

/** Run the REAL get_model_ladder_step against the REAL project ladder. */
function step(model: string, tier: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('get_model_ladder_step() {');
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fn = src.slice(start, end).replace(/\blocal /g, '');
  const chain = (t: string) => (CFG.ladders[t]?.modelLadder || [])
    .map((p: any) => `${p.from}=${p.to}`).join('|');
  const script = [
    'warning() { :; }',
    `EPAM_MODEL_LADDER_HIGH='${chain('high')}'`,
    `EPAM_MODEL_LADDER_MEDIUM='${chain('medium')}'`,
    `EPAM_MODEL_LADDER_HIGHEST='${chain('highest')}'`,
    fn,
    `get_model_ladder_step '${model}' '${tier}'`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe('the machinery already exists — this reuses it, it does not reinvent it', () => {
  it('the project ladder contains the hop the analyst needs', () => {
    expect(step('z-ai/glm-5.2', 'high'), 'the analyst has nowhere to escalate to')
      .toBe('moonshotai/kimi-k3');
  });

  it('a model at the top of the ladder yields nothing — exhaustion is expressible', () => {
    expect(step('moonshotai/kimi-k3', 'high')).toBe('');
  });

  it('the analyst profile declares its tier', () => {
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    expect(reg.profiles['impl-failure-analyst'].ladder).toBe('high');
  });
});

describe('THE ANALYST ESCALATES WHEN THE ANALYST FAILS', () => {
  it('THE DEFECT: it no longer retries the same model unconditionally', () => {
    expect(code(), 'the retry loop still calls one fixed gate_model every time')
      .toMatch(/get_model_ladder_step/);
  });

  it('the escalation happens inside the analyst retry loop', () => {
    const c = code();
    const loopStart = c.indexOf('_analyst_attempt');
    const loopEnd = c.indexOf('_analyst_call_ok" = "true"');
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(c.slice(loopStart, loopEnd), 'the step is resolved outside the retry loop')
      .toMatch(/get_model_ladder_step/);
  });

  it('it steps the ANALYST model, not the story model', () => {
    const c = code();
    const i = c.indexOf('get_model_ladder_step');
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
    // get_model_ladder_step returns "" at the top of the ladder. Assigning that to gate_model
    // would invoke with no model at all, which fails in a new and more confusing way.
    const c = code();
    const i = c.indexOf('get_model_ladder_step');
    expect(c.slice(i, i + 400), 'an empty step result is assigned without a guard')
      .toMatch(/-n "\$?\{?_?(next|escalated)/i);
  });
});

describe('THE WRITER IS UNTOUCHED', () => {
  it('the analyst path never assigns STORY_MODEL', () => {
    const c = code();
    expect(c, 'a diagnostic failure moved the writer up the ladder').not.toMatch(/^\s*STORY_MODEL=/m);
  });
});
