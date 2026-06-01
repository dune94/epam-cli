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
    private sessionId?: string,
    private userId?: string,
  ) {
    this.name = inner.name;
    this.defaultModel = inner.defaultModel;
  }

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

  private summarizeInput(request: ProviderRequest): Record<string, unknown> {
    return {
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      hasSystemPrompt: !!request.systemPrompt,
      lastUserMessage: this.extractLastUserMessage(request),
    };
  }

  private summarizeOutput(response: ProviderResponse): Record<string, unknown> {
    const textParts = response.content.filter(p => p.type === 'text');
    const toolUses = response.content.filter(p => p.type === 'tool_use');
    return {
      stopReason: response.stopReason,
      textLength: textParts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0),
      toolCalls: toolUses.map(t => t.name).filter(Boolean),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
  }

  private extractLastUserMessage(request: ProviderRequest): string {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const msg = request.messages[i];
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
        return text.length > 200 ? text.slice(0, 197) + '...' : text;
      }
    }
    return '';
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
