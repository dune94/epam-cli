import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  getProvider,
  listProviders,
  hasProvider,
  clearProviders,
} from '../../../src/providers/registry.js';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../../../src/providers/types.js';

const mockProvider: LLMProvider = {
  name: 'mock',
  defaultModel: 'mock-model',
  async complete(_req: ProviderRequest): Promise<ProviderResponse> {
    return {
      content: [{ type: 'text', text: 'mock' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
  async stream(_req: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    handler({ type: 'text_delta', text: 'mock' });
    handler({ type: 'message_stop', stopReason: 'end_turn' });
    return {
      content: [{ type: 'text', text: 'mock' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
};

describe('ProviderRegistry', () => {
  beforeEach(() => clearProviders());

  it('registers and retrieves a provider', () => {
    registerProvider(mockProvider);
    expect(getProvider('mock')).toBe(mockProvider);
  });

  it('throws when provider not registered', () => {
    expect(() => getProvider('nonexistent')).toThrow("Provider 'nonexistent' not registered");
  });

  it('listProviders returns registered names', () => {
    registerProvider(mockProvider);
    expect(listProviders()).toContain('mock');
  });

  it('hasProvider returns false then true', () => {
    expect(hasProvider('mock')).toBe(false);
    registerProvider(mockProvider);
    expect(hasProvider('mock')).toBe(true);
  });

  it('clearProviders empties the registry', () => {
    registerProvider(mockProvider);
    clearProviders();
    expect(listProviders()).toHaveLength(0);
  });
});
