/**
 * A TRACE THAT RECORDS THE PRICE BUT NOT THE WORDS CANNOT ANSWER THE ONLY QUESTION THAT MATTERS.
 *
 * Every Langfuse observation this pipeline has ever written reads in=4ch out=4ch — the string
 * "null" — for successful and failed agents alike. Token counts, cost, latency and the ladder rung
 * are all there; the prompt and the completion are not, because the ingestion body never carried
 * an `input` or an `output` field at all.
 *
 * The consequence, on 2026-08-29: metrolinx AMSD-1919 halted on a reply shape that could not be
 * established from any surviving record, and "replay the failing call from Langfuse" — proposed in
 * this very session — was never possible, because there is nothing in there to replay.
 */
import { describe, it, expect } from 'vitest';

const { buildIngestionBody } = require('../../../orchestrations/scripts/lib/langfuse-emit.js');

const base = {
  agent: 'agent-mint', model: 'claude-sonnet-5', provider: 'claude',
  startedAt: '2026-08-29T21:00:00.000Z', endedAt: '2026-08-29T21:00:09.000Z',
  tokensIn: 1200, tokensOut: 800, costUsd: 0.03, turns: 1,
};

const generation = (f: any) => buildIngestionBody(f).batch.find((e: any) => e.type === 'generation-create').body;

describe('a trace carries what was said', () => {
  it('records the prompt as the generation input', () => {
    const g = generation({ ...base, input: 'Propose the agents this project needs.' });
    expect(g.input).toBe('Propose the agents this project needs.');
  });

  it('records the completion as the generation output', () => {
    const reply = '<PROJECT_AGENTS>{"proposedAgents":[{"name":"checkout-forms-engineer"}]}</PROJECT_AGENTS>';
    const g = generation({ ...base, output: reply });
    expect(g.output).toBe(reply);
  });

  it('keeps the reply WHOLE — the excerpt cap is what lost the metrolinx one', () => {
    const long = 'y'.repeat(3885);
    expect(generation({ ...base, output: long }).output).toHaveLength(3885);
  });

  it('still records cost and tokens, which must not regress', () => {
    const g = generation({ ...base, output: 'x' });
    expect(g.usage.input).toBe(1200);
    expect(g.usage.output).toBe(800);
    expect(g.usage.totalCost).toBe(0.03);
    expect(g.model).toBe('claude-sonnet-5');
  });

  it('omits the fields entirely when there is nothing to say', () => {
    // Absent stays absent — an empty string is not a completion, and writing "" would look like
    // the model answered with nothing rather than that we never captured it.
    const g = generation({ ...base });
    expect('input' in g).toBe(false);
    expect('output' in g).toBe(false);
  });
});
