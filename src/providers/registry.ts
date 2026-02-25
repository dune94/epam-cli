import type { LLMProvider } from './types.js';
import { ProviderError } from '../utils/errors.js';

const providers = new Map<string, LLMProvider>();

export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): LLMProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderError(
      `Provider '${name}' not registered. Available: ${Array.from(providers.keys()).join(', ')}`
    );
  }
  return provider;
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function hasProvider(name: string): boolean {
  return providers.has(name);
}

export function clearProviders(): void {
  providers.clear();
}
