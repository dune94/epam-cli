/**
 * WITHOUT A SESSION ID, OPENROUTER CACHING CANNOT WORK — AND I MISDIAGNOSED THE MODEL FOR IT.
 *
 * OpenRouter load-balances each model across upstream providers. Consecutive turns of one agent
 * run can land on different ones, and a prefix cached on CoreWeave is worth nothing to Novita.
 * `session_id` pins the route.
 *
 * Measured 2026-08-10 on z-ai/glm-5.2, identical 23K-token prefix, two turns:
 *
 *   no session_id : turn 2 cached=0        cost $0.01768
 *   session_id    : turn 2 cached=23,168   cost $0.00332   (both CoreWeave) — 99.6%, 81% cheaper
 *
 * I had reported to the operator that this model "does not cache, with or without an explicit
 * cache_control breakpoint", and let that conclusion drive a ladder change. The measurement was
 * real; it measured the wrong variable. Re-probing every model with sticky routing:
 *
 *   MiniMax-M3 (direct)          99.8%
 *   z-ai/glm-5.2 (CoreWeave)     99.6%
 *   moonshotai/kimi-k3 (Moonshot) 98.2%   $0.0625 -> $0.0074
 *   minimax/minimax-m2 (Novita)  caches
 *   moonshotai/kimi-k2.5 (Novita) 0%      <- the only genuine non-cacher
 *
 * Two properties are load-bearing and both are asserted here:
 *
 *   STABILITY  every turn of one attempt must send the SAME id, or each turn re-routes and the
 *              cache never warms. A per-call id is indistinguishable from no id at all.
 *   ISOLATION  a different attempt must send a DIFFERENT id — it rebuilds its prompt, so sharing
 *              a route buys nothing and pins unrelated work to one upstream provider.
 *
 * The header/body pair is sent only in OpenRouter mode: DashScope has no such concept and would
 * receive an unknown field.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenRouterProvider, openRouterSessionId } from '../../../src/providers/openrouter/OpenRouterProvider';

const REQ = { model: 'z-ai/glm-5.2', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8 };

let sent: Array<{ url: string; init: { headers: Record<string, string>; body: string } }>;
beforeEach(() => {
  sent = [];
  delete process.env.EPAM_SESSION_ID;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: never) => {
    sent.push({ url, init: init as never });
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
      }),
    };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.EPAM_SESSION_ID; });

const body = (i = 0) => JSON.parse(sent[i].init.body);
const headers = (i = 0) => sent[i].init.headers;

describe('the request carries the session id OpenRouter routes on', () => {
  it('sends session_id in the body', async () => {
    process.env.EPAM_SESSION_ID = 'run-1-AMSD-2041-0';
    await new OpenRouterProvider({ apiKey: 'k', openRouterMode: true }).complete(REQ);
    expect(
      body().session_id,
      'without this every turn may re-route and no prefix is ever reused',
    ).toBe('run-1-AMSD-2041-0');
  });

  it('sends the x-session-id header too', async () => {
    process.env.EPAM_SESSION_ID = 'run-1-AMSD-2041-0';
    await new OpenRouterProvider({ apiKey: 'k', openRouterMode: true }).complete(REQ);
    expect(headers()['x-session-id']).toBe('run-1-AMSD-2041-0');
  });

  it('DashScope mode sends neither — it has no such concept', async () => {
    process.env.EPAM_SESSION_ID = 'run-1-AMSD-2041-0';
    await new OpenRouterProvider({ apiKey: 'k', openRouterMode: false }).complete(REQ)
      .catch(() => { /* DashScope shape differs; only the request matters here */ });
    if (sent.length) {
      expect(body().session_id).toBeUndefined();
      expect(headers()['x-session-id']).toBeUndefined();
    }
  });
});

describe('STABILITY: every turn of one attempt shares one id', () => {
  it('two calls in the same process send the same id', async () => {
    const p = new OpenRouterProvider({ apiKey: 'k', openRouterMode: true });
    await p.complete(REQ);
    await p.complete(REQ);
    expect(
      body(0).session_id,
      'a per-call id re-routes every turn — identical to sending nothing',
    ).toBe(body(1).session_id);
  });

  it('and it is stable even across provider instances in one process', async () => {
    await new OpenRouterProvider({ apiKey: 'k', openRouterMode: true }).complete(REQ);
    await new OpenRouterProvider({ apiKey: 'k', openRouterMode: true }).complete(REQ);
    expect(body(0).session_id).toBe(body(1).session_id);
  });

  it('the generated id is non-empty when the pipeline supplies none', () => {
    expect(openRouterSessionId()).toMatch(/\S/);
  });

  it('an explicit id always wins over the generated one', () => {
    process.env.EPAM_SESSION_ID = 'explicit-wins';
    expect(openRouterSessionId()).toBe('explicit-wins');
  });
});

describe('ISOLATION: the pipeline gives each attempt its own id', () => {
  const CLAUDE_SH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

  it('claude.sh exports EPAM_SESSION_ID to the writer', () => {
    expect(
      CLAUDE_SH,
      'the provider falls back to a per-process id, which is right, but the pipeline should be explicit',
    ).toMatch(/EPAM_SESSION_ID=/);
  });

  it('the id varies by run, story AND attempt', () => {
    const m = /EPAM_SESSION_ID="([^"]+)"/.exec(CLAUDE_SH);
    expect(m, 'no EPAM_SESSION_ID export found').toBeTruthy();
    const tpl = (m as RegExpExecArray)[1];
    // Sharing one id across attempts pins unrelated prompts to one upstream provider and buys
    // nothing — a retry rebuilds its prompt, so its prefix differs anyway.
    expect(tpl).toContain('story_id');
    expect(tpl).toContain('retry_count');
    expect(tpl).toContain('ORCH_RUN_ID');
  });
});

describe('the cached-token figure survives the STREAM path, not just complete()', () => {
  // Patching complete() alone left this undefined end-to-end twice in one session — once for
  // MiniMax, once here — because the CLI streams and unit tests reach complete().
  const SRC = readFileSync(
    join(__dirname, '../../../src/providers/openrouter/OpenRouterProvider.ts'), 'utf8');

  it('the streaming usage parser reads prompt_tokens_details.cached_tokens', () => {
    const i = SRC.indexOf('inputTokens = parsed.usage.prompt_tokens');
    expect(i, 'the streaming usage parser moved').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 600)).toContain('cached_tokens');
  });

  it('and the streaming return carries it', () => {
    const i = SRC.indexOf('usage: { inputTokens, outputTokens');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 250)).toContain('cachedInputTokens');
  });
});
