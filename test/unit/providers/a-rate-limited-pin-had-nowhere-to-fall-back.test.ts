/**
 * A PINNED UPSTREAM THAT RATE-LIMITED TOOK THE WHOLE RUN DOWN.
 *
 * modelOverrides.providerOrder pins a model to one upstream for cache stickiness — measured, and
 * worth it: 99.6% on glm-5.2, 98.2% on kimi-k3. It is sent as
 * `provider: { order: [...], allow_fallbacks: false }`, and allow_fallbacks:false is deliberate,
 * so a silent reroute cannot reintroduce the price and cache variance the pin exists to remove.
 *
 * But a pin with no fallback turns a TRANSIENT upstream condition into a terminal one. Live
 * 2026-08-18, resuming run 20260818T101809Z, OpenRouter answered:
 *
 *   429  "z-ai/glm-5.2 is temporarily rate-limited upstream"
 *        provider_error_code: rate_limit_exceeded
 *        limit_source: upstream_provider_shared_pool
 *
 * With nowhere to fall back the request failed, the CLI exited 1 with no output, the coordinator
 * read raw=0 bytes as an environment crash, and 10 of 12 attempts on each of two lanes burned in
 * about ten seconds each. Both stories were failed with correct, passing work already on disk.
 *
 * Reproduced in one variable:
 *   EPAM_PROVIDER_ORDER unset      -> exit 0, 410 bytes
 *   EPAM_PROVIDER_ORDER=<pinned>   -> exit 1, 0 bytes
 *
 * The pin is an OPTIMISATION; correctness must not depend on it. So a rate-limited pinned request
 * is retried once with the pin released. Determinism is kept for every normal call, the reroute
 * is deliberate rather than silent, and congestion costs a slower turn instead of the run.
 *
 * Only 429 is retried: a 400, 401 or 500 says something the pin cannot fix, and masking those
 * behind a reroute would hide a real fault.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QwenProvider } from '../../../src/providers/qwen/QwenProvider';

const REQ = { model: 'z-ai/glm-5.2', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8 };
const OK_BODY = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

let sent: Array<Record<string, any>>;
const provider = () => new QwenProvider({ apiKey: 'k', openRouterMode: true });

/** Queue of responses; each fetch call shifts one. */
function stubFetch(queue: Array<{ ok: boolean; status: number; body?: unknown; text?: string }>) {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    const r = queue.shift() || { ok: true, status: 200, body: OK_BODY };
    return {
      ok: r.ok, status: r.status,
      json: async () => r.body ?? OK_BODY,
      text: async () => r.text ?? '',
    } as never;
  }));
}

beforeEach(() => { process.env.EPAM_PROVIDER_ORDER = 'SomeUpstream'; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.EPAM_PROVIDER_ORDER; });

describe('a rate-limited pin had nowhere to fall back', () => {
  it('PINS NORMALLY — the cache stickiness the pin exists for is unchanged', async () => {
    stubFetch([{ ok: true, status: 200 }]);
    await provider().complete(REQ as never);
    expect(sent).toHaveLength(1);
    expect(sent[0].provider, 'the pin is no longer sent on a normal call')
      .toEqual({ order: ['SomeUpstream'], allow_fallbacks: false });
  });

  it('RETRIES ONCE WITHOUT THE PIN ON 429 — the live failure', async () => {
    stubFetch([
      { ok: false, status: 429, text: 'rate-limited upstream' },
      { ok: true, status: 200 },
    ]);
    const res = await provider().complete(REQ as never);
    expect(sent, 'a rate-limited pinned request was not retried').toHaveLength(2);
    expect(sent[0].provider?.allow_fallbacks, 'the first attempt was not pinned').toBe(false);
    expect(sent[1].provider?.order, 'the retry is still pinned to the upstream that refused it')
      .toBeUndefined();
    expect(res.content?.[0]).toBeTruthy();
  });

  it('DOES NOT RETRY A NON-429 — a real fault must not be masked by a reroute', async () => {
    stubFetch([{ ok: false, status: 400, text: 'bad request' }]);
    await expect(provider().complete(REQ as never)).rejects.toThrow(/400/);
    expect(sent, 'a 400 was retried, hiding the real error').toHaveLength(1);
  });

  it('does not retry a 429 when there was no pin to release', async () => {
    delete process.env.EPAM_PROVIDER_ORDER;
    stubFetch([{ ok: false, status: 429, text: 'rate-limited' }]);
    await expect(provider().complete(REQ as never)).rejects.toThrow(/429/);
    expect(sent, 'an unpinned 429 was retried, which changes nothing and doubles the load')
      .toHaveLength(1);
  });

  it('gives up after the unpinned retry rather than looping', async () => {
    stubFetch([
      { ok: false, status: 429, text: 'rate-limited' },
      { ok: false, status: 429, text: 'still rate-limited' },
    ]);
    await expect(provider().complete(REQ as never)).rejects.toThrow(/429/);
    expect(sent, 'the retry retried').toHaveLength(2);
  });
});
