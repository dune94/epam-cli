/**
 * spec-mode-runner must emit cost for the agents it drives.
 *
 * ESCAPED DEFECT (measured live, AMSD-1820 2026-07-24): `cost_snapshot` was emitted
 * ONLY from bash (claude.sh, run-agent-orchestration.sh, team-lead-review.sh,
 * tc-writer-gate.sh). `spec-mode-runner.js` emitted none at all, so every agent it
 * drives — code-graph-detective, openspec, speckit, spec-coordinator, VC reviewer,
 * PRD change reviewer — was invisible to cost tracking:
 *
 *     agent-activity cost_snapshots : $0.1115
 *     REAL billed (OpenRouter)      : $0.3480     <- ~68% invisible
 *     Langfuse                      : 97 LLM calls / 649,164 input tokens
 *     agent-activity                :  4 cost_snapshot events
 *
 * Violates the standing #1 priority: real billed cost per call AND per run must be
 * captured and reportable.
 *
 * The plumbing already existed and was simply never used — ai-run.sh writes the
 * normalized result JSON ({result, total_cost_usd, usage:{input_tokens,
 * output_tokens}}) to $ORCH_JSON_RESULT when that variable is set. claude.sh sets
 * it; spec-mode-runner never did.
 *
 * Second defect covered here: a model missing from a price table reports
 * total_cost_usd = 0 WITH non-zero tokens (live: moonshotai/kimi-k3, 34,511 in /
 * 3,088 out / $0.0000). Silently recording $0 under-reports precisely on the top
 * ladder rung, which is only reached when a story is already burning money. A
 * zero cost alongside real tokens must be flagged, never recorded as free.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { parseCostRecord, buildCostSnapshot } = require_(
  '../../../orchestrations/scripts/lib/cost-emitter.js'
);
const SPEC_SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('cost-emitter — parsing the normalized result JSON', () => {
  it('reads the canonical shape ai-run.sh writes', () => {
    const c = parseCostRecord(JSON.stringify({
      result: 'ok', total_cost_usd: 0.0421,
      usage: { input_tokens: 12345, output_tokens: 678 },
    }));
    expect(c.costUsd).toBeCloseTo(0.0421);
    expect(c.tokensIn).toBe(12345);
    expect(c.tokensOut).toBe(678);
  });

  it('tolerates the alternate field names seen across providers', () => {
    const c = parseCostRecord(JSON.stringify({
      cost_usd: 0.01, tokens: { input: 10, output: 2 },
    }));
    expect(c.costUsd).toBeCloseTo(0.01);
    expect(c.tokensIn).toBe(10);
    expect(c.tokensOut).toBe(2);
  });

  it('returns null for unparseable or empty input rather than throwing', () => {
    expect(parseCostRecord('')).toBeNull();
    expect(parseCostRecord('not json')).toBeNull();
  });

  it('FLAGS zero cost with non-zero tokens (the kimi-k3 case) instead of recording free', () => {
    const c = parseCostRecord(JSON.stringify({
      result: 'ok', total_cost_usd: 0,
      usage: { input_tokens: 34511, output_tokens: 3088 },
    }));
    expect(c.tokensIn).toBe(34511);
    expect(c.costUnknown).toBe(true);   // not silently $0.00
  });

  it('does NOT flag a genuinely free call (no tokens, no cost)', () => {
    const c = parseCostRecord(JSON.stringify({ result: '', total_cost_usd: 0 }));
    expect(c.costUnknown).toBe(false);
  });
});

describe('cost-emitter — the emitted event', () => {
  const cost = { costUsd: 0.05, tokensIn: 100, tokensOut: 20, costUnknown: false };

  it('matches the cost_snapshot shape the bash side already emits', () => {
    const e = buildCostSnapshot({
      agent: 'code-graph-detective', storyId: 'AMSD-1820', phase: 'core',
      model: 'z-ai/glm-5.1', provider: 'openrouter', cost,
    });
    expect(e.type).toBe('cost_snapshot');
    expect(e.agent).toBe('code-graph-detective');
    expect(e.story_id).toBe('AMSD-1820');
    expect(e.phase).toBe('core');
    expect(e.model).toBe('z-ai/glm-5.1');
    expect(e.provider).toBe('openrouter');
    expect(e.detail.costUsd).toBeCloseTo(0.05);
    expect(e.detail.tokensIn).toBe(100);
    expect(e.detail.tokensOut).toBe(20);
    expect(typeof e.timestamp).toBe('string');
    expect(e.event_id).toMatch(/^evt-cost-/);
  });

  it('carries the costUnknown flag through so dashboards can show it', () => {
    const e = buildCostSnapshot({
      agent: 'x', storyId: 's', phase: 'core', model: 'moonshotai/kimi-k3',
      provider: 'openrouter', cost: { costUsd: 0, tokensIn: 34511, tokensOut: 3088, costUnknown: true },
    });
    expect(e.detail.costUnknown).toBe(true);
  });

  it('nulls empty story/phase like the bash emitter does', () => {
    const e = buildCostSnapshot({ agent: 'a', storyId: '', phase: '', model: '', provider: '', cost });
    expect(e.story_id).toBeNull();
    expect(e.phase).toBeNull();
  });
});

describe('spec-mode-runner — wiring', () => {
  it('sets ORCH_JSON_RESULT so ai-run.sh writes the cost JSON', () => {
    expect(SPEC_SRC).toMatch(/ORCH_JSON_RESULT/);
  });

  it('uses the shared cost emitter rather than a private re-implementation', () => {
    expect(SPEC_SRC).toMatch(/cost-emitter|emitCostSnapshot/);
  });

  it('emits cost from runClaude, so EVERY agent it drives is covered', () => {
    const i = SPEC_SRC.indexOf('function runClaude');
    expect(i).toBeGreaterThan(-1);
    const body = SPEC_SRC.slice(i, i + 9000);
    expect(body).toMatch(/ORCH_JSON_RESULT/);
    expect(body).toMatch(/emitCostSnapshot/);
  });
});
