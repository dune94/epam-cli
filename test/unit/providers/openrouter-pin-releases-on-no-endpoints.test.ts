/**
 * THE PIN TURNED A REROUTABLE 404 INTO A DEAD RUN.
 *
 * modelOverrides.providerOrder pins each OpenRouter model to one upstream — Z.AI for glm-5.3,
 * Moonshot AI for kimi-k3, CoreWeave for glm-5.2 — sent as `provider.order` with
 * `allow_fallbacks:false`. That pin is an OPTIMISATION: it buys cache stickiness worth ~80% on a
 * repeated prefix (see openrouter-sticky-session.test.ts). Correctness must never depend on it.
 *
 * postOpenRouter already knew that and released the pin on 429, after a live 2026-08-18 incident
 * where "the pin left nowhere to fall back, the request failed with no output, and a coordinator
 * read that as an environment crash — burning 10 of 12 attempts."
 *
 * The same shape returns as a 404 when the pinned upstream is simply not in the surviving endpoint
 * set, and 404 was not released. Live 2026-09-11, openrouter run 20260910T222155Z:
 *
 *   404 {"error":{"message":"No endpoints found for z-ai/glm-5.3.","code":404,"metadata":
 *        {"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":28},
 *                           {"step":"Filter by Tool Compatibility","endpoint_count":27},
 *                           {"step":"Apply Status Sorting","endpoint_count":27},
 *                           {"step":"Filter by Fallback","endpoint_count":0}]}}}
 *
 * 27 endpoints survived every capability filter and the PIN eliminated all of them. The failure
 * analyst lost three calls across two models, the retry proceeded with no diagnosis, and the run
 * burned 4 of 12 attempts and 3 ladder rungs before it was killed.
 *
 * A funnel that collapses at "Filter by Fallback" is BY DEFINITION something a reroute fixes — the
 * candidates existed and only our own pin removed them. So it is released exactly as a 429 is:
 * once, announced, never a loop.
 *
 * A 404 WITHOUT that shape is a different thing — a model that genuinely does not exist — and must
 * still fail, or a typo in a ladder would silently reroute to whatever OpenRouter felt like.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { OpenRouterProvider } from '../../../src/providers/openrouter/OpenRouterProvider';

const REQ = { model: 'z-ai/glm-5.3', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8 };

const NO_ENDPOINTS = JSON.stringify({
  error: {
    message: 'No endpoints found for z-ai/glm-5.3.', code: 404,
    metadata: { routing_funnel: [
      { step: 'Initial Endpoints', endpoint_count: 28 },
      { step: 'Filter by Tool Compatibility', endpoint_count: 27 },
      { step: 'Apply Status Sorting', endpoint_count: 27 },
      { step: 'Filter by Fallback', endpoint_count: 0 },
    ] },
  },
});
const NO_SUCH_MODEL = JSON.stringify({ error: { message: 'No allowed providers are available for the selected model.', code: 404 } });

const OK_BODY = JSON.stringify({
  id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

let sent: Array<Record<string, unknown>>;
function stubFetch(firstStatus: number, firstBody: string) {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    if (sent.length === 1 && firstStatus !== 200) {
      return new Response(firstBody, { status: firstStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response(OK_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

beforeEach(() => { process.env.EPAM_PROVIDER_ORDER = 'Z.AI'; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.EPAM_PROVIDER_ORDER; });

const provider = () => new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });

describe('the pin is released when it is the pin that eliminated every endpoint', () => {
  it('sends the pin on the first attempt — the optimisation is not abandoned', async () => {
    stubFetch(200, '');
    await provider().complete(REQ as never);
    expect(sent[0].provider, 'the provider pin was not sent at all').toBeDefined();
  });

  it('retries WITHOUT the pin on a 404 whose funnel collapsed at Filter by Fallback', async () => {
    stubFetch(404, NO_ENDPOINTS);
    await provider().complete(REQ as never);
    expect(sent.length,
      'the pinned 404 was returned as-is; 27 endpoints survived every capability filter and only ' +
      'our own allow_fallbacks:false removed them — a reroute is exactly what fixes that').toBe(2);
    expect(sent[1].provider, 'the retry still carried the pin that caused the 404').toBeUndefined();
    expect(sent[1].model, 'the retry must ask for the same model').toBe('z-ai/glm-5.3');
  });

  it('does NOT reroute a 404 that is not a fallback collapse — a bad model name must still fail', async () => {
    stubFetch(404, NO_SUCH_MODEL);
    await provider().complete(REQ as never).catch(() => undefined);
    expect(sent.length,
      'a 404 with no fallback-collapse funnel was rerouted — a typo in a ladder would then ' +
      'silently run on an unpinned provider').toBe(1);
  });

  it('still does not reroute when nothing was pinned in the first place', async () => {
    delete process.env.EPAM_PROVIDER_ORDER;
    stubFetch(404, NO_ENDPOINTS);
    await provider().complete(REQ as never).catch(() => undefined);
    expect(sent.length, 'an unpinned request was retried, which cannot help').toBe(1);
  });
});
