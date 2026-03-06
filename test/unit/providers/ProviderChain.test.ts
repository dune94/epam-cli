import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderChain } from '../../../src/providers/ProviderChain.js';
import type { ProviderSlot } from '../../../src/providers/health/types.js';

// Mock fs for auth file check
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock CopilotProvider
vi.mock('../../../src/providers/copilot/CopilotProvider.js', () => ({
  createCopilotProvider: vi.fn(),
}));

// Mock providers
vi.mock('../../../src/providers/anthropic/AnthropicProvider.js', () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    complete: vi.fn(),
    stream: vi.fn(),
  })),
}));

vi.mock('../../../src/providers/codemie/CodemieProvider.js', () => ({
  createCodemieProvider: vi.fn(),
}));

vi.mock('../../../src/providers/codex/CodexProvider.js', () => ({
  CodexProvider: {
    isAvailable: vi.fn().mockResolvedValue(true),
  },
}));

describe('ProviderChain - Failover', () => {
  const mockSlots: ProviderSlot[] = [
    { provider: 'codemie', model: 'claude-opus-4-6' },
    { provider: 'codex', model: 'gpt-5-codex' },
    { provider: 'openai', model: 'gpt-4o' },
  ];

  const mockResolveApiKey = vi.fn().mockResolvedValue(null);

  let chain: ProviderChain;
  let failoverEvents: Array<{ from: string; to: string; reason: string }> = [];
  let consoleOutput: string[] = [];

  beforeEach(() => {
    failoverEvents = [];
    consoleOutput = [];
    
    // Capture console.error for skip messages
    const originalError = process.stderr.write;
    process.stderr.write = (msg: any) => {
      consoleOutput.push(msg.toString());
      return originalError.call(process.stderr, msg);
    };

    chain = new ProviderChain({
      slots: mockSlots,
      resolveApiKey: mockResolveApiKey,
      onFailover: (event) => {
        failoverEvents.push({
          from: `${event.fromSlot.provider}/${event.fromSlot.model}`,
          to: `${event.toSlot.provider}/${event.toSlot.model}`,
          reason: event.reason,
        });
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should skip unauthenticated codex during failover', async () => {
    // Mock auth file NOT existing (not authenticated)
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);

    // Mock codemie provider that fails
    const { createCodemieProvider } = await import('../../../src/providers/codemie/CodemieProvider.js');
    vi.mocked(createCodemieProvider).mockResolvedValue({
      name: 'codemie',
      defaultModel: 'claude-opus-4-6',
      complete: vi.fn().mockRejectedValue(new Error('fetch failed')),
      stream: vi.fn().mockRejectedValue(new Error('fetch failed')),
    } as any);

    // Try to call - should fail on codemie, skip codex (not authed), skip openai (no key)
    await expect(chain.complete({
      messages: [{ role: 'user' as const, content: 'hello' }],
      model: 'claude-opus-4-6',
      stream: false,
    })).rejects.toThrow('All providers exhausted');

    // Verify skip messages appeared
    const output = consoleOutput.join('');
    expect(output).toContain('Skipping codex');
    expect(output).toContain('not authenticated');
    expect(output).toContain('/providers auth codex');
    
    // Verify NO failover events (all providers skipped)
    expect(failoverEvents.length).toBe(0);
  });

  it('should use codex when authenticated during failover', async () => {
    // Mock auth file EXISTS (authenticated)
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);

    // Mock codemie provider that fails
    const { createCodemieProvider } = await import('../../../src/providers/codemie/CodemieProvider.js');
    vi.mocked(createCodemieProvider).mockResolvedValue({
      name: 'codemie',
      defaultModel: 'claude-opus-4-6',
      complete: vi.fn().mockRejectedValue(new Error('fetch failed')),
      stream: vi.fn().mockRejectedValue(new Error('fetch failed')),
    } as any);

    // Mock codex provider that IS authenticated and succeeds
    const mockCodexProvider = {
      name: 'codex',
      defaultModel: 'gpt-5-codex',
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: 'Hello from Codex' }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
      stream: vi.fn(),
    };

    // Pre-populate the provider cache (simulating authenticated + already built state)
    const chainAny = chain as unknown as { 
      providerCache: Map<string, any>;
    };
    
    chainAny.providerCache.set('codex/gpt-5-codex', mockCodexProvider);

    // Call should fail on codemie, then succeed on codex
    const result = await chain.complete({
      messages: [{ role: 'user' as const, content: 'hello' }],
      model: 'claude-opus-4-6',
      stream: false,
    });

    expect(result.content[0].text).toBe('Hello from Codex');
    expect(mockCodexProvider.complete).toHaveBeenCalled();
  });
});

describe('ProviderChain - copilot → codemie fallback', () => {
  it('falls back to codemie when no GH token is available for copilot', async () => {
    const { createCopilotProvider } = await import('../../../src/providers/copilot/CopilotProvider.js');
    const { createCodemieProvider } = await import('../../../src/providers/codemie/CodemieProvider.js');

    const mockCodemieProvider = {
      name: 'codemie',
      defaultModel: 'claude-sonnet-4-6',
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello from Codemie' }],
        stopReason: 'end_turn',
      }),
      stream: vi.fn(),
    };

    vi.mocked(createCopilotProvider).mockReturnValue(null); // no GH token
    vi.mocked(createCodemieProvider).mockResolvedValue(mockCodemieProvider as any);

    const chain = new ProviderChain({
      slots: [{ provider: 'copilot', model: 'claude-sonnet-4-6' }],
      resolveApiKey: vi.fn().mockResolvedValue(null),
    });

    const result = await chain.complete({
      messages: [{ role: 'user' as const, content: 'hello' }],
      model: 'claude-sonnet-4-6',
      stream: false,
    });

    expect(result.content[0].text).toBe('Hello from Codemie');
    expect(mockCodemieProvider.complete).toHaveBeenCalled();
  });

  it('throws if no GH token and no codemie available', async () => {
    const { createCopilotProvider } = await import('../../../src/providers/copilot/CopilotProvider.js');
    const { createCodemieProvider } = await import('../../../src/providers/codemie/CodemieProvider.js');

    vi.mocked(createCopilotProvider).mockReturnValue(null);
    vi.mocked(createCodemieProvider).mockResolvedValue(null);

    const chain = new ProviderChain({
      slots: [{ provider: 'copilot', model: 'claude-sonnet-4-6' }],
      resolveApiKey: vi.fn().mockResolvedValue(null),
    });

    await expect(
      chain.complete({
        messages: [{ role: 'user' as const, content: 'hello' }],
        model: 'claude-sonnet-4-6',
        stream: false,
      })
    ).rejects.toThrow('Copilot not available');
  });
});
