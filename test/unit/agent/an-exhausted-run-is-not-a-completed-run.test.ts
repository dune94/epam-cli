// AN EXHAUSTED AGENT RUN MUST NOT BE REPORTABLE AS A COMPLETED ONE.
//
// AgentRunner set `finalResponse = "Agent reached maximum iterations (N) without completing."`
// and returned it through buildResult with no error and exit 0. Every caller that checks only
// "did I get output?" saw a completed run.
//
// Live 2026-08-18, metrolinx AMSD-2041: codeline-discovery exhausted its iteration budget, the
// caller accepted the exhaustion text as the model's answer, the fallback selected the
// highest-scored repository, and the run proceeded against next.gotransit.com — for a ticket
// whose own `components` field said ["MX"]. The run had to be killed.
//
// This pins the structural signal, not the sentence: a caller must be able to refuse a
// truncated answer without pattern-matching prose that may be reworded.
import { describe, it, expect } from 'vitest';
import { buildRunResultJson } from '../../../src/cli/commands/run';

const base = {
  finalResponse: 'whatever the agent happened to say',
  usage: { inputTokens: 10, outputTokens: 5 },
  toolCallCount: 3,
  iterations: 20,
};
const config = { model: 'z-ai/glm-5.2', provider: 'qwen' };

describe('an exhausted run is distinguishable from a completed one', () => {
  it('a completed run carries NO stop_reason — absent is not "zero"', () => {
    const out = buildRunResultJson(base, config);
    expect('stop_reason' in out).toBe(false);
  });

  it('an exhausted run says so, structurally', () => {
    const out = buildRunResultJson({ ...base, stopReason: 'max_iterations' }, config);
    expect(out.stop_reason).toBe('max_iterations');
  });

  it('and it still reports what it spent — a cut-off run costs real money', () => {
    // The 2026-08-10 lesson: the attempts that get killed are the expensive ones. A refusal
    // that discarded the usage record would make the costly failures the invisible ones.
    const out = buildRunResultJson({ ...base, stopReason: 'max_iterations' }, config) as
      { usage: { totalTokens: number } };
    expect(out.usage.totalTokens).toBe(15);
  });

  it('the flag does not disturb the fields a caller already reads', () => {
    const done = buildRunResultJson(base, config);
    const cut  = buildRunResultJson({ ...base, stopReason: 'max_iterations' }, config);
    for (const k of ['result', 'model', 'provider']) {
      expect(cut[k]).toEqual(done[k]);
    }
  });
});
