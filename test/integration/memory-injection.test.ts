import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AgentRunner } from '../../src/agent/AgentRunner.js';
import { MemoryLoader } from '../../src/memory/MemoryLoader.js';
import type { LLMProvider, Message, ContentPart } from '../../src/providers/types.js';
import type { Tool } from '../../src/tools/types.js';

describe('Memory injection in AgentRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should inject memory into system prompt', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, '# Project Rules\nAlways be concise', 'utf-8');

    const memoryLoader = new MemoryLoader(tmpDir);
    await memoryLoader.load();

    let capturedSystemPrompt = '';

    // Mock provider that captures the system prompt
    const mockProvider: LLMProvider = {
      complete: async () => {
        throw new Error('Not used in this test');
      },
      stream: async (request, _onDelta) => {
        capturedSystemPrompt = request.systemPrompt ?? '';
        const content: ContentPart[] = [{ type: 'text', text: 'Done' }];
        return {
          content,
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      supportsStreaming: true,
      providerName: 'mock',
      modelName: 'mock-model',
    };

    const runner = new AgentRunner({
      userMessage: 'Hello',
      systemPrompt: 'Base system prompt',
      provider: mockProvider,
      model: 'mock-model',
      tools: [] as Tool[],
      memoryLoader,
      maxIterations: 1,
    });

    await runner.run();

    expect(capturedSystemPrompt).toContain('Base system prompt');
    expect(capturedSystemPrompt).toContain('# PROJECT MEMORY');
    expect(capturedSystemPrompt).toContain('# Project Rules');
    expect(capturedSystemPrompt).toContain('Always be concise');
  });

  it('should reload memory on reloadMemory call', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, 'Initial content', 'utf-8');

    const memoryLoader = new MemoryLoader(tmpDir);
    await memoryLoader.load();

    // First, get the initial block
    const initialBlock = await memoryLoader.generateSystemPromptBlock();
    expect(initialBlock).toContain('Initial content');

    // Update memory file
    await fs.writeFile(projectMemory, 'Updated content', 'utf-8');

    // Reload memory
    await memoryLoader.reloadAll();

    // Get the updated block
    const updatedBlock = await memoryLoader.generateSystemPromptBlock();
    expect(updatedBlock).toContain('Updated content');
    expect(updatedBlock).not.toContain('Initial content');
  });

  it('should work without memory loader', async () => {
    const mockProvider: LLMProvider = {
      complete: async () => {
        throw new Error('Not used in this test');
      },
      stream: async (request, _onDelta) => {
        const content: ContentPart[] = [{ type: 'text', text: 'Done' }];
        return {
          content,
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      supportsStreaming: true,
      providerName: 'mock',
      modelName: 'mock-model',
    };

    const runner = new AgentRunner({
      userMessage: 'Hello',
      systemPrompt: 'Base system prompt',
      provider: mockProvider,
      model: 'mock-model',
      tools: [] as Tool[],
      maxIterations: 1,
    });

    const result = await runner.run();
    expect(result.finalResponse).toBe('Done');
  });
});
