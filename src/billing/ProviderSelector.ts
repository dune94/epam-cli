import { detectTier } from './TierDetector.js';
import { getApiKey as getEnvApiKey } from '../config/EnvVarOverrides.js';
import { getApiKey as getStoredApiKey } from './KeychainKeyStore.js';
import { AnthropicProvider } from '../providers/anthropic/AnthropicProvider.js';
import { OpenAIProvider } from '../providers/openai/OpenAIProvider.js';
import { GeminiProvider } from '../providers/gemini/GeminiProvider.js';
import { ProxyProvider } from '../providers/proxy/ProxyProvider.js';
import type { LLMProvider } from '../providers/types.js';
import { BillingError } from '../utils/errors.js';

interface ProviderSelectorOptions {
  provider: string;
  model: string;
  backendUrl: string;
  getAccessToken: () => Promise<string>;
}

export async function selectProvider(opts: ProviderSelectorOptions): Promise<LLMProvider> {
  const tier = await detectTier();

  if (tier === 'pro' || tier === 'enterprise') {
    // Use backend proxy — no BYOK needed
    return new ProxyProvider(opts.backendUrl, opts.getAccessToken, opts.provider);
  }

  // Free tier: BYOK — check env var first, then keychain
  const envKey = getEnvApiKey(opts.provider);
  const storedKey = await getStoredApiKey(opts.provider);
  const apiKey = envKey ?? storedKey;

  if (!apiKey) {
    throw new BillingError(
      `No API key found for provider '${opts.provider}'.\n` +
        `Set EPAM_API_KEY_${opts.provider.toUpperCase()} or run: epam keys set ${opts.provider}`
    );
  }

  switch (opts.provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey);
    case 'openai':
      return new OpenAIProvider(apiKey);
    case 'gemini':
      return new GeminiProvider(apiKey);
    default:
      throw new BillingError(`Unknown provider: ${opts.provider}`);
  }
}
