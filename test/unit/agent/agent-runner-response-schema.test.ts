/**
 * PILLAR 2 — the compiled schema must actually reach the provider.
 *
 * constraint-compiler emits EPAM_RESPONSE_SCHEMA; the provider seam accepts a
 * json_schema response format. Between them sits AgentRunner, which builds the
 * ProviderRequest. If it drops the field the constraint is stored, applied,
 * digested and verified — and still does nothing, which is the most expensive
 * kind of silent failure: everything reports success.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';

const ORIGINAL = process.env.EPAM_RESPONSE_SCHEMA;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EPAM_RESPONSE_SCHEMA;
  else process.env.EPAM_RESPONSE_SCHEMA = ORIGINAL;
});

/** Captures the ProviderRequest and returns a trivial completed turn. */
function captureProvider(seen: any[]) {
  return {
    name: 'stub',
    async stream(request: any) {
      seen.push(request);
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async complete(request: any) { seen.push(request); return this.stream(request); },
  } as any;
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

describe('AgentRunner — response schema reaches the provider', () => {
  it('forwards a schema declared via EPAM_RESPONSE_SCHEMA', async () => {
    process.env.EPAM_RESPONSE_SCHEMA = JSON.stringify({ name: 'verdict', schema: VERDICT });
    const seen: any[] = [];
    await new AgentRunner({
      userMessage: 'review', provider: captureProvider(seen), model: 'z-ai/glm-5.2', tools: [],
    } as any).run();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].responseFormat,
      'the compiled schema never reached the provider — the constraint is inert')
      .toEqual({ type: 'json_schema', name: 'verdict', schema: VERDICT, strict: true });
  });

  it('sends no responseFormat when none is declared', async () => {
    delete process.env.EPAM_RESPONSE_SCHEMA;
    const seen: any[] = [];
    await new AgentRunner({
      userMessage: 'hi', provider: captureProvider(seen), model: 'z-ai/glm-5.2', tools: [],
    } as any).run();
    expect(seen[0].responseFormat).toBeUndefined();
  });

  it('ignores a malformed value loudly rather than crashing the agent', async () => {
    // A broken KB must never take the agent down with it.
    process.env.EPAM_RESPONSE_SCHEMA = '{not json';
    const seen: any[] = [];
    await new AgentRunner({
      userMessage: 'hi', provider: captureProvider(seen), model: 'z-ai/glm-5.2', tools: [],
    } as any).run();
    expect(seen[0].responseFormat).toBeUndefined();
  });
});
