import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSyncCommand } from '../../../src/cli/commands/sync.js';
import type { BackendClient } from '../../../src/http/BackendClient.js';

// Mock dependencies
vi.mock('../../../src/config/ConfigResolver.js', () => ({
  resolveConfig: vi.fn(),
}));

vi.mock('../../../src/auth/AuthManager.js', () => ({
  AuthManager: vi.fn(),
}));

vi.mock('../../../src/http/BackendClient.js', () => ({
  BackendClient: vi.fn(),
}));

vi.mock('../../../src/utils/fs.js', () => ({
  pathExists: vi.fn(),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

// Import mocked modules after setting up mocks
import { resolveConfig } from '../../../src/config/ConfigResolver.js';
import { AuthManager } from '../../../src/auth/AuthManager.js';
import { BackendClient } from '../../../src/http/BackendClient.js';
import { pathExists, readJsonFile, writeJsonFile } from '../../../src/utils/fs.js';
import fs from 'fs/promises';

describe('sync command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let mockClient: Partial<BackendClient>;
  let mockAuthManager: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    mockClient = {
      syncPush: vi.fn(),
      syncPull: vi.fn(),
    };

    mockAuthManager = {
      isAuthenticated: vi.fn(),
    };

    vi.mocked(resolveConfig).mockResolvedValue({
      projectRoot: '/tmp/project',
      backendUrl: 'https://api.epam.test',
    } as any);

    vi.mocked(AuthManager).mockReturnValue(mockAuthManager);
    vi.mocked(BackendClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sync push', () => {
    it('is registered with correct name and description', () => {
      const cmd = createSyncCommand();
      const pushCmd = cmd.commands.find(c => c.name() === 'push');
      expect(pushCmd).toBeDefined();
      expect(pushCmd?.description()).toContain('Push');
    });

    it('constructs correct payload structure with contextMd, decisionsJsonl, and timestamp', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockImplementation(async (path: any) => {
        if (path.includes('context.md')) return '# Project Context\n';
        if (path.includes('decisions.jsonl')) return '{"decision":"test"}\n';
        return '';
      });
      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: null,
        projectId: null,
      });

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'push']);

      expect(mockClient.syncPush).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          contextMd: expect.any(String),
          decisionsJsonl: expect.any(String),
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO timestamp
        })
      );
    });

    it('includes Authorization header via BackendClient', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('');
      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: null,
        projectId: null,
      });

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'push']);

      // BackendClient is instantiated with AuthManager - auth happens in request()
      expect(BackendClient).toHaveBeenCalledWith(
        'https://api.epam.test',
        mockAuthManager
      );
      expect(mockClient.syncPush).toHaveBeenCalled();
    });

    it('exits with error when not authenticated', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(false);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'push']);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated')
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('logs force push message when --force flag is used', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('');
      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: null,
        projectId: null,
      });

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'push', '--force']);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Force-pushed local over remote (--force)')
      );
    });
  });

  describe('sync pull', () => {
    it('is registered with correct name and description', () => {
      const cmd = createSyncCommand();
      const pullCmd = cmd.commands.find(c => c.name() === 'pull');
      expect(pullCmd).toBeDefined();
      expect(pullCmd?.description()).toContain('Pull');
    });

    it('does not overwrite local when local is newer than remote', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);

      const oldRemoteTime = '2026-01-01T00:00:00.000Z';
      const recentLocalTime = '2026-02-01T00:00:00.000Z';

      vi.mocked(mockClient.syncPull as any).mockResolvedValue({
        contextMd: 'remote context',
        decisionsJsonl: 'remote decisions',
        timestamp: oldRemoteTime,
      });

      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: oldRemoteTime,
        projectId: 'test-project',
      });

      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fs.stat).mockResolvedValue({
        mtimeMs: new Date(recentLocalTime).getTime(),
      } as any);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'pull']);

      // Should NOT call writeFile when local is newer
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Local is up to date')
      );
    });

    it('overwrites local when remote is newer', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);

      const recentRemoteTime = '2026-02-01T00:00:00.000Z';
      const oldLocalTime = '2026-01-01T00:00:00.000Z';

      vi.mocked(mockClient.syncPull as any).mockResolvedValue({
        contextMd: 'remote context',
        decisionsJsonl: 'remote decisions',
        timestamp: recentRemoteTime,
      });

      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: oldLocalTime,
        projectId: 'test-project',
      });

      vi.mocked(pathExists).mockResolvedValue(false);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'pull']);

      expect(mockClient.syncPull).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pulled latest context and decisions')
      );
    });

    it('exits with error when not authenticated', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(false);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'pull']);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated')
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('overwrites local unconditionally with --force remote', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);

      vi.mocked(mockClient.syncPull as any).mockResolvedValue({
        contextMd: 'remote context',
        decisionsJsonl: 'remote decisions',
        timestamp: '2026-01-01T00:00:00.000Z',
      });

      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: null,
        projectId: 'test-project',
      });

      vi.mocked(pathExists).mockResolvedValue(true);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'pull', '--force', 'remote']);

      expect(mockClient.syncPull).toHaveBeenCalled();
    });
  });

  describe('sync status', () => {
    it('is registered with correct name and description', () => {
      const cmd = createSyncCommand();
      const statusCmd = cmd.commands.find(c => c.name() === 'status');
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toContain('status');
    });

    it('shows last push and pull timestamps', async () => {
      const pushTime = '2026-01-15T10:30:00.000Z';
      const pullTime = '2026-01-16T14:20:00.000Z';

      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: pushTime,
        lastPullTimestamp: pullTime,
        projectId: 'test-project',
      });

      mockAuthManager.isAuthenticated.mockResolvedValue(false);

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'status']);

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Last push:');
      expect(output).toContain('Last pull:');
    });

    it('shows diff summary when authenticated', async () => {
      mockAuthManager.isAuthenticated.mockResolvedValue(true);

      vi.mocked(readJsonFile).mockResolvedValue({
        lastPushTimestamp: null,
        lastPullTimestamp: null,
        projectId: 'test-project',
      });

      vi.mocked(mockClient.syncPull as any).mockResolvedValue({
        contextMd: 'line1\nline2\nline3\n',
        decisionsJsonl: 'decision1\n',
        timestamp: '2026-01-01T00:00:00.000Z',
      });

      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fs.readFile).mockImplementation(async (path: any) => {
        if (path.includes('context.md')) return 'line1\nline4\n';
        if (path.includes('decisions.jsonl')) return 'decision1\ndecision2\n';
        return '';
      });

      const cmd = createSyncCommand();
      await cmd.parseAsync(['node', 'test', 'status']);

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Local vs Remote');
      expect(output).toContain('context.md');
      expect(output).toContain('decisions.jsonl');
    });
  });
});
