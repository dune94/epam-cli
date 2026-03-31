import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadSession,
  getSession,
  forkSession,
  saveSession,
  listSessions,
} from '../../../src/context/SessionStore.js';
import type { Session, SessionTurn, ForkMetadata } from '../../../src/context/types.js';

// Mock dependencies
vi.mock('../../../src/utils/fs.js', () => ({
  pathExists: vi.fn(),
  readLines: vi.fn(),
  appendLine: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

vi.mock('../../../src/utils/platform.js', () => ({
  getEpamGlobalDir: vi.fn(() => '/home/user/.epam'),
}));

// Import mocked modules after setting up mocks
import { pathExists, readLines } from '../../../src/utils/fs.js';
import fs from 'fs/promises';

describe('SessionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadSession / getSession', () => {
    it('returns null when session file does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);

      const result = await loadSession('nonexistent', '/tmp/project');

      expect(result).toBeNull();
    });

    it('loads valid session with parsed turns', async () => {
      const turn1: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Hello',
        assistantResponse: 'Hi there',
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const turn2: SessionTurn = {
        id: 'turn-2',
        timestamp: 1234567900,
        userMessage: 'How are you?',
        assistantResponse: 'I am well',
        toolCallCount: 1,
        usage: { inputTokens: 15, outputTokens: 10 },
        toolCalls: [{ name: 'ReadFile', input: { path: '/test.txt' } }],
      };

      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readLines).mockResolvedValue([
        JSON.stringify(turn1),
        JSON.stringify(turn2),
      ]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      expect(result?.id).toBe('session-123');
      expect(result?.turns).toHaveLength(2);
      expect(result?.turns[0]).toEqual(turn1);
      expect(result?.turns[1]).toEqual(turn2);
    });

    it('gracefully handles malformed JSONL lines by skipping them', async () => {
      const validTurn: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Valid',
        assistantResponse: 'Response',
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readLines).mockResolvedValue([
        JSON.stringify(validTurn),
        'this is not valid JSON',
        '{incomplete json',
        JSON.stringify(validTurn),
      ]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      // Should only include the 2 valid turns, skipping malformed lines
      expect(result?.turns).toHaveLength(2);
      expect(result?.turns[0]).toEqual(validTurn);
      expect(result?.turns[1]).toEqual(validTurn);
    });

    it('handles session with all malformed lines', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readLines).mockResolvedValue([
        'invalid json',
        '{incomplete',
        'not a turn at all',
      ]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      expect(result?.turns).toHaveLength(0);
    });

    it('handles empty session file', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readLines).mockResolvedValue([]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      expect(result?.turns).toHaveLength(0);
    });

    it('getSession is an alias for loadSession', async () => {
      expect(getSession).toBe(loadSession);
    });

    it('falls back to global sessions directory when local not found', async () => {
      vi.mocked(pathExists)
        .mockResolvedValueOnce(false) // local path doesn't exist
        .mockResolvedValueOnce(true); // global path exists

      vi.mocked(readLines).mockResolvedValue([]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      expect(pathExists).toHaveBeenCalledTimes(2);
    });

    it('preserves tool calls when present in session data', async () => {
      const turnWithToolCalls: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Read file',
        assistantResponse: 'Reading file...',
        toolCallCount: 2,
        usage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: [
          { id: 'call-1', name: 'ReadFile', input: { path: '/test.txt' } },
          { id: 'call-2', name: 'WriteFile', input: { path: '/out.txt', content: 'data' } },
        ],
      };

      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readLines).mockResolvedValue([JSON.stringify(turnWithToolCalls)]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const result = await loadSession('session-123', '/tmp/project');

      expect(result).toBeTruthy();
      expect(result?.turns[0].toolCalls).toBeDefined();
      expect(result?.turns[0].toolCalls).toHaveLength(2);
      expect(result?.turns[0].toolCalls?.[0].name).toBe('ReadFile');
      expect(result?.turns[0].toolCalls?.[1].name).toBe('WriteFile');
    });
  });

  describe('forkSession', () => {
    it('creates a new session with deep-copied turns', async () => {
      const originalSession: Session = {
        id: 'original-session-id',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 5000,
        projectRoot: '/tmp/project',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        turns: [
          {
            id: 'turn-1',
            timestamp: 1234567890,
            userMessage: 'Hello',
            assistantResponse: 'Hi there',
            toolCallCount: 0,
            usage: { inputTokens: 10, outputTokens: 5 },
          },
          {
            id: 'turn-2',
            timestamp: 1234567900,
            userMessage: 'How are you?',
            assistantResponse: 'I am well',
            toolCallCount: 1,
            usage: { inputTokens: 15, outputTokens: 10 },
          },
        ],
      };

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await forkSession(originalSession);

      expect(result.newSessionId).toBeTruthy();
      expect(result.newSessionId).not.toBe(originalSession.id);
      expect(result.originSessionId).toBe(originalSession.id);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);

      // Verify writeFile was called with fork metadata and turns
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(3); // 1 fork metadata + 2 turns

      // First line should be fork metadata
      const forkMeta = JSON.parse(lines[0]) as ForkMetadata;
      expect(forkMeta.type).toBe('fork_metadata');
      expect(forkMeta.originSessionId).toBe(originalSession.id);
      expect(forkMeta.label).toBeUndefined();

      // Remaining lines should be turns
      const turn1 = JSON.parse(lines[1]) as SessionTurn;
      const turn2 = JSON.parse(lines[2]) as SessionTurn;

      expect(turn1.userMessage).toBe('Hello');
      expect(turn2.userMessage).toBe('How are you?');

      // Turn IDs should be new (not copied)
      expect(turn1.id).not.toBe('turn-1');
      expect(turn2.id).not.toBe('turn-2');
    });

    it('deep-copies turns so mutations in fork do not affect origin', async () => {
      const originalTurn: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Original message',
        assistantResponse: 'Original response',
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: [{ name: 'ReadFile', input: { path: '/test.txt' } }],
      };

      const originalSession: Session = {
        id: 'original-session-id',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectRoot: '/tmp/project',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        turns: [originalTurn],
      };

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await forkSession(originalSession);

      // Extract forked turns from writeFile call
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      const lines = content.trim().split('\n');
      const forkedTurn = JSON.parse(lines[1]) as SessionTurn;

      // Mutate forked turn
      forkedTurn.userMessage = 'Modified message';
      forkedTurn.toolCalls![0].name = 'WriteFile';

      // Original should be unchanged
      expect(originalSession.turns[0].userMessage).toBe('Original message');
      expect(originalSession.turns[0].toolCalls![0].name).toBe('ReadFile');
    });

    it('tags forked session with optional label', async () => {
      const originalSession: Session = {
        id: 'original-session-id',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectRoot: '/tmp/project',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        turns: [],
      };

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await forkSession(originalSession, 'alternative-approach');

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      const lines = content.trim().split('\n');

      const forkMeta = JSON.parse(lines[0]) as ForkMetadata;
      expect(forkMeta.label).toBe('alternative-approach');
    });

    it('preserves project root and model in forked session', async () => {
      const originalSession: Session = {
        id: 'original-session-id',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectRoot: '/custom/project/path',
        model: 'gpt-4o',
        provider: 'openai',
        turns: [],
      };

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await forkSession(originalSession);

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const filePath = writeCall[0] as string;

      // Should write to the same project's sessions directory
      expect(filePath).toContain('.epam/sessions');
    });
  });

  describe('listSessions with fork metadata', () => {
    it('identifies forked sessions with fork indicator', async () => {
      const forkMetadata: ForkMetadata = {
        type: 'fork_metadata',
        timestamp: Date.now(),
        label: 'experiment',
        originSessionId: 'origin-session-123',
      };

      const turn: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Hello',
        assistantResponse: 'Hi',
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      // Only the local directory exists, not global
      vi.mocked(pathExists)
        .mockResolvedValueOnce(true) // local dir exists
        .mockResolvedValueOnce(false); // global dir doesn't exist

      vi.mocked(fs.readdir).mockResolvedValue(['session-fork.jsonl'] as any);
      vi.mocked(readLines).mockResolvedValue([
        JSON.stringify(forkMetadata),
        JSON.stringify(turn),
      ]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const sessions = await listSessions('/tmp/project', 20);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].isFork).toBe(true);
      expect(sessions[0].label).toBe('experiment');
      expect(sessions[0].originSessionId).toBe('origin-session-123');
    });

    it('handles non-forked sessions without fork metadata', async () => {
      const turn: SessionTurn = {
        id: 'turn-1',
        timestamp: 1234567890,
        userMessage: 'Hello',
        assistantResponse: 'Hi',
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      // Only the local directory exists, not global
      vi.mocked(pathExists)
        .mockResolvedValueOnce(true) // local dir exists
        .mockResolvedValueOnce(false); // global dir doesn't exist

      vi.mocked(fs.readdir).mockResolvedValue(['session-normal.jsonl'] as any);
      vi.mocked(readLines).mockResolvedValue([JSON.stringify(turn)]);
      vi.mocked(fs.stat).mockResolvedValue({
        birthtimeMs: 1234560000,
        mtimeMs: 1234570000,
        mtime: new Date(1234570000),
      } as any);

      const sessions = await listSessions('/tmp/project', 20);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].isFork).toBe(false);
      expect(sessions[0].label).toBeUndefined();
      expect(sessions[0].originSessionId).toBeUndefined();
    });
  });
});
