/**
 * OpenRouter Provider
 * 
 * Alibaba Cloud DashScope API provider for OpenRouter models
 * https://dashscope.aliyun.com
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { resolveTemperature, resolveTopP } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Parse OpenRouter-style text-markup tool calls into ContentPart tool_use blocks.
 *
 * Some OpenRouter models (via OpenRouter) emit function calls as plain text instead of
 * API-level tool_calls, using this format:
 *   <function=tool_name>
 *   <parameter=param_name>value</parameter>
 *   </function>
 *
 * This parser extracts those blocks and converts them so the AgentRunner can
 * execute them normally. Exported for unit testing.
 */
/**
 *
 * response. These blocks are 3-8K tokens each. If left in the text they
 * accumulate in the AgentRunner message history and are resent on every
 * subsequent iteration, causing quadratic token growth. Strip them here so
 * they never enter the history. Exported for unit testing.
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function parseMarkupToolCalls(text: string): { toolUses: ContentPart[]; cleanText: string } {
  const toolUses: ContentPart[] = [];
  let idCounter = 0;

  const funcRegex = /<function=([^\s>]+)>([\s\S]*?)<\/function>/g;
  const blocks: Array<{ full: string; name: string; rawParams: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(text)) !== null) {
    blocks.push({ full: match[0], name: match[1], rawParams: match[2] });
  }

  if (blocks.length === 0) return { toolUses: [], cleanText: text };

  let cleanText = text;
  for (const block of blocks) {
    const input: Record<string, string> = {};
    const paramRegex = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(block.rawParams)) !== null) {
      input[paramMatch[1].trim()] = paramMatch[2].trim();
    }
    toolUses.push({
      type: 'tool_use',
      id: `openrouter_markup_${++idCounter}`,
      name: block.name.trim(),
      input,
    });
    cleanText = cleanText.replace(block.full, '');
  }

  // Remove stray </tool_call> artifacts that OpenRouter sometimes appends
  cleanText = cleanText.replace(/<\/tool_call>/g, '').trim();

  return { toolUses, cleanText };
}

export interface OpenRouterConfig {
  apiKey: string;
  baseURL?: string;
  /** When true, use OpenAI-compatible OpenRouter endpoint instead of DashScope */
  openRouterMode?: boolean;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter sticky-routing session id — the thing that makes prompt caching possible at all.
 *
 * OpenRouter load-balances a model across upstream providers. Without a session id, consecutive
 * turns of one agent run can land on different providers, and a prefix cached on one is useless
 * to another. Measured 2026-08-10 on z-ai/glm-5.2 with a 23K-token prefix:
 *
 *   no session_id : turn 2 cached=0      cost $0.01768   (two calls, possibly two providers)
 *   session_id    : turn 2 cached=23168  cost $0.00332   (both CoreWeave) — 99.6%, 81% cheaper
 *
 * I previously concluded this model "does not cache" from a probe that omitted it. It caches;
 * the routing was the variable.
 *
 * Stability is the whole point: every turn of one story attempt must send the SAME id, and
 * different attempts should differ (a new attempt rebuilds its prompt anyway). The pipeline
 * supplies EPAM_SESSION_ID per attempt; absent that, one id is generated per process, which is
 * exactly one agent run for the `epam run` path the orchestration uses.
 */
let _processSessionId: string | undefined;
/**
 * Deterministic upstream routing. OpenRouter spreads a slug across hosts that differ in price,
 * cache size and parameter semantics — measured 2026-08-10 on kimi-k3: pinning to Moonshot AI
 * cut a warm turn from $0.00747 to $0.00440 and raised the cache hit from 12,288 to 13,568.
 * allow_fallbacks:false so a silent reroute cannot reintroduce the variance.
 * Config-driven (modelOverrides.providerOrder) — no host names in code.
 */
export function openRouterProviderOrder(): string[] | undefined {
  const raw = process.env.EPAM_PROVIDER_ORDER;
  if (!raw) return undefined;
  const order = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return order.length ? order : undefined;
}

/**
 * Send an OpenRouter request, releasing the upstream pin if — and only if — the pinned upstream
 * rate-limits us.
 *
 * The pin (modelOverrides.providerOrder, sent as provider.order with allow_fallbacks:false) is an
 * OPTIMISATION: it buys measured cache stickiness. Correctness must not depend on it. Live
 * 2026-08-18 it did: OpenRouter returned 429 "temporarily rate-limited upstream"
 * (limit_source: upstream_provider_shared_pool), the pin left nowhere to fall back, the request
 * failed with no output, and a coordinator read that as an environment crash — burning 10 of 12
 * attempts on each of two lanes while correct, passing work sat on disk.
 *
 * Only 429 is retried. A 400, 401 or 500 says something a reroute cannot fix, and masking those
 * would hide a real fault. One retry, never a loop: if the whole model is saturated, failing is
 * the honest answer.
 */
async function postOpenRouter(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  const pinned = body.provider !== undefined;
  const first = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (first.ok || first.status !== 429 || !pinned) return first;

  // Deliberate, announced reroute — not the silent one allow_fallbacks:false exists to prevent.
  const { provider: _dropped, ...unpinned } = body;
  process.stderr.write(
    '[openrouter] the pinned upstream is rate-limited (429) — retrying once without the pin; '
    + 'this turn loses the cache stickiness the pin buys\n');
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(unpinned) });
}

export function openRouterSessionId(): string {
  const fromEnv = process.env.EPAM_SESSION_ID;
  if (fromEnv) return fromEnv;
  if (!_processSessionId) {
    _processSessionId = `epam-${process.pid}-${Date.now().toString(36)}`;
  }
  return _processSessionId;
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  // TAKEN FROM THE OPENROUTER SET'S OWN LADDER, not chosen here: the opening rung of the
  // medium tier. A default invented in code is the hardcoding this project forbids.
  readonly defaultModel = 'MiniMax-M2.7-highspeed';

  private apiKey: string;
  private baseURL: string;
  private openRouterMode: boolean;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.openRouterMode = config.openRouterMode ?? false;
    // ONE BASE URL. DashScope was Alibaba's direct openrouter API — the second route OpenRouter
    // replaced — so there is no longer a non-OpenRouter mode to fall back to.
    this.baseURL = config.baseURL || OPENROUTER_BASE_URL;
  }

  /** Only use request.model if it looks like an OpenRouter model. Falls back to default.
   *  EPAM_OPENROUTER_MODEL_OVERRIDE always wins — lets local Ollama models override PRD model names. */
  private resolveModel(requested?: string): string {
    const override = process.env.EPAM_OPENROUTER_MODEL_OVERRIDE;
    if (override) return override;
    if (requested && /^(openrouter|mistral|llama|deepseek|meta-llama|openai|google|anthropic|moonshotai|moonshot|zhipuai|z-ai|glm|kimi|minimax)/.test(requested)) return requested;
    return this.defaultModel;
  }

  /** OpenRouter's ":exacto" model-slug suffix biases routing toward high-precision
   *  providers, avoiding erratic/low-precision alternatives that can hallucinate,
   *  waste tokens on retries, or fail tool-use — the same class of instability
   *  diagnosed live in a model/provider-mismatch hang (2026-07-07). Opt-in via
   *  EPAM_OPENROUTER_EXACTO=true (default off — not universally available for
   *  every model, and changes routing behavior, so this is a deliberate choice,
   *  not a silent default). OpenRouter-only; never applied to DashScope calls. */
  /**
   * Compile the declared output contract into the OpenAI-compatible wire format.
   *
   * Previously absent entirely: `response_format` lived only in MiniMaxProvider,
   * while every metrolinx agent runs through this provider — so
   * EPAM_MINIMAX_JSON_MODE=1, which ai-run.sh sets for ALL providers, was a no-op
   * for the models actually in use. Output contracts were enforced after the fact
   * by regex/brace-matching, which is how a 169-byte non-verdict reached the
   * pipeline as "the reviewer's answer".
   */
  private resolveResponseFormat(request: ProviderRequest): Record<string, unknown> | undefined {
    const rf = request.responseFormat;
    if (!rf) return undefined;
    if (rf === 'json_object') return { type: 'json_object' };
    return {
      type: 'json_schema',
      json_schema: { name: rf.name, strict: rf.strict !== false, schema: rf.schema },
    };
  }

  private applyExactoSuffix(model: string): string {
    if (process.env.EPAM_OPENROUTER_EXACTO !== 'true') return model;
    if (model.endsWith(':exacto')) return model;
    return `${model}:exacto`;
  }

  /** For OpenRouter, pass reasoning.effort when effort level is explicitly set.
   *  This is a native API parameter — completely separate from temperature. */
  private resolveOpenRouterReasoning(request: ProviderRequest): Record<string, unknown> | undefined {
    const effort = request.reasoningEffort ?? process.env.EPAM_REASONING_EFFORT as string | undefined;
    // 'max' is supported by GLM-5.2 and Kimi K3 and is the rung ABOVE high — without it the
    // ladder has no escalation left once effort reaches 'high', which is exactly where the
    // top-of-chain models sit. Previously this whitelist silently dropped it.
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
      return { reasoning: { effort } };
    }
    return undefined;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.openRouterMode
      ? this.completeOpenRouter(request)
      : this.completeDashScope(request);
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    return this.openRouterMode
      ? this.streamOpenRouter(request, handler)
      : this.streamDashScope(request, handler);
  }

  // ─── OpenRouter (OpenAI-compatible) ────────────────────────────────────────

  private async completeOpenRouter(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.applyExactoSuffix(this.resolveModel(request.model));
    const messages = this.formatMessages(request.messages, request.systemPrompt);
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const response = await postOpenRouter(`${this.baseURL}/chat/completions`, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://epam.com',
        'X-Title': 'EPAM CLI',
        ...(this.openRouterMode ? { 'x-session-id': openRouterSessionId() } : {}),
      }, {
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
        // Sticky routing — see openRouterSessionId(). Sent in the body as well as the header
        // because the documented activation path is the body field; the header is belt-and-braces.
        ...(this.openRouterMode ? { session_id: openRouterSessionId() } : {}),
        ...(this.openRouterMode && openRouterProviderOrder()
          ? { provider: { order: openRouterProviderOrder(), allow_fallbacks: false } } : {}),
        // usage.include=true asks OpenRouter to return REAL, billed cost in
        // the response's usage.cost field — the actual amount charged to
        // this account for this exact call, not a locally-estimated price.
        // Required per feedback_real_cost_tracking_critical: real cost
        // capture must be the primary path, a maintained pricing table is
        // fallback-only (found live 2026-07-13 — this field was never
        // requested, forcing every OpenRouter-routed call through a stale,
        // disconnected local estimate that was off by ~4.7x for this run).
        usage: { include: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...this.resolveOpenRouterReasoning(request),
        ...(this.resolveResponseFormat(request) ? { response_format: this.resolveResponseFormat(request) } : {}),
        // OpenRouter may route to an upstream provider that does not support
        // response_format — it drops the parameter and returns UNBOUND output that
        // looks like a success. require_parameters pins routing to a provider that
        // honours everything we sent, or fails loudly instead of silently
        // downgrading the contract.
        ...(this.openRouterMode && this.resolveResponseFormat(request)
          ? { provider: { require_parameters: true } } : {}),
      });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter/OpenRouter API error: ${response.status} ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data['choices']?.[0];
    if (!choice) throw new Error('OpenRouter returned no choices');

    const content: ContentPart[] = [];
    if (choice.message?.content) {
      const cleaned = stripThinkingBlocks(choice.message.content);
      if (cleaned) content.push({ type: 'text', text: cleaned });
    }
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }

    // Fallback: model returned no API tool_calls but may have emitted markup in text
    if (!choice.message?.tool_calls && choice.message?.content) {
      const { toolUses, cleanText } = parseMarkupToolCalls(choice.message.content);
      if (toolUses.length > 0) {
        const stripped = stripThinkingBlocks(cleanText);
        content.length = 0;
        if (stripped) content.push({ type: 'text', text: stripped });
        content.push(...toolUses);
      }
    }

    const hasToolUse = content.some(p => p.type === 'tool_use');
    return {
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      stopReason: hasToolUse ? 'tool_use' : this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: data['usage']?.prompt_tokens || 0,
        outputTokens: data['usage']?.completion_tokens || 0,
        // Real billed cost, requested via usage.include=true above. Only set
        // when OpenRouter actually returns it — undefined (not 0) when
        // absent, so callers can distinguish "confirmed $0" from "unknown,
        // fall back to an estimate."
        ...(typeof data['usage']?.cost === 'number' ? { costUsd: data['usage'].cost } : {}),
        // OpenRouter reports this per model. Measured 2026-08-10 on z-ai/glm-5.2: 0 cached and
        // 0 written on an identical 23,247-token prefix, WITH and WITHOUT an explicit
        // cache_control breakpoint — that model does not cache, and recording the measured
        // zero is what makes the comparison against a caching model arguable from evidence.
        ...(typeof data['usage']?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cachedInputTokens: data['usage'].prompt_tokens_details.cached_tokens }
          : {}),
      },
    };
  }

  private async streamOpenRouter(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.applyExactoSuffix(this.resolveModel(request.model));
    const messages = this.formatMessages(request.messages, request.systemPrompt);
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const response = await postOpenRouter(`${this.baseURL}/chat/completions`, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://epam.com',
        'X-Title': 'EPAM CLI',
        ...(this.openRouterMode ? { 'x-session-id': openRouterSessionId() } : {}),
      }, {
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
        // Sticky routing — see openRouterSessionId(). Sent in the body as well as the header
        // because the documented activation path is the body field; the header is belt-and-braces.
        ...(this.openRouterMode ? { session_id: openRouterSessionId() } : {}),
        ...(this.openRouterMode && openRouterProviderOrder()
          ? { provider: { order: openRouterProviderOrder(), allow_fallbacks: false } } : {}),
        stream: true,
        // Streaming mode needs BOTH flags: stream_options.include_usage asks
        // for a final usage-only chunk at all (off by default when
        // streaming), and usage.include asks that chunk to include real
        // billed cost — same rationale as completeOpenRouter above.
        stream_options: { include_usage: true },
        usage: { include: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...this.resolveOpenRouterReasoning(request),
        ...(this.resolveResponseFormat(request) ? { response_format: this.resolveResponseFormat(request) } : {}),
        // OpenRouter may route to an upstream provider that does not support
        // response_format — it drops the parameter and returns UNBOUND output that
        // looks like a success. require_parameters pins routing to a provider that
        // honours everything we sent, or fails loudly instead of silently
        // downgrading the contract.
        ...(this.openRouterMode && this.resolveResponseFormat(request)
          ? { provider: { require_parameters: true } } : {}),
      });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter/OpenRouter API error: ${response.status} ${error}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let cachedInputTokens: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n').filter(l => l.startsWith('data:'))) {
        const data = line.substring(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            accumulatedText += choice.delta.content;
            handler({ type: 'text_delta', text: choice.delta.content });
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              }
              const existing = toolCalls.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
                handler({ type: 'tool_delta', id: existing.id, name: existing.name, input: tc.function.arguments });
              }
            }
          }
          if (choice?.finish_reason) stopReason = this.mapStopReason(choice.finish_reason);
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            // The STREAMING path builds its own usage object — patching complete() alone
            // left cached tokens undefined end-to-end while unit tests on both sides passed.
            if (typeof parsed.usage.prompt_tokens_details?.cached_tokens === 'number') {
              cachedInputTokens = parsed.usage.prompt_tokens_details.cached_tokens;
            }
            outputTokens = parsed.usage.completion_tokens || 0;
            if (typeof parsed.usage.cost === 'number') costUsd = parsed.usage.cost;
          }
        } catch { /* skip malformed */ }
      }
    }

    const content: ContentPart[] = [];
    if (accumulatedText) content.push({ type: 'text', text: stripThinkingBlocks(accumulatedText) });
    for (const tc of toolCalls.values()) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
      });
    }
    if (toolCalls.size > 0) stopReason = 'tool_use';

    // Fallback: model streamed no API tool_calls but may have emitted markup in text
    if (toolCalls.size === 0 && accumulatedText) {
      const { toolUses, cleanText } = parseMarkupToolCalls(accumulatedText);
      if (toolUses.length > 0) {
        const stripped = stripThinkingBlocks(cleanText);
        content.length = 0;
        if (stripped) content.push({ type: 'text', text: stripped });
        content.push(...toolUses);
        stopReason = 'tool_use';
      }
    }

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: accumulatedText }],
      stopReason,
      usage: { inputTokens, outputTokens, ...(costUsd != null ? { costUsd } : {}),
        ...(cachedInputTokens != null ? { cachedInputTokens } : {}) },
    };
  }

  // ─── DashScope (Alibaba native) ────────────────────────────────────────────

  private async completeDashScope(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/services/aigc/text-generation/generation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: { messages },
          parameters: {
            max_tokens: request.maxTokens || 4096,
            temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
            result_format: 'message',
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json() as Record<string, any>;

      const choice = data['output']?.choices?.[0];
      if (!choice) {
        throw new Error('OpenRouter API returned no choices');
      }

      const content: ContentPart[] = [
        { type: 'text', text: choice.message?.content || '' }
      ];

      return {
        content,
        stopReason: this.mapStopReason(choice.finish_reason),
        usage: {
          inputTokens: data['usage']?.input_tokens || 0,
          outputTokens: data['usage']?.output_tokens || 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'OpenRouterProvider complete failed');
      throw err;
    }
  }

  private async streamDashScope(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/services/aigc/text-generation/generation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify({
          model,
          input: { messages },
          parameters: {
            max_tokens: request.maxTokens || 4096,
            temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
            result_format: 'message',
            incremental_output: true,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let accumulatedText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: ProviderResponse['stopReason'] = 'end_turn';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.startsWith('data:'));

        for (const line of lines) {
          const data = line.substring(5).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            
            const choice = parsed.output?.choices?.[0];
            if (choice) {
              const delta = choice.message?.content || '';
              if (delta) {
                accumulatedText += delta;
                handler({ type: 'text_delta', text: delta });
              }

              if (choice.finish_reason) {
                stopReason = this.mapStopReason(choice.finish_reason);
              }
            }

            if (parsed.usage) {
              inputTokens = parsed.usage.input_tokens || 0;
              outputTokens = parsed.usage.output_tokens || 0;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      const content: ContentPart[] = [
        { type: 'text', text: accumulatedText }
      ];

      return {
        content,
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'OpenRouterProvider stream failed');
      throw err;
    }
  }

  /**
   * Format messages for OpenAI-compatible API (OpenRouter or DashScope)
   */
  private formatMessages(messages: Message[], systemPrompt?: string): any[] {
    const formatted: any[] = [];

    if (systemPrompt) {
      formatted.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          formatted.push({ role: 'assistant', content: msg.content });
        } else {
          const toolCalls = (msg.content as ContentPart[])
            .filter(p => p.type === 'tool_use')
            .map(p => ({
              id: p.id ?? '',
              type: 'function' as const,
              function: { name: p.name ?? '', arguments: JSON.stringify(p.input ?? {}) },
            }));
          const textPart = (msg.content as ContentPart[]).find(p => p.type === 'text')?.text;
          formatted.push({
            role: 'assistant',
            content: textPart ?? null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      } else if (msg.role === 'tool') {
        // Convert tool results to OpenAI tool role
        const parts = Array.isArray(msg.content) ? msg.content as ContentPart[] : [];
        for (const part of parts) {
          if (part.type === 'tool_result') {
            formatted.push({
              role: 'tool',
              tool_call_id: part.tool_use_id ?? '',
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            });
          }
        }
        // Fallback if content is a plain string
        if (typeof msg.content === 'string') {
          formatted.push({ role: 'user', content: `Tool result: ${msg.content}` });
        }
      } else {
        // Detect tool results sent as user role (AgentRunner uses role:'user' for tool results)
        const parts = Array.isArray(msg.content) ? msg.content as ContentPart[] : [];
        const toolResults = parts.filter(p => p.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const part of toolResults) {
            formatted.push({
              role: 'tool',
              tool_call_id: part.tool_use_id ?? '',
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            });
          }
        } else {
          formatted.push({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          });
        }
      }
    }

    return formatted;
  }

  /**
   * Map OpenRouter finish_reason to our format
   */
  private mapStopReason(reason?: string): ProviderResponse['stopReason'] {
    switch (reason) {
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'stop':
      default:
        return 'end_turn';
    }
  }
}

/**
 * Factory function to create OpenRouter provider
 */
export function createOpenRouterProvider(apiKey?: string, model?: string): OpenRouterProvider | null {
  // ONE ROUTE. There were two: OpenRouter, and DashScope — Alibaba's DIRECT openrouter API, reached with
  // DASHSCOPE_API_KEY or a vendor-direct key. That second route WAS the openrouter provider, and OpenRouter
  // replaced it, so it is removed rather than renamed. Renaming it produced a variable called
  // dashScopeKey falling back to the OpenRouter key, and two names reading one environment
  // variable — a rename where a deprecation was asked for.
  const key = apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.EPAM_API_KEY_OPENROUTER;

  if (!key) {
    logger.warn('OpenRouter API key not found. Set OPENROUTER_API_KEY or use /provider auth openrouter');
    return null;
  }

  const baseURL = process.env.OPENROUTER_BASE_URL || undefined;
  return new OpenRouterProvider({ apiKey: key, openRouterMode: true, baseURL });
}
