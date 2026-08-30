/**
 * The TRACE-level input must not be truncated shorter than the generation it belongs to.
 *
 * Live, still visible in Langfuse 2026-08-05 after an earlier truncation sweep removed
 * hardcoded truncations elsewhere: the top-level trace's `input` field is built by
 * `tracePreview()`, hard-capped at 600 characters with no config knob, while the nested
 * generation's `input` (built by `summarizeInput` / `truncateForCapture`) carries up to
 * 200,000 characters. Langfuse renders the trace-level input directly in its list/summary
 * view, so a prompt that is fully captured one level down still reads as cut off from the
 * view a user actually scans first.
 *
 * There is no reason for these two to differ — the file's own comment on
 * `truncateForCapture` already establishes that this traces to a self-hosted, local-only
 * Langfuse instance with no third-party exposure to guard against.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider, ProviderRequest, ProviderResponse } from '../../../src/providers/types';

const traceCalls: any[] = [];
const traceUpdates: any[] = [];

vi.mock('../../../src/observability/LangfuseTracer.js', () => ({
  isLangfuseEnabled: () => true,
  getLangfuse: () => ({
    trace: (args: any) => {
      traceCalls.push(args);
      return {
        update: (u: any) => traceUpdates.push(u),
        generation: () => ({ end: () => {} }),
      };
    },
  }),
}));
vi.mock('../../../src/observability/OtelTracer.js', () => ({
  emitLlmSpan: () => {},
  isOtelEnabled: () => false,
}));

function fakeProvider(responseText: string): LLMProvider {
  return {
    name: 'openrouter',
    complete: async (_req: ProviderRequest): Promise<ProviderResponse> => ({
      content: [{ type: 'text', text: responseText } as any],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  } as unknown as LLMProvider;
}

describe('TracedProvider — trace-level input/output are not truncated below the generation', () => {
  beforeEach(() => { traceCalls.length = 0; traceUpdates.length = 0; vi.resetModules(); });

  it('THE BUG: a prompt over 600 chars is not cut off in the trace-level input', async () => {
    const { wrapWithTracing } = await import('../../../src/observability/TracedProvider');
    const p = wrapWithTracing(fakeProvider('ok'));
    const longPrompt = 'x'.repeat(5000);
    await p.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: longPrompt }],
    } as any);

    expect(traceCalls).toHaveLength(1);
    expect(
      traceCalls[0].input,
      'the trace-level input field is what Langfuse shows in the list/summary view; ' +
        'cutting it to 600 chars is truncation the user sees even though the generation ' +
        'one level down captured everything',
    ).toContain(longPrompt);
  });

  it('a long response is not cut off in the trace-level output', async () => {
    const { wrapWithTracing } = await import('../../../src/observability/TracedProvider');
    const p = wrapWithTracing(fakeProvider('y'.repeat(5000)));
    await p.complete({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] } as any);

    expect(traceUpdates).toHaveLength(1);
    const outputText = typeof traceUpdates[0].output === 'string'
      ? traceUpdates[0].output
      : JSON.stringify(traceUpdates[0].output);
    expect(outputText).toContain('y'.repeat(5000));
  });

  it('still guards against a truly pathological payload (the 200k safety net)', async () => {
    const { wrapWithTracing } = await import('../../../src/observability/TracedProvider');
    const p = wrapWithTracing(fakeProvider('ok'));
    const huge = 'x'.repeat(300_000);
    await p.complete({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: huge }] } as any);

    expect(
      traceCalls[0].input.length,
      'unbounded capture of a runaway payload would be its own defect',
    ).toBeLessThan(huge.length);
  });
});
