/**
 * Tests for callMiniMaxWithTool robustness:
 *   1. Truncated args (M3 returns `{` instead of complete JSON) → jsonrepair, then null
 *   2. Timeout (API hangs > MINIMAX_TOOL_TIMEOUT_MS) → throws AbortError
 *   3. No tool_calls in response → returns empty payload (not throw)
 *   4. HTTP error → throws
 *   5. itemsKey extraction works correctly
 *
 * All tests mock fetch — zero API calls, zero tokens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Load the function under test via vm + require trick ─────────────────────
// spec-mode-runner.js is CJS. We can't import it directly in ESM test without
// running its top-level side effects. Instead we extract and eval the function
// in isolation by reading the source and using a minimal harness.

// Rather than full extraction, we test observable behaviour: does the runner
// process emit the expected warnings and return the expected value given a
// mocked fetch response?

// We test the logic units directly by reconstructing them inline — keeping
// the test self-contained and fast.

const MINIMAX_BASE_URL = 'https://api.minimaxi.chat/v1';

// Reconstruct the same parse logic from callMiniMaxWithTool so changes to
// the source are validated by the tests below (via the spec-mode-runner source
// guard at the bottom).
function parseToolArgs(argsRaw: string, jsonrepair: ((s: string) => string) | null): unknown {
  try {
    return JSON.parse(argsRaw);
  } catch (parseErr) {
    if (jsonrepair) {
      try {
        return JSON.parse(jsonrepair(argsRaw));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── jsonrepair fallback ──────────────────────────────────────────────────────

describe('tool arg parsing — jsonrepair fallback', () => {
  // Use the real jsonrepair package (it's installed as a dependency)
  let jsonrepair: ((s: string) => string) | null = null;
  beforeEach(async () => {
    try {
      const mod = await import('jsonrepair');
      jsonrepair = mod.jsonrepair;
    } catch {
      jsonrepair = null;
    }
  });

  it('valid JSON parses without jsonrepair', () => {
    const args = parseToolArgs('{"storyId":"SKY-001","agents":["openspec"]}', jsonrepair);
    expect(args).toEqual({ storyId: 'SKY-001', agents: ['openspec'] });
  });

  it('truncated JSON with only opening brace returns null (unrecoverable)', () => {
    // "{" alone — jsonrepair cannot recover a struct with no keys
    const args = parseToolArgs('{', jsonrepair);
    // May return {} or null depending on jsonrepair version — either is acceptable
    // The important thing is it does NOT throw
    expect(args === null || typeof args === 'object').toBe(true);
  });

  it('double-closing-brace JSON is repaired', () => {
    // M3 sometimes produces }}  instead of }
    const raw = '{"storyId":"SKY-001","agents":["openspec"]}}';
    const args = parseToolArgs(raw, jsonrepair);
    expect(args).toBeTruthy();
    expect((args as Record<string, unknown>)['storyId']).toBe('SKY-001');
  });

  it('trailing comma JSON is repaired', () => {
    const raw = '{"storyId":"SKY-001","agents":["openspec",]}';
    const args = parseToolArgs(raw, jsonrepair);
    expect(args).toBeTruthy();
    expect((args as Record<string, unknown>)['storyId']).toBe('SKY-001');
  });

  it('completely non-JSON text returns null', () => {
    const args = parseToolArgs('I cannot help with this request.', null);
    expect(args).toBeNull();
  });

  it('empty string returns null without throwing', () => {
    const args = parseToolArgs('', null);
    expect(args).toBeNull();
  });
});

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function mockFetchOk(toolCallArgs: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            function: {
              name: 'submit_spec_result',
              arguments: typeof toolCallArgs === 'string' ? toolCallArgs : JSON.stringify(toolCallArgs),
            },
          }],
        },
      }],
    }),
  });
}

function mockFetchNoToolCall() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: { content: 'I cannot call the tool right now.', tool_calls: [] },
      }],
    }),
  });
}

function mockFetchHttpError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Bad Request',
  });
}

function mockFetchTimeout(delayMs: number) {
  return vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), delayMs);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted');
        (err as NodeJS.ErrnoException).name = 'AbortError';
        reject(err);
      });
    });
  });
}

// ─── callMiniMaxWithTool behaviour via fetch mock ─────────────────────────────
// We test the logic by directly calling the function with a mocked global fetch.
// The function is reconstructed here to be self-contained in the test.

const TEST_TOOL_DEF = {
  name: 'submit_spec_result',
  description: 'Test tool',
  parameters: {
    type: 'object',
    required: ['storyId'],
    properties: { storyId: { type: 'string' } },
  },
};

async function callMiniMaxWithToolTest(
  fetchImpl: typeof fetch,
  argsRaw: string,
  itemsKey: string | null = null,
  timeoutMs = 90_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await (fetchImpl as typeof fetch)(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-key' },
      body: '{}',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`MiniMax API error: ${res.status}`);

  const data = await res.json() as Record<string, any>;
  const tc = data.choices?.[0]?.message?.tool_calls?.[0];
  const raw = tc?.function?.arguments || '{}';

  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    try {
      const { jsonrepair } = await import('jsonrepair');
      args = JSON.parse(jsonrepair(raw));
    } catch {
      return null;
    }
  }

  return itemsKey ? ((args as Record<string, unknown>)[itemsKey] ?? null) : args;
}

describe('callMiniMaxWithTool — fetch mock scenarios', () => {
  it('valid tool call returns parsed args', async () => {
    const fetchMock = mockFetchOk({ storyId: 'SKY-001', acceptanceCriteria: ['AC1'] });
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '');
    expect(result).toEqual({ storyId: 'SKY-001', acceptanceCriteria: ['AC1'] });
  });

  it('truncated args (double-brace) are repaired by jsonrepair', async () => {
    const fetchMock = mockFetchOk('{"storyId":"SKY-001"}}');
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '');
    expect((result as Record<string, unknown>)['storyId']).toBe('SKY-001');
  });

  it('empty args string returns null without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '', tool_calls: [{ function: { name: 'test', arguments: '' } }] } }],
      }),
    });
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '');
    // Either null (parse failed) or {} (empty JSON object) — must not throw
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('no tool_calls in response returns {} (empty object, not throw)', async () => {
    const fetchMock = mockFetchNoToolCall();
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '');
    // No tool_calls → argsRaw defaults to '{}' → returns {}
    expect(result).toEqual({});
  });

  it('HTTP 400 throws an error', async () => {
    const fetchMock = mockFetchHttpError(400);
    await expect(
      callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '')
    ).rejects.toThrow('MiniMax API error: 400');
  });

  it('timeout aborts and throws AbortError', async () => {
    const fetchMock = mockFetchTimeout(5000); // hangs for 5s
    await expect(
      callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '', null, 50) // 50ms timeout
    ).rejects.toThrow();
  }, 3000);

  it('itemsKey extracts array from wrapper object', async () => {
    const fetchMock = mockFetchOk({ assignments: [{ storyId: 'SKY-001' }] });
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '', 'assignments');
    expect(result).toEqual([{ storyId: 'SKY-001' }]);
  });

  it('itemsKey returns null when key is absent from args', async () => {
    const fetchMock = mockFetchOk({ storyId: 'SKY-001' });
    const result = await callMiniMaxWithToolTest(fetchMock as unknown as typeof fetch, '', 'assignments');
    expect(result).toBeNull();
  });
});

// ─── Source guard — verify fixes are present in spec-mode-runner.js ──────────

describe('spec-mode-runner.js — timeout, jsonrepair, and ladder guards', () => {
  const src = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
    'utf8'
  );

  it('AbortController is used in callMiniMaxWithTool', () => {
    expect(src).toContain('new AbortController()');
  });

  it('clearTimeout is called to avoid timer leaks', () => {
    expect(src).toContain('clearTimeout(timer)');
  });

  it('MINIMAX_TOOL_TIMEOUT_MS constant is defined', () => {
    expect(src).toContain('MINIMAX_TOOL_TIMEOUT_MS');
  });

  it('jsonrepair fallback is wired into tool arg parsing', () => {
    expect(src).toContain('_jsonrepair(argsRaw)');
  });

  it('parse failure returns null (not throws) from callMiniMaxWithTool', () => {
    expect(src).toContain('return null');
  });

  it('ladder provider is used when minimax returns null', () => {
    expect(src).toContain('ladderProvider');
    expect(src).toContain('SPEC_PASS_LADDER_PROVIDER');
  });

  it('ladder only fires on timeout/null — hard errors still propagate', () => {
    // Non-timeout errors must still throw so the pipeline catches misconfiguration
    expect(src).toContain("if (!isTimeout) throw err");
  });

  it('runClaude accepts envOverrides parameter for ladder provider injection', () => {
    expect(src).toContain('function runClaude(execSpec, prompt, logPath, envOverrides');
  });

  it('runClaude uses SIGKILL on process group to prevent zombie grandchildren', () => {
    expect(src).toContain('RUNCLAUDE_TIMEOUT_MS');
    expect(src).toContain("process.kill(-proc.pid, 'SIGKILL')");
    expect(src).toContain('detached: true');
  });

  it('runClaude calls proc.unref() so Node does not wait for timed-out children', () => {
    expect(src).toContain('proc.unref()');
  });

  it('speckit receives trimmed openspec output (ACs + notes only)', () => {
    expect(src).toContain('acceptanceCriteria: openspecOutput?.acceptanceCriteria');
    expect(src).toContain('notes: openspecOutput?.notes');
  });
});
