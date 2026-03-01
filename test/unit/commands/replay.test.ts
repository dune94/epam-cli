import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReplayCommand } from '../../../src/cli/commands/replay.js';
import type { Session, SessionTurn } from '../../../src/context/types.js';

// Mock dependencies
vi.mock('../../../src/config/ConfigResolver.js', () => ({
  resolveConfig: vi.fn(),
}));

vi.mock('../../../src/context/SessionStore.js', () => ({
  loadSession: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock('prompts', () => ({
  default: vi.fn(),
}));

// Import mocked modules after setting up mocks
import { resolveConfig } from '../../../src/config/ConfigResolver.js';
import { loadSession, listSessions } from '../../../src/context/SessionStore.js';
import prompts from 'prompts';

function mockTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: 'turn-123',
    timestamp: Date.now(),
    userMessage: 'Test user message',
    assistantResponse: 'Test assistant response',
    toolCallCount: 0,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
    },
    ...overrides,
  };
}

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-123',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectRoot: null,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    turns: [mockTurn()],
    ...overrides,
  };
}

describe('replay command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(resolveConfig).mockResolvedValue({
      projectRoot: '/tmp/project',
    } as any);

    // Mock setTimeout for speed tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is registered with correct name and description', () => {
    const cmd = createReplayCommand();
    expect(cmd.name()).toBe('replay');
    expect(cmd.description()).toContain('Replay a session');
  });

  describe('speed flag parsing', () => {
    it('accepts speed flag with value 1', async () => {
      const session = mockSession();
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123', '--speed', '1']);

      // Fast-forward through the delays
      await vi.runAllTimersAsync();
      await promise;

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join(' ');
      expect(output).toContain('1x speed');
    });

    it('accepts speed flag with value 2', async () => {
      const session = mockSession();
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123', '--speed', '2']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join(' ');
      expect(output).toContain('2x speed');
    });

    it('accepts speed flag with value 4', async () => {
      const session = mockSession();
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123', '--speed', '4']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join(' ');
      expect(output).toContain('4x speed');
    });

    it('defaults to speed 1 when no flag provided', async () => {
      const session = mockSession();
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join(' ');
      expect(output).toContain('1x speed');
    });

    it('defaults to 1x when invalid speed provided', async () => {
      const session = mockSession();
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123', '--speed', '99']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join(' ');
      expect(output).toContain('Invalid speed');
      expect(output).toContain('1x speed');
    });
  });

  describe('turn rendering format', () => {
    it('renders turn number, user message, and assistant response', async () => {
      const session = mockSession({
        turns: [
          mockTurn({
            userMessage: 'What is 2+2?',
            assistantResponse: 'The answer is 4',
          }),
        ],
      });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

      expect(output).toContain('Turn 1');
      expect(output).toContain('User:');
      expect(output).toContain('What is 2+2?');
      expect(output).toContain('Assistant:');
      expect(output).toContain('The answer is 4');
    });

    it('renders tool calls when available', async () => {
      const session = mockSession({
        turns: [
          mockTurn({
            toolCallCount: 2,
            toolCalls: [
              { name: 'ReadFile', input: { path: '/test.txt' } },
              { name: 'WriteFile', input: { path: '/output.txt', content: 'data' } },
            ],
          }),
        ],
      });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

      expect(output).toContain('Tool Calls:');
      expect(output).toContain('ReadFile');
      expect(output).toContain('WriteFile');
    });

    it('shows tool call count when tool calls not stored', async () => {
      const session = mockSession({
        turns: [
          mockTurn({
            toolCallCount: 3,
            toolCalls: undefined, // No detailed tool calls stored
          }),
        ],
      });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

      expect(output).toContain('Tool calls: 3');
      expect(output).toContain('details not available');
    });

    it('truncates long tool call arguments', async () => {
      const longInput = { data: 'x'.repeat(100) };
      const session = mockSession({
        turns: [
          mockTurn({
            toolCallCount: 1,
            toolCalls: [{ name: 'LongArgs', input: longInput }],
          }),
        ],
      });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

      expect(output).toContain('LongArgs');
      expect(output).toContain('…'); // Ellipsis for truncation
    });

    it('renders multiple turns in sequence', async () => {
      const session = mockSession({
        turns: [
          mockTurn({ userMessage: 'First question' }),
          mockTurn({ userMessage: 'Second question' }),
          mockTurn({ userMessage: 'Third question' }),
        ],
      });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test', 'session-123']);

      await vi.runAllTimersAsync();
      await promise;

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

      expect(output).toContain('Turn 1');
      expect(output).toContain('Turn 2');
      expect(output).toContain('Turn 3');
      expect(output).toContain('First question');
      expect(output).toContain('Second question');
      expect(output).toContain('Third question');
    });
  });

  describe('session picker logic', () => {
    it('shows session picker when no session_id provided', async () => {
      vi.mocked(listSessions).mockResolvedValue([
        {
          id: 'session-1',
          updatedAt: new Date('2026-01-01'),
          createdAt: new Date('2026-01-01'),
          turnCount: 5,
          path: '/tmp/session-1.jsonl',
          model: 'claude-sonnet-4-6',
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCost: 0.01,
        },
      ]);

      vi.mocked(prompts).mockResolvedValue({ id: 'session-1' });
      vi.mocked(loadSession).mockResolvedValue(mockSession({ id: 'session-1' }));

      const cmd = createReplayCommand();
      const promise = cmd.parseAsync(['node', 'test']);

      await vi.runAllTimersAsync();
      await promise;

      expect(prompts).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'select',
          message: 'Select a session to replay:',
        })
      );
    });

    it('handles user cancelling session picker', async () => {
      vi.mocked(listSessions).mockResolvedValue([
        {
          id: 'session-1',
          updatedAt: new Date(),
          createdAt: new Date(),
          turnCount: 5,
          path: '/tmp/session-1.jsonl',
          model: 'claude-sonnet-4-6',
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCost: 0.01,
        },
      ]);

      vi.mocked(prompts).mockResolvedValue({}); // User cancelled

      const cmd = createReplayCommand();
      await cmd.parseAsync(['node', 'test']);

      // Should not call loadSession
      expect(loadSession).not.toHaveBeenCalled();
    });

    it('shows message when no sessions found', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);

      const cmd = createReplayCommand();
      await cmd.parseAsync(['node', 'test']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('No sessions found');
    });
  });

  describe('error handling', () => {
    it('shows error when session not found', async () => {
      vi.mocked(loadSession).mockResolvedValue(null);

      const cmd = createReplayCommand();
      await cmd.parseAsync(['node', 'test', 'nonexistent-session']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('not found');
    });

    it('shows message when session is empty', async () => {
      const session = mockSession({ turns: [] });
      vi.mocked(loadSession).mockResolvedValue(session);

      const cmd = createReplayCommand();
      await cmd.parseAsync(['node', 'test', 'session-123']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('empty');
    });
  });
});
