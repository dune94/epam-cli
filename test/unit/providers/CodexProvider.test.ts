/**
 * CodexProvider — first-response timing contract
 *
 * The native `codex` CLI returns an initial response in <5s.
 * CodexProvider must match this by using --json streaming and returning
 * after the first item.completed agent_message — before tool calls execute.
 *
 * Session design: stateless. Each invocation is a fresh `codex exec`.
 * Multi-turn conversations inject prior history into the prompt as a
 * "Conversation history:" prefix. No `resume`, no thread_id — avoids
 * the hang caused by resuming an incomplete (mid-SIGTERM) session.
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
  proc.catch = vi.fn().mockReturnValue(proc);
  proc.pid = 12345;

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

  it('returns first agent message immediately — before tool calls execute', async () => {
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
    // Should return after first agent_message, not wait for exec loop
    expect(elapsed).toBeLessThan(500); // mock is fast; real codex is <5s
  });

  it('injects conversation history into fresh prompt for follow-ups (no resume)', async () => {
    const provider = new CodexProvider();

    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Follow-up response.' } },
      { type: 'turn.completed', usage: {} },
    ]) as any);

    await provider.complete(makeRequest([
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response.' },
      { role: 'user', content: 'Follow up question' },
    ]));

    const [, args] = vi.mocked(execa).mock.calls[0] as [string, string[]];
    // Must NOT use resume — that causes hangs on incomplete sessions
    expect(args).not.toContain('resume');
    // The prompt arg should contain history as a prefix
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain('Conversation history');
    expect(promptArg).toContain('First message');
    expect(promptArg).toContain('First response.');
    expect(promptArg).toContain('Follow up question');
  });

  it('sends raw prompt for single-turn (no history prefix)', async () => {
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
    const promptArg = args[args.length - 1];
    expect(promptArg).toBe('Hello');
    expect(promptArg).not.toContain('Conversation history');
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

  it('kills the process group after responding', async () => {
    const provider = new CodexProvider();
    const proc = makeJsonStream([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'response' } },
      { type: 'turn.completed', usage: {} },
    ]);

    vi.mocked(execa).mockReturnValue(proc as any);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await provider.complete(makeRequest([{ role: 'user', content: 'hi' }]));

    // Either process.kill(-pid) for group or proc.kill was called
    expect(killSpy.mock.calls.length + (proc.kill as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    killSpy.mockRestore();
  });

  it('returns (no response) if no agent message arrives before exit', async () => {
    const provider = new CodexProvider();

    vi.mocked(execa).mockReturnValue(makeJsonStream([
      { type: 'turn.started' },
      { type: 'turn.completed', usage: {} }, // completed with no message
    ]) as any);

    const response = await provider.complete(makeRequest([{ role: 'user', content: 'hi' }]));
    expect(response.content[0]).toMatchObject({ type: 'text', text: '(task complete — check the files)' });
  });
});
