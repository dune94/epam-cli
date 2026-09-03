/**
 * Structured agent I/O — step 1: the provider seam must be able to BIND an
 * agent's output to a schema, and must fail loudly when it cannot.
 *
 * Audit finding (2026-07-25): `kb-synthesizer.js` is the only consumer of a JSON
 * Schema in the whole pipeline. Every other agent — reviewer, detective, spec,
 * TC writer, CPA — returns free text that is regex/brace-matched into JSON after
 * the fact. That single defect, contract-enforced-after-generation instead of
 * during, produced the reviewer's 169-byte non-verdict that blocked four runs,
 * the spec agent's JSON wrapped inside a write_file tool call, and
 * kb-synthesizer's brace-depth extractJson returning null.
 *
 * `response_format` existed in exactly ONE provider (MiniMax), and only as
 * `json_object`. The pipeline runs every metrolinx agent through `openrouter`
 * (OpenRouter), which had no support at all — so `EPAM_MINIMAX_JSON_MODE=1`,
 * which ai-run.sh sets unconditionally for all providers, was a no-op for the
 * models actually in use.
 *
 * Verified live against OpenRouter before writing this: z-ai/glm-5.2,
 * z-ai/glm-5.1 and moonshotai/kimi-k3 ALL honour json_schema strict mode.
 * (A first probe at max_tokens=200 showed two of them returning empty content
 * and looked like non-support — that was B28, not a capability limit. Reasoning
 * models spend the budget on <think> first: the successful calls used 663-842
 * completion tokens for a trivial verdict. Schema binding does not remove the
 * output-budget requirement; the two interact.)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenRouterProvider } from '../../../src/providers/openrouter/OpenRouterProvider.js';

function mockFetchOnce(payload: unknown) {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => payload } as any;
  }));
  return calls;
}

const reply = {
  choices: [{ message: { content: '{"verdict":"approved","summary":"ok"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: { type: 'string' },
  },
  required: ['verdict', 'summary'],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('OpenRouterProvider — schema-bound output', () => {
  it('sends response_format json_schema when the request declares one', async () => {
    const calls = mockFetchOnce(reply);
    const provider = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await provider.complete({
      messages: [{ role: 'user', content: 'review' }],
      model: 'z-ai/glm-5.2',
      stream: false,
      maxTokens: 8000,
      responseFormat: { type: 'json_schema', name: 'verdict', schema: VERDICT_SCHEMA, strict: true },
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].response_format,
      'the schema never reached the provider — the agent output is still unbound')
      .toEqual({
        type: 'json_schema',
        json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA },
      });
  });

  it('pins routing with provider.require_parameters so the schema cannot be silently dropped', async () => {
    // OpenRouter may route to an upstream that does not support response_format.
    // Without require_parameters it drops the parameter and returns unbound output
    // that LOOKS successful — a silent failure of exactly the kind being removed
    // from this pipeline. require_parameters forces routing to a provider that
    // honours it, or fails loudly.
    const calls = mockFetchOnce(reply);
    const provider = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await provider.complete({
      messages: [{ role: 'user', content: 'review' }], model: 'z-ai/glm-5.2', stream: false,
      maxTokens: 8000,
      responseFormat: { type: 'json_schema', name: 'verdict', schema: VERDICT_SCHEMA, strict: true },
    } as any);
    expect(calls[0].provider,
      'OpenRouter may silently route to a provider that ignores the schema')
      .toEqual({ require_parameters: true });
  });

  it('does not pin routing when no output contract is declared', async () => {
    const calls = mockFetchOnce(reply);
    const provider = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }], model: 'z-ai/glm-5.2', stream: false,
    } as any);
    expect(calls[0]).not.toHaveProperty('provider');
  });

  it('still supports plain json_object mode', async () => {
    const calls = mockFetchOnce(reply);
    const provider = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }], model: 'z-ai/glm-5.2',
      stream: false, responseFormat: 'json_object',
    } as any);
    expect(calls[0].response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format entirely when none is declared', async () => {
    const calls = mockFetchOnce(reply);
    const provider = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }], model: 'z-ai/glm-5.2', stream: false,
    } as any);
    expect(calls[0]).not.toHaveProperty('response_format');
  });
});
