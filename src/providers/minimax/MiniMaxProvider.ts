/**
 * MiniMax Provider
 *
 * MiniMax AI API — OpenAI-compatible chat/completions endpoint.
 * https://api.minimaxi.chat/v1
 *
 * Models: MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed,
 *         MiniMax-M2.5, MiniMax-M2.5-highspeed
 *
 * Set MINIMAX_API_KEY (sk-api-...) to enable.
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { resolveTemperature, resolveTopP } from '../types.js';
import { stripThinkingBlocks, parseMarkupToolCalls } from '../qwen/QwenProvider.js';
import { logger } from '../../utils/logger.js';

export const MINIMAX_BASE_URL = 'https://api.minimaxi.chat/v1';

export class MiniMaxProvider implements LLMProvider {
  readonly name = 'minimax';
  readonly defaultModel = 'MiniMax-M2.5';

  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL ?? MINIMAX_BASE_URL;
  }

  private resolveModel(requested?: string): string {
    const override = process.env.EPAM_MINIMAX_MODEL_OVERRIDE;
    if (override) return override;
    if (requested) return requested;
    return this.defaultModel;
  }

  /** MiniMax reasoning effort — passed as `reasoning_effort` when the model supports it.
   *  Falls back to env var EPAM_REASONING_EFFORT. Returns undefined when not set. */
  private resolveReasoningEffort(request: ProviderRequest): string | undefined {
    return request.reasoningEffort ?? process.env.EPAM_REASONING_EFFORT as string | undefined;
  }

  /** Rough token count from raw text (1 token ≈ 4 chars for English/code).
   *  Used as a fallback when the MiniMax API doesn't return usage data. */
  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private estimateInputTokens(request: ProviderRequest): number {
    const parts: string[] = [];
    if (request.systemPrompt) parts.push(request.systemPrompt);
    for (const m of request.messages) {
      parts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }
    return this.estimateTokens(parts.join(' '));
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const reasoningEffort = this.resolveReasoningEffort(request);

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(this.resolveResponseFormat(request) ? { response_format: this.resolveResponseFormat(request) } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data['choices']?.[0];
    if (!choice) throw new Error('MiniMax returned no choices');

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

    // Fallback: markup-style tool calls in text (e.g. <function=...>)
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
    const rawIn  = data['usage']?.prompt_tokens     || 0;
    const rawOut = data['usage']?.completion_tokens || 0;
    // When MiniMax returns no token counts (prompt_tokens/completion_tokens both 0)
    // despite a real response, fall back to character-count estimates so the
    // pricing-table fallback in append_cost_record has non-zero input to work from.
    const outputText = content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
    const inputTokens  = rawIn  > 0 ? rawIn  : this.estimateInputTokens(request);
    const outputTokens = rawOut > 0 ? rawOut : (outputText.length > 0 || hasToolUse ? this.estimateTokens(outputText || JSON.stringify(content)) : 0);
    return {
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      stopReason: hasToolUse ? 'tool_use' : this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens,
        outputTokens,
        // MiniMax's direct API (unlike OpenRouter) does not document a
        // real-cost field in its chat/completions response — confirmed via
        // their public API docs, which only list prompt_tokens/
        // completion_tokens/total_tokens under usage. This is a defensive,
        // opportunistic read in case one is added later; it is NOT a
        // guaranteed contract like OpenRouter's usage.include=true, so
        // MiniMax cost stays estimate-only (via src/billing/pricing.ts)
        // until/unless a separate MiniMax account/usage-API integration is
        // built (see feedback_real_cost_tracking_critical memory).
        ...(typeof data['usage']?.total_cost === 'number' ? { costUsd: data['usage'].total_cost } : {}),
        // MiniMax caches prompt prefixes automatically — no cache_control breakpoint is sent
        // or needed. Measured 2026-08-10: an identical 13,676-token prefix returned
        // cached_tokens=128 cold and 13,568 warm (99.2%). Reading it is what makes the
        // pipeline's cache_read_tokens a real number instead of a permanent zero.
        ...(typeof data['usage']?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cachedInputTokens: data['usage'].prompt_tokens_details.cached_tokens }
          : {}),
      },
    };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const reasoningEffort = this.resolveReasoningEffort(request);
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: resolveTemperature(request, 0.7),
        ...(resolveTopP(request) !== undefined ? { top_p: resolveTopP(request) } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(this.resolveResponseFormat(request) ? { response_format: this.resolveResponseFormat(request) } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} ${error}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let inputTokens = 0;
    let cachedInputTokens: number | undefined;
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
            // The STREAMING path builds its own usage object. Patching only complete()
            // left this undefined end-to-end while every unit test passed — the CLI streams.
            if (typeof parsed.usage.prompt_tokens_details?.cached_tokens === 'number') {
              cachedInputTokens = parsed.usage.prompt_tokens_details.cached_tokens;
            }
            outputTokens = parsed.usage.completion_tokens || 0;
            // See completeOpenRouter/complete's comment: not a documented
            // MiniMax field, opportunistic only.
            if (typeof parsed.usage.total_cost === 'number') costUsd = parsed.usage.total_cost;
          }
        } catch { /* skip malformed chunk */ }
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

    // MiniMax streaming may not honour stream_options.include_usage, leaving both
    // counts at 0. Fall back to character-count estimates so the pricing-table
    // fallback in append_cost_record has non-zero input to work from.
    const finalIn  = inputTokens  > 0 ? inputTokens  : (accumulatedText || toolCalls.size > 0 ? this.estimateInputTokens(request) : 0);
    const finalOut = outputTokens > 0 ? outputTokens : (accumulatedText.length > 0 ? this.estimateTokens(accumulatedText) : (toolCalls.size > 0 ? this.estimateTokens(JSON.stringify([...toolCalls.values()])) : 0));

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: accumulatedText }],
      stopReason,
      usage: { inputTokens: finalIn, outputTokens: finalOut, ...(costUsd != null ? { costUsd } : {}),
        ...(cachedInputTokens != null ? { cachedInputTokens } : {}) },
    };
  }

  private resolveResponseFormat(request: ProviderRequest): Record<string, unknown> | undefined {
    // Explicit request field takes priority; env var EPAM_MINIMAX_JSON_MODE=1 as fallback.
    const rf = request.responseFormat;
    if (rf && rf !== 'json_object') {
      // Pass a schema contract straight through. Deliberately NOT downgraded to
      // json_object: silently weakening a declared contract to "syntactically
      // valid JSON" would hand back unbound output that looks bound. If MiniMax
      // rejects it, that is a loud API error, which is the correct outcome.
      return { type: 'json_schema', json_schema: { name: rf.name, strict: rf.strict !== false, schema: rf.schema } };
    }
    if (rf === 'json_object') return { type: 'json_object' };
    if (process.env.EPAM_MINIMAX_JSON_MODE === '1') return { type: 'json_object' };
    return undefined;
  }

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
        if (typeof msg.content === 'string') {
          formatted.push({ role: 'user', content: `Tool result: ${msg.content}` });
        }
      } else {
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

  private mapStopReason(reason?: string): ProviderResponse['stopReason'] {
    switch (reason) {
      case 'tool_calls': return 'tool_use';
      case 'length':     return 'max_tokens';
      case 'stop':
      default:           return 'end_turn';
    }
  }
}

export function createMiniMaxProvider(): MiniMaxProvider | null {
  const apiKey = process.env.MINIMAX_API_KEY ?? process.env.EPAM_API_KEY_MINIMAX;
  if (!apiKey) {
    logger.warn('MiniMax API key not found. Set MINIMAX_API_KEY or EPAM_API_KEY_MINIMAX');
    return null;
  }
  const baseURL = process.env.MINIMAX_BASE_URL || undefined;
  return new MiniMaxProvider(apiKey, baseURL);
}
