// ── TracedProvider — Langfuse-instrumented LLMProvider decorator ─────────────
//
// Wraps any LLMProvider so every stream()/complete() call is recorded as a
// Langfuse trace + generation.  Captures: model, token usage, cost, latency,
// tool calls, stop reason.  Falls through transparently when Langfuse is
// disabled — zero overhead in that case.

import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
  ContentPart,
} from '../providers/types.js';
import { getLangfuse, isLangfuseEnabled } from './LangfuseTracer.js';
import { emitLlmSpan, isOtelEnabled } from './OtelTracer.js';
import { calculateCost } from '../billing/pricing.js';
import { logger } from '../utils/logger.js';

export class TracedProvider implements LLMProvider {
  readonly name: string;
  readonly defaultModel: string;

  constructor(
    private inner: LLMProvider,
    sessionId?: string,
    private userId?: string,
  ) {
    this.name = inner.name;
    this.defaultModel = inner.defaultModel;
    // Group traces by pipeline run. Every orchestration agent call is a separate
    // `epam run` subprocess, so an explicit sessionId rarely reaches us — without
    // a fallback every trace got sessionId:null and all runs piled into one
    // undifferentiated stream. That is not cosmetic: on 2026-07-24 a per-model
    // cost table built from Langfuse silently blended a killed run's traces with
    // the live run's and had to be retracted. ORCH_RUN_ID is already exported by
    // the orchestration scripts and inherited by every child process.
    this.sessionId = sessionId ?? process.env.ORCH_RUN_ID ?? undefined;
  }

  private sessionId?: string;

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const langfuseEnabled = isLangfuseEnabled();
    const langfuse = langfuseEnabled ? getLangfuse() : null;

    const trace = langfuse?.trace({
      name: 'llm-complete',
      sessionId: this.sessionId,
      userId: this.userId,
      metadata: { provider: this.name, model: request.model },
    });

    const generation = trace?.generation({
      name: `${this.name}:complete`,
      model: request.model,
      input: this.summarizeInput(request),
      modelParameters: {
        ...(request.maxTokens != null && { maxTokens: request.maxTokens }),
        ...(request.temperature != null && { temperature: request.temperature }),
      },
    });

    const start = Date.now();
    try {
      const response = await this.inner.complete(request);
      const latencyMs = Date.now() - start;
      const cost = calculateCost(request.model, response.usage.inputTokens, response.usage.outputTokens);
      const toolCalls = response.content.filter(p => p.type === 'tool_use').length;

      generation?.end({
        output: this.summarizeOutput(response),
        usage: { input: response.usage.inputTokens, output: response.usage.outputTokens, totalCost: cost },
        metadata: { stopReason: response.stopReason, toolCalls, latencyMs },
      });

      emitLlmSpan({
        provider: this.name, model: request.model, operation: 'complete',
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        costUsd: cost, latencyMs, toolCalls, stopReason: response.stopReason,
      });

      return response;
    } catch (error) {
      const latencyMs = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      generation?.end({ level: 'ERROR', statusMessage: msg, metadata: { latencyMs } });
      emitLlmSpan({
        provider: this.name, model: request.model, operation: 'complete',
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs, error: msg,
      });
      throw error;
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const langfuseEnabled = isLangfuseEnabled();
    const langfuse = langfuseEnabled ? getLangfuse() : null;

    const trace = langfuse?.trace({
      name: 'llm-stream',
      sessionId: this.sessionId,
      userId: this.userId,
      metadata: { provider: this.name, model: request.model },
    });

    const generation = trace?.generation({
      name: `${this.name}:stream`,
      model: request.model,
      input: this.summarizeInput(request),
      modelParameters: {
        ...(request.maxTokens != null && { maxTokens: request.maxTokens }),
        ...(request.temperature != null && { temperature: request.temperature }),
      },
    });

    let toolCallCount = 0;
    const wrappedHandler: StreamHandler = (delta) => {
      if (delta.type === 'tool_delta') toolCallCount++;
      handler(delta);
    };

    const start = Date.now();
    try {
      const response = await this.inner.stream(request, wrappedHandler);
      const latencyMs = Date.now() - start;
      const cost = calculateCost(request.model, response.usage.inputTokens, response.usage.outputTokens);
      const toolCalls = response.content.filter(p => p.type === 'tool_use').length;

      generation?.end({
        output: this.summarizeOutput(response),
        usage: { input: response.usage.inputTokens, output: response.usage.outputTokens, totalCost: cost },
        metadata: { stopReason: response.stopReason, toolCalls, latencyMs, streaming: true },
      });

      emitLlmSpan({
        provider: this.name, model: request.model, operation: 'stream',
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        costUsd: cost, latencyMs, toolCalls, stopReason: response.stopReason,
      });

      return response;
    } catch (error) {
      const latencyMs = Date.now() - start;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      generation?.end({ level: 'ERROR', statusMessage: msg, metadata: { latencyMs } });
      emitLlmSpan({
        provider: this.name, model: request.model, operation: 'stream',
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs, error: msg,
      });
      throw error;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Full capture, not a metadata summary: this trace only ever goes to a
  // self-hosted, local-only Langfuse instance (LANGFUSE_BASE_URL defaults to
  // localhost) — there is no third-party exposure to guard against, and the
  // whole point of tracing is to be able to actually read what an agent was
  // told and what it said back. A prior version of this method dropped the
  // system prompt entirely (kept only a boolean), truncated the last user
  // message to 200 chars, and never captured the response text at all (only
  // its length) — meaning no prompt or completion was ever really
  // inspectable via Langfuse, defeating the purpose of tracing them.
  // MAX_CAPTURE_CHARS guards only against a pathological runaway payload
  // (e.g. a tool result dumping an entire file), not normal prompt sizes.
  private static readonly MAX_CAPTURE_CHARS = 200_000;

  private truncateForCapture(text: string): string {
    return text.length > TracedProvider.MAX_CAPTURE_CHARS
      ? text.slice(0, TracedProvider.MAX_CAPTURE_CHARS) + `...[truncated, ${text.length} chars total]`
      : text;
  }

  private contentPartsToText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    return content.map(p => {
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'tool_use') return `[tool_use: ${p.name}(${JSON.stringify(p.input)})]`;
      if (p.type === 'tool_result') {
        const inner = typeof p.content === 'string' ? p.content : this.contentPartsToText(p.content ?? []);
        return `[tool_result: ${inner}]`;
      }
      return `[${p.type}]`;
    }).join('\n');
  }

  private summarizeInput(request: ProviderRequest): Record<string, unknown> {
    return {
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      systemPrompt: request.systemPrompt
        ? this.truncateForCapture(request.systemPrompt)
        : null,
      messages: request.messages.map(m => ({
        role: m.role,
        content: this.truncateForCapture(this.contentPartsToText(m.content)),
      })),
      tools: request.tools?.map(t => t.name) ?? [],
    };
  }

  private summarizeOutput(response: ProviderResponse): Record<string, unknown> {
    const textParts = response.content.filter(p => p.type === 'text');
    const toolUses = response.content.filter(p => p.type === 'tool_use');
    const fullText = textParts.map(p => p.text ?? '').join('');
    return {
      stopReason: response.stopReason,
      text: this.truncateForCapture(fullText),
      textLength: fullText.length,
      toolCalls: toolUses.map(t => ({ name: t.name, input: t.input })),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
  }
}

/**
 * Wrap a provider with Langfuse tracing if enabled.
 * Returns the original provider unchanged if Langfuse is not configured.
 */
export function wrapWithTracing(
  provider: LLMProvider,
  opts?: { sessionId?: string; userId?: string },
): LLMProvider {
  if (!isLangfuseEnabled() && !isOtelEnabled()) {
    logger.debug('No tracing backend configured — provider tracing disabled');
    return provider;
  }
  const backends = [isLangfuseEnabled() && 'langfuse', isOtelEnabled() && 'otel'].filter(Boolean).join('+');
  logger.debug({ provider: provider.name, backends }, 'Wrapping provider with tracing');
  return new TracedProvider(provider, opts?.sessionId, opts?.userId);
}
