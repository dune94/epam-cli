import { describe, it, expect, vi, beforeEach } from 'vitest';
import { teamCommand } from '../../../src/cli/repl/commands/TeamCommand.js';
import { membersCommand } from '../../../src/cli/repl/commands/MembersCommand.js';
import { inviteCommand } from '../../../src/cli/repl/commands/InviteCommand.js';
import { shareCommand } from '../../../src/cli/repl/commands/ShareCommand.js';
import { handoffCommand } from '../../../src/cli/repl/commands/HandoffCommand.js';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
}));

describe('Team Commands', () => {
  const mockContext = {
    config: {
      provider: 'codemie',
      maxIterations: 20,
      projectRoot: '/test/project',
      budgetGuardrails: { warningAt: 10, hardLimitAt: 20 },
      tools: { dangerousSkipApproval: false },
      autoCompressAt: 80000,
      maxOutputTokens: 16384,
    },
    currentModel: 'claude-opus-4-6',
    sessionTurnCount: 5,
    tokenCount: 1000,
    contextFilePath: '.epam/context.md',
    totalInputTokens: 500,
    totalOutputTokens: 500,
    messages: [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ],
    budgetGuard: {
      sessionCost: 0.05,
      limits: { warningAt: 10, hardLimitAt: 20 },
    },
    tools: [],
    toolRunner: {},
    onModelChange: vi.fn(),
    onClear: vi.fn(),
    onCompact: vi.fn(),
    onRewind: vi.fn(),
    onResume: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('/team', () => {
    it('should show team overview when no team configured', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await teamCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Team Overview');
      expect(output).toContain('No team configured');
      expect(output).toContain('Quick Start');
    });
  });

  describe('/members', () => {
    it('should list members help when no team', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await membersCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Team Members');
      expect(output).toContain('No team configured');
    });

    it('should handle invite command', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await membersCommand.execute('add john@example.com', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Invite Member');
      expect(output).toContain('john@example.com');
    });
  });

  describe('/invite', () => {
    it('should show invite help when no args', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await inviteCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Invite Team Member');
      expect(output).toContain('Usage:');
      expect(output).toContain('Roles:');
    });

    it('should validate email', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await inviteCommand.execute('invalid-email', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Invalid email');
    });

    it('should process valid invite', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await inviteCommand.execute('john@example.com member', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Sending Invitation');
      expect(output).toContain('john@example.com');
      expect(output).toContain('member');
    });
  });

  describe('/share', () => {
    it('should share current session', async () => {
      const { mkdir, writeFile } = await import('fs/promises');
      vi.mocked(mkdir).mockResolvedValue();
      vi.mocked(writeFile).mockResolvedValue();

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await shareCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Share Session');
      expect(output).toContain('Session to Share');
      expect(output).toContain('Backend API Integration');
    });
  });

  describe('/handoff', () => {
    it('should show handoff help when no args', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await handoffCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Session Handoff');
      expect(output).toContain('Usage:');
      expect(output).toContain('What is Handoff');
    });

    it('should process handoff request', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await handoffCommand.execute('john@example.com', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Session Handoff');
      expect(output).toContain('john@example.com');
      expect(output).toContain('Backend API Call Required');
    });
  });
});
