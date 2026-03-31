import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLASH_COMMANDS, type SlashCommandContext } from '../../../src/cli/repl/SlashCommands.js';
import { ToolRunner } from '../../../src/agent/tools/ToolRunner.js';
import type { Tool } from '../../../src/tools/types.js';

function createTool(name: string, permission: 'safe' | 'review' | 'dangerous'): Tool {
  return {
    name,
    description: `${name} tool`,
    permission,
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    execute: vi.fn(),
  };
}

function createContext(tools: Tool[], toolRunner: ToolRunner): SlashCommandContext {
  return {
    config: {
      provider: 'epam',
      model: 'claude-sonnet-4-5-20250929',
      projectRoot: process.cwd(),
      contextFile: '.epam/context.md',
      maxIterations: 20,
      tools: { disabled: [], dangerousSkipApproval: false },
      llmChain: [{ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }],
    } as SlashCommandContext['config'],
    currentModel: 'claude-sonnet-4-5-20250929',
    sessionTurnCount: 0,
    tokenCount: 0,
    contextFilePath: '.epam/context.md',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messages: [],
    tools,
    toolRunner,
    onModelChange: vi.fn(),
    onClear: vi.fn(),
    onCompact: vi.fn(async () => {}),
    onRewind: vi.fn(),
    onResume: vi.fn(async () => ({ success: true, turnCount: 0 })),
  };
}

describe('SlashCommands /permissions', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const tools = [
    createTool('read_file', 'safe'),
    createTool('write_file', 'review'),
    createTool('bash', 'dangerous'),
  ];

  let toolRunner: ToolRunner;
  let ctx: SlashCommandContext;
  const permissionsCommand = SLASH_COMMANDS.find(cmd => cmd.name === 'permissions');
  const helpCommand = SLASH_COMMANDS.find(cmd => cmd.name === 'help');

  beforeEach(() => {
    logSpy.mockClear();
    toolRunner = new ToolRunner(tools, false);
    ctx = createContext(tools, toolRunner);
  });

  it('is registered in help output', async () => {
    expect(helpCommand).toBeDefined();
    await helpCommand!.execute('', ctx);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/permissions');
  });

  it('renders tool approval table', async () => {
    expect(permissionsCommand).toBeDefined();
    await permissionsCommand!.execute('', ctx);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Tool Permissions');
    expect(output).toContain('read_file');
    expect(output).toContain('bash');
    expect(output).toContain('prompt');
  });

  it('enables auto-approve for all tools', async () => {
    await permissionsCommand!.execute('auto', ctx);

    expect(toolRunner.isGlobalAutoApprove()).toBe(true);
    expect(toolRunner.getApprovalMode('bash', 'dangerous')).toBe('auto');
  });

  it('supports single-tool override and reset', async () => {
    await permissionsCommand!.execute('bash disabled', ctx);
    expect(toolRunner.getApprovalMode('bash', 'dangerous')).toBe('disabled');

    await permissionsCommand!.execute('reset', ctx);
    expect(toolRunner.isGlobalAutoApprove()).toBe(false);
    expect(toolRunner.getApprovalMode('bash', 'dangerous')).toBe('prompt');
  });
});
