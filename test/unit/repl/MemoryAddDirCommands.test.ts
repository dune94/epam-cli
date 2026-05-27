import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandContext } from '../../../src/cli/repl/SlashCommands.js';
import type { Message } from '../../../src/providers/types.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const messages: Message[] = [];
  return {
    config: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      projectRoot: '/test/project',
      contextFile: '.epam/context.md',
      maxIterations: 20,
      tools: { disabled: [], dangerousSkipApproval: false },
      llmChain: [],
    } as SlashCommandContext['config'],
    currentProvider: 'anthropic',
    currentModel: 'claude-sonnet-4-6',
    sessionTurnCount: 0,
    tokenCount: 0,
    contextFilePath: '.epam/context.md',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messages,
    onModelChange: vi.fn(),
    onClear: vi.fn(),
    onCompact: vi.fn(async () => {}),
    onRewind: vi.fn(),
    onResume: vi.fn(async () => ({ success: true, turnCount: 0 })),
    ...overrides,
  };
}

function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  return fn().finally(() => { console.log = orig; }).then(() =>
    lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  );
}

describe('/memory command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows project memory contents when file exists', async () => {
    const { existsSync, readFileSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('# Project Context\nSome notes here');

    const { memoryCommand } = await import('../../../src/cli/repl/commands/MemoryCommand.js');
    const output = await captureLog(() => memoryCommand.execute('', makeCtx()));

    expect(output).toContain('Project Memory');
    expect(output).toContain('Some notes here');
  });

  it('shows empty message when context file is absent', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);

    const { memoryCommand } = await import('../../../src/cli/repl/commands/MemoryCommand.js');
    const output = await captureLog(() => memoryCommand.execute('', makeCtx()));

    expect(output).toContain('Project Memory');
    expect(output).toContain('empty');
  });

  it('shows global memory when /memory global is used', async () => {
    const { existsSync, readFileSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('# Global notes');

    const { memoryCommand } = await import('../../../src/cli/repl/commands/MemoryCommand.js');
    const output = await captureLog(() => memoryCommand.execute('global', makeCtx()));

    expect(output).toContain('Global Memory');
    expect(output).toContain('Global notes');
  });

  it('is registered in SLASH_COMMANDS', async () => {
    const { SLASH_COMMANDS } = await import('../../../src/cli/repl/SlashCommands.js');
    const cmd = SLASH_COMMANDS.find(c => c.name === 'memory');
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toContain('mem');
  });
});

describe('/add-dir command', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows usage when no path is given', async () => {
    const { addDirCommand } = await import('../../../src/cli/repl/commands/AddDirCommand.js');
    const output = await captureLog(() => addDirCommand.execute('', makeCtx()));
    expect(output).toContain('/add-dir');
    expect(output).toContain('<path>');
  });

  it('errors on non-existent directory', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);

    const { addDirCommand } = await import('../../../src/cli/repl/commands/AddDirCommand.js');
    const output = await captureLog(() => addDirCommand.execute('src/nonexistent', makeCtx()));
    expect(output).toContain('not found');
  });

  it('injects a user message with directory listing', async () => {
    const { existsSync, statSync, readdirSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    vi.mocked(readdirSync).mockReturnValue(['index.ts', 'utils.ts'] as unknown as ReturnType<typeof readdirSync>);

    const { addDirCommand } = await import('../../../src/cli/repl/commands/AddDirCommand.js');
    const ctx = makeCtx();
    await captureLog(() => addDirCommand.execute('src', ctx));

    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0].role).toBe('user');
    expect(String(ctx.messages[0].content)).toContain('Directory context');
  });

  it('is registered in SLASH_COMMANDS', async () => {
    const { SLASH_COMMANDS } = await import('../../../src/cli/repl/SlashCommands.js');
    const cmd = SLASH_COMMANDS.find(c => c.name === 'add-dir');
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toContain('adddir');
  });
});
