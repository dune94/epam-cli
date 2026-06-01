// ── OtelTracer — OpenTelemetry span emission for LLM calls ───────────────────
//
// Emits one span per LLM call to an OTLP-compatible backend when
// OTEL_EXPORTER_OTLP_ENDPOINT is set.  When the env var is absent,
// every function in this module is a no-op — zero overhead.
//
// Langfuse tracing in TracedProvider is unaffected.  Both can be active
// simultaneously; they are independent decorators on the same call path.

import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';

let _tracer: Tracer | null = null;

function getTracer(): Tracer | null {
  if (_tracer !== null) return _tracer;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  // Lazy-init: only load heavy SDK modules when actually needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node') as typeof import('@opentelemetry/sdk-trace-node');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http') as typeof import('@opentelemetry/exporter-trace-otlp-http');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resourceFromAttributes } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions') as typeof import('@opentelemetry/semantic-conventions');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base') as typeof import('@opentelemetry/sdk-trace-base');

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'epam-cli' }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
  });

  provider.register();
  _tracer = trace.getTracer('epam-cli', '1.0.0');
  return _tracer;
}

export interface LlmSpanAttrs {
  provider: string;
  model: string;
  operation: 'complete' | 'stream';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  toolCalls?: number;
  stopReason?: string;
  error?: string;
}

export function emitLlmSpan(attrs: LlmSpanAttrs): void {
  const tracer = getTracer();
  if (!tracer) return;

  const span = tracer.startSpan(`llm.${attrs.operation}`);
  span.setAttributes({
    'llm.provider': attrs.provider,
    'llm.model': attrs.model,
    'llm.operation': attrs.operation,
    'llm.usage.input_tokens': attrs.inputTokens,
    'llm.usage.output_tokens': attrs.outputTokens,
    'llm.usage.cost_usd': attrs.costUsd,
    'llm.latency_ms': attrs.latencyMs,
    ...(attrs.toolCalls != null && { 'llm.tool_calls': attrs.toolCalls }),
    ...(attrs.stopReason && { 'llm.stop_reason': attrs.stopReason }),
  });

  if (attrs.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: attrs.error });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

export function isOtelEnabled(): boolean {
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}
