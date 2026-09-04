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

/**
 * THE TRACE ITSELF MUST CARRY THE WORDS, NOT ONLY ITS NESTED GENERATION.
 *
 * Langfuse renders a trace's OWN input/output in the trace list and header. The generation carried
 * both and the trace carried neither, so every trace read as empty — an operator opening Langfuse
 * saw rows with nothing in them and had to click into each generation to find the text.
 *
 * Reported live 2026-09-04 against pipeline-tests-18, on a run whose traces were otherwise landing
 * correctly and grouped into their session: "Traces have no input or output in langfuse."
 */
describe('the trace carries the words too, not just the generation nested inside it', () => {
  const traceOf = (f: any) =>
    buildIngestionBody(f).batch.find((e: any) => e.type === 'trace-create').body;

  const CALL = {
    agent: 'roster-review', storyId: 'S1', phase: 'core', provider: 'claude',
    model: 'claude-sonnet-5', turns: 1, rung: 0,
    startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
    input: 'the prompt that was sent', output: 'the reply that came back',
    costUsd: 0.01, tokensIn: 10, tokensOut: 20,
  };

  it('puts the prompt on the trace, so the trace list is not a wall of empty rows', () => {
    expect(traceOf(CALL).input, 'the trace renders empty in Langfuse — the words are only on the generation')
      .toBe('the prompt that was sent');
  });

  it('puts the reply on the trace as well', () => {
    expect(traceOf(CALL).output).toBe('the reply that came back');
  });

  it('the generation still carries both — the trace is additional, never a replacement', () => {
    const g = buildIngestionBody(CALL).batch.find((e: any) => e.type === 'generation-create').body;
    expect(g.input).toBe('the prompt that was sent');
    expect(g.output).toBe('the reply that came back');
  });

  it('a call with no words recorded leaves them absent rather than empty-stringing them', () => {
    // Absent is honest ("nothing was captured"); "" reads as "the model was sent nothing".
    const t = traceOf({ ...CALL, input: undefined, output: undefined });
    expect(t.input).toBeUndefined();
    expect(t.output).toBeUndefined();
  });
});
