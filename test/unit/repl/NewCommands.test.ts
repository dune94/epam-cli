import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestrateCommand } from '../../../src/cli/repl/commands/OrchestrateCommand.js';
import { statusCommand } from '../../../src/cli/repl/commands/StatusCommand.js';
import { diffCommand } from '../../../src/cli/repl/commands/DiffCommand.js';
import { exportCommand } from '../../../src/cli/repl/commands/ExportCommand.js';
import { dashboardCommand } from '../../../src/cli/repl/commands/DashboardCommand.js';
import { planCommand } from '../../../src/cli/repl/commands/PlanCommand.js';
import { reviewCommand } from '../../../src/cli/repl/commands/ReviewCommand.js';
import { forkCommand } from '../../../src/cli/repl/commands/ForkCommand.js';
import { mcpCommand } from '../../../src/cli/repl/commands/MCPCommand.js';
import { tasksCommand } from '../../../src/cli/repl/commands/TasksCommand.js';
import { debugCommand } from '../../../src/cli/repl/commands/DebugCommand.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

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

describe('New Slash Commands', () => {
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
    messages: [],
    budgetGuard: {
      sessionCost: 0.05,
      limits: { warningAt: 10, hardLimitAt: 20 },
    },
    tools: [
      { name: 'ReadFile', definition: {} },
      { name: 'WriteFile', definition: {} },
      { name: 'Bash', definition: {} },
    ],
    toolRunner: {
      getPermission: vi.fn().mockReturnValue('dangerous'),
    },
    providerChain: {
      getSlots: vi.fn().mockReturnValue([
        { provider: 'codemie', model: 'claude-opus-4-6' },
        { provider: 'codex', model: 'gpt-5-codex' },
      ]),
      activeSlot: { provider: 'codemie', model: 'claude-opus-4-6' },
    },
    onModelChange: vi.fn(),
    onClear: vi.fn(),
    onCompact: vi.fn(),
    onRewind: vi.fn(),
    onResume: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('/orchestrate', () => {
    it('should show help when no args', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await orchestrateCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Orchestration Commands');
      expect(output).toContain('estimate');
      expect(output).toContain('execution');
      expect(output).toContain('status');
    });

    it('should handle unknown subcommand', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await orchestrateCommand.execute('unknown', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Unknown command');
    });
  });

  describe('/status', () => {
    it('should show session status', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Session Status');
      expect(output).toContain('Provider');
      expect(output).toContain('Model');
      expect(output).toContain('Budget');
      expect(output).toContain('Tools');
    });
  });

  describe('/diff', () => {
    it('should handle non-git repo', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await diffCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('File Changes');
      expect(output).toContain('Not a git repository');
    });
  });

  describe('/export', () => {
    it('should export session transcript', async () => {
      const { writeFile } = await import('fs/promises');
      vi.mocked(writeFile).mockResolvedValue();

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await exportCommand.execute('test-export.md', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Export Session Transcript');
      expect(output).toContain('exported successfully');
      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe('/dashboard', () => {
    it('should show available dashboards', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await dashboardCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Dashboards');
      expect(output).toContain('monitor');
      expect(output).toContain('prd-viewer');
    });

    it('should handle unknown dashboard', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await dashboardCommand.execute('unknown-dashboard', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Unknown dashboard');
    });
  });

  describe('/plan', () => {
    it('should show plan help', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await planCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Session Plan');
      expect(output).toContain('Strategy');
    });
  });

  describe('/review', () => {
    it('should handle non-git repo', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await reviewCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Code Review');
      expect(output).toContain('Not a git repository');
    });
  });

  describe('/fork', () => {
    it('should create session fork', async () => {
      const { writeFile, mkdir } = await import('fs/promises');
      vi.mocked(writeFile).mockResolvedValue();
      vi.mocked(mkdir).mockResolvedValue();

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await forkCommand.execute('test-fork', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Session forked');
      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe('/mcp', () => {
    it('should list MCP servers', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await mcpCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('MCP Servers');
      expect(output).toContain('Example Configuration');
    });
  });

  describe('/tasks', () => {
    it('should show task queue', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await tasksCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Agent Task Queue');
      expect(output).toContain('Turns completed');
      expect(output).toContain('Budget Status');
    });
  });

  describe('/debug', () => {
    it('should show debug state', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await debugCommand.execute('', mockContext as any);

      console.log = originalLog;
      const output = logs.join('\n');
      
      expect(output).toContain('Debug State Dump');
      expect(output).toContain('Provider Configuration');
      expect(output).toContain('Budget State');
      expect(output).toContain('Tool State');
    });
  });
});
