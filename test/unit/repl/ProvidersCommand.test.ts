import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { providersCommand } from '../../../src/cli/repl/commands/ProvidersCommand.js';
import type { SlashCommandContext } from '../../../src/cli/repl/SlashCommands.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs for auth file check
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock prompts
vi.mock('prompts', () => ({
  default: vi.fn(),
}));

describe('/providers command', () => {
  const mockContext: SlashCommandContext = {
    config: {} as any,
    currentModel: 'claude-opus-4-6',
    sessionTurnCount: 1,
    tokenCount: 100,
    contextFilePath: '.epam/context.md',
    totalInputTokens: 100,
    totalOutputTokens: 200,
    messages: [],
    onModelChange: vi.fn(),
    onClear: vi.fn(),
    onCompact: vi.fn(),
    onRewind: vi.fn(),
    onResume: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should show already authenticated when auth file exists', async () => {
    // Mock auth file exists
    const fs = await import('fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const ctx = {
      ...mockContext,
      providerChain: null,
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    await providersCommand.execute('auth codex', ctx);

    console.log = originalLog;

    const output = logs.join('\n');
    
    // Should show already authenticated message
    expect(output).toContain('already authenticated');
    expect(output).toContain('auth.json');
    expect(output).toContain('To re-authenticate');
    
    // Should NOT call execa (no auth flow needed)
    const { execa } = await import('execa');
    expect(execa).not.toHaveBeenCalled();
  });

  it('should show provider status with /providers', async () => {
    // Mock provider chain
    const mockChain = {
      getSlots: vi.fn().mockReturnValue([
        { provider: 'codemie', model: 'claude-opus-4-6' },
        { provider: 'codex', model: 'gpt-5-codex' },
      ]),
      activeSlot: { provider: 'codemie', model: 'claude-opus-4-6' },
    };

    const ctx = {
      ...mockContext,
      providerChain: mockChain as any,
    };

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    await providersCommand.execute('', ctx);

    console.log = originalLog;

    // Verify output contains expected content
    const output = logs.join('\n');
    expect(output).toContain('Provider Status');
    expect(output).toContain('codemie/claude-opus-4-6');
    expect(output).toContain('codex/gpt-5-codex');
  });

  it('should authenticate codex and properly return to EPAM CLI prompt', async () => {
    // Mock auth file does NOT exist (need to authenticate)
    const fs = await import('fs');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    const { execa } = await import('execa');
    
    // Simulate Codex auth completing
    vi.mocked(execa).mockImplementation(async () => {
      return { exitCode: 0 } as any;
    });

    const ctx = {
      ...mockContext,
      providerChain: null,
    };

    // Capture ALL output
    const allOutput: string[] = [];
    const originalWrite = process.stdout.write;
    const originalLog = console.log;
    
    // Capture both stdout.write and console.log
    process.stdout.write = vi.fn((msg: any) => {
      allOutput.push(msg?.toString() || '');
      return true;
    });
    console.log = vi.fn((msg: any) => {
      allOutput.push(msg?.toString() || '');
      allOutput.push('\n');
    });

    await providersCommand.execute('auth codex', ctx);

    // Restore
    process.stdout.write = originalWrite;
    console.log = originalLog;

    // Verify execa was called with correct parameters
    expect(execa).toHaveBeenCalledWith('codex', [], expect.objectContaining({
      stdio: 'inherit',
      timeout: 300000,
    }));

    // CRITICAL: Verify prompt restoration signals are present
    const output = allOutput.join('');
    
    // Must clear terminal state from Codex
    expect(output).toContain('\x1B[2J');
    
    // Must have visual separator
    expect(output).toContain('─');
    
    // Must have return message
    expect(output).toContain('Welcome back to EPAM CLI');
    
    // Must have instruction to continue
    expect(output).toContain('Type your message');
    
    // Must write newline to trigger prompt
    expect(output).toContain('\n');
  });

  it('should handle codex auth failure gracefully', async () => {
    // Mock auth file does NOT exist
    const fs = await import('fs');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as any);

    const ctx = {
      ...mockContext,
      providerChain: null,
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    await providersCommand.execute('auth codex', ctx);

    console.log = originalLog;

    const output = logs.join('\n');
    
    // Should show failure message
    expect(output).toContain('Codex session ended');
    expect(output).toContain('try again');
  });
});
