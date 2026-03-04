/**
 * CodexProvider — first-response timing contract
 *
 * The native `codex` CLI returns an initial response in <5s.
 * CodexProvider must match this by using --json streaming and returning
 * after the first turn.completed event, not the full agentic loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock execa so we control the codex --json event stream
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { CodexProvider } from '../../../src/providers/codex/CodexProvider.js';

function makeJsonStream(events: object[], delayMs = 10): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const stdout = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.kill = vi.fn();

  // Emit events asynchronously, simulating real codex output
  (async () => {
    for (const event of events) {
      await new Promise(r => setTimeout(r, delayMs));
      stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    await new Promise(r => setTimeout(r, delayMs));
    proc.emit('exit', 0);
  })();

  return proc;
}

function makeRequest(messages: { role: string; content: string }[]) {
  return {
    messages: messages as any,
    systemPrompt: 'You are a helpful assistant.',
    stream: false,
  };
}

describe('CodexProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress timer output in tests
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('returns first agent message after turn.completed — not full loop', async () => {
    const provider = new CodexProvider();

    // Simulate: first turn returns quickly, then codex starts exec loop
    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'thread.started', thread_id: 'test-123' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I will build the game!' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
      // These exec events should NOT be waited for:
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'function_call', name: 'shell', args: 'ls' } },
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 5 } },
    ]) as any);

    const start = Date.now();
    const response = await provider.complete(makeRequest([
      { role: 'user', content: 'Build a Game of Life app' },
    ]));
    const elapsed = Date.now() - start;

    expect(response.content[0]).toMatchObject({ type: 'text', text: 'I will build the game!' });
    // Should return after first turn, not wait for exec loop
    expect(elapsed).toBeLessThan(500); // mock is fast; real codex is <5s
  });

  it('uses resume <thread_id> for follow-up messages (not --last)', async () => {
    const provider = new CodexProvider();

    // First turn — sets threadId
    vi.mocked(execa).mockReturnValueOnce(makeJsonStream([
      { type: 'thread.started', thread_id: 'abc-123' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'First response.' } },
      { type: 'turn.completed', usage: {} },
    ]) as any);

    await provider.complete(makeRequest([{ role: 'user', content: 'First message' }]));

    // Second turn — should resume with exact thread_id
    vi.mocked(execa).mockReturnValueOnce(makeJsonStream([
      { type: 'thread.started', thread_id: 'abc-123' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Follow-up response.' } },
      { type: 'turn.completed', usage: {} },
    ]) as any);

    await provider.complete(makeRequest([
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response.' },
      { role: 'user', content: 'Follow up question' },
    ]));

    const [, args] = vi.mocked(execa).mock.calls[1] as [string, string[]];
    expect(args).toContain('resume');
    expect(args).toContain('abc-123');
    expect(args).not.toContain('--last');
  });

  it('does not use resume for first message', async () => {
    const provider = new CodexProvider();

    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Hello!' } },
      { type: 'turn.completed', usage: {} },
    ]) as any);

    await provider.complete(makeRequest([
      { role: 'user', content: 'Hello' },
    ]));

    const [, args] = vi.mocked(execa).mock.calls[0] as [string, string[]];
    expect(args).not.toContain('resume');
  });

  it('passes --model flag when model is set', async () => {
    const provider = new CodexProvider('o4-mini');

    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: {} },
    ]) as any);

    await provider.complete(makeRequest([{ role: 'user', content: 'hi' }]));

    const [, args] = vi.mocked(execa).mock.calls[0] as [string, string[]];
    expect(args).toContain('--model');
    expect(args).toContain('o4-mini');
  });

  it('kills the process after receiving first turn.completed', async () => {
    const provider = new CodexProvider();
    const proc = makeJsonStream([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'response' } },
      { type: 'turn.completed', usage: {} },
    ]);

    vi.mocked(execa).mockReturnValue(proc as any);
    await provider.complete(makeRequest([{ role: 'user', content: 'hi' }]));

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns (no response) if no agent message arrives before exit', async () => {
    const provider = new CodexProvider();

    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'turn.started' },
      { type: 'turn.completed', usage: {} }, // completed with no message
    ]) as any);

    const response = await provider.complete(makeRequest([{ role: 'user', content: 'hi' }]));
    expect(response.content[0]).toMatchObject({ type: 'text', text: '(no response)' });
  });
});
