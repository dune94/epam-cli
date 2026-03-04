import chalk from 'chalk';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler } from './types.js';
import type { ProviderSlot } from './health/types.js';
import { ProviderHealth } from './health/ProviderHealth.js';
import { analyzeError } from './health/FailoverPolicy.js';
import { AnthropicProvider } from './anthropic/AnthropicProvider.js';
import { OpenAIProvider } from './openai/OpenAIProvider.js';
import { GeminiProvider } from './gemini/GeminiProvider.js';
import { ProxyProvider } from './proxy/ProxyProvider.js';
import { CodexProvider } from './codex/CodexProvider.js';
import { QwenProvider, createQwenProvider } from './qwen/QwenProvider.js';
import { CursorProvider, createCursorProvider } from './cursor/CursorProvider.js';
import { CopilotProvider, createCopilotProvider } from './copilot/CopilotProvider.js';
import { createCodemieProvider } from './codemie/CodemieProvider.js';
import { ProviderError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface FailoverEvent {
  fromSlot: ProviderSlot;
  toSlot: ProviderSlot;
  reason: string;
}

export interface ProviderChainOptions {
  slots: ProviderSlot[];
  /** Resolve an API key for a given provider name. Return null if unavailable. */
  resolveApiKey: (provider: string) => Promise<string | null>;
  /** Called when automatic failover occurs. */
  onFailover?: (event: FailoverEvent) => void;
  /** Called when provider needs authentication during failover. Return true if auth succeeded. */
  onAuthenticateProvider?: (provider: string) => Promise<boolean>;
  /** For proxy tier: backend URL and access token getter. */
  proxyConfig?: {
    backendUrl: string;
    getAccessToken: () => Promise<string>;
  };
}

export class ProviderChain implements LLMProvider {
  readonly name = 'chain';
  readonly defaultModel: string;

  private health: ProviderHealth;
  private providerCache = new Map<string, LLMProvider>();
  private activeSlotIndex = 0;
  public lastErrors: string[] = [];

  constructor(private options: ProviderChainOptions) {
    if (options.slots.length === 0) throw new ProviderError('ProviderChain requires at least one slot');
    this.defaultModel = options.slots[0].model;
    this.health = new ProviderHealth(options.slots);
  }

  /** Pre-builds providers for all slots. Marks slots unavailable if key is missing. */
  async initialize(): Promise<void> {
    for (const slot of this.options.slots) {
      try {
        await this.getOrBuildProvider(slot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ slot, msg }, 'Provider slot unavailable at init');
        this.health.markUnavailable(slot, msg);
      }
    }
  }

  get activeSlot(): ProviderSlot {
    return this.options.slots[this.activeSlotIndex];
  }

  getHealth(): ProviderHealth {
    return this.health;
  }

  getSlots(): ProviderSlot[] {
    return this.options.slots;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.callWithFailover(async (slot) => {
      const provider = await this.getOrBuildProvider(slot);
      return provider.complete({ ...request, model: slot.model });
    });
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    return this.callWithFailover(
      slot => this.getOrBuildProvider(slot).then(p => p.stream({ ...request, model: slot.model }, handler))
    );
  }

  private async callWithFailover<T>(
    call: (slot: ProviderSlot) => Promise<T>
  ): Promise<T> {
    let attemptedSlots = 0;
    let sameSlotRetried = false;
    let currentSlot: ProviderSlot | null = this.findNextAvailableSlot();

    while (currentSlot && attemptedSlots < this.options.slots.length) {
      const slot = currentSlot;

      // For Codex, check authentication BEFORE attempting call
      if (slot.provider === 'codex') {
        const key = `${slot.provider}/${slot.model}`;
        const cachedProvider = this.providerCache.get(key);

        if (!this.providerCache.has(key)) {
          // Not yet authenticated - try to build provider which will trigger auth
          try {
            const provider = await this.getOrBuildProvider(slot);
            this.providerCache.set(key, provider);

            const result = await call(slot);
            this.health.markHealthy(slot);
            this.activeSlotIndex = this.options.slots.indexOf(slot);
            return result;
          } catch (authErr) {
            // Auth failed or cancelled
            this.health.markUnavailable(slot, 'authentication failed');
            attemptedSlots++;
            currentSlot = this.findNextAvailableSlot(slot);
            continue;
          }
        }
      }

      try {
        let result;
        try {
          result = await call(slot);
        } catch (callErr) {
          throw callErr;
        }
        // Success — ensure slot is marked healthy
        this.health.markHealthy(slot);
        this.activeSlotIndex = this.options.slots.indexOf(slot);
        return result;
      } catch (err) {
        logger.debug({ slot: `${slot.provider}/${slot.model}`, error: (err as Error).message }, 'ProviderChain slot failed');
        const analysis = analyzeError(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        
        // Track error for final error message
        this.lastErrors.push(`${slot.provider}/${slot.model}: ${errMsg}`);

        if (analysis.decision === 'fatal') {
          // Don't failover — rethrow immediately
          throw err;
        }

        if (analysis.decision === 'retry_same' && !sameSlotRetried) {
          // Retry once on the same slot before failing over
          sameSlotRetried = true;
          logger.warn({ slot, reason: analysis.reason }, 'Transient error — retrying same slot');
          await delay(500);
          continue;
        }

        // Failover: mark this slot as failed and retry with next available
        this.health.recordFailure(slot, errMsg, analysis.statusCode);
        sameSlotRetried = false;

        // Find the next available slot, skipping unauthenticated providers
        let nextSlot: ProviderSlot | null = null;
        let searchSlot = this.findNextAvailableSlot(slot);

        while (searchSlot) {
          // Check authentication for each provider type
          let skipReason: string | null = null;

          // Codex: check auth file
          if (searchSlot.provider === 'codex') {
            const codexKey = `${searchSlot.provider}/${searchSlot.model}`;
            if (!this.providerCache.has(codexKey)) {
              const { existsSync } = await import('fs');
              const { homedir } = await import('os');
              const { join } = await import('path');

              const authFilePath = join(homedir(), '.codex', 'auth.json');
              if (!existsSync(authFilePath)) {
                skipReason = 'not authenticated';
              }
            }
          }

          // OpenAI, Anthropic, Gemini: check API key
          if (!skipReason && ['openai', 'anthropic', 'gemini'].includes(searchSlot.provider)) {
            const apiKey = await this.options.resolveApiKey(searchSlot.provider);
            if (!apiKey) {
              skipReason = 'no API key configured';
            }
          }

          // Codemie: check if provider can be created
          if (!skipReason && searchSlot.provider === 'codemie') {
            const { createCodemieProvider } = await import('./codemie/CodemieProvider.js');
            const provider = await createCodemieProvider();
            if (!provider) {
              skipReason = 'not authenticated';
            }
          }

          // Skip if not authenticated
          if (skipReason) {
            process.stderr.write(
              chalk.yellow(`\n⚠  Skipping ${searchSlot.provider}: ${skipReason}.\n`) +
              chalk.dim(`   Run /providers auth ${searchSlot.provider} to enable.\n`)
            );
            this.health.markUnavailable(searchSlot, skipReason);
            searchSlot = this.findNextAvailableSlot(slot);
            continue;
          }

          // Found a valid next slot
          nextSlot = searchSlot;
          break;
        }

        if (nextSlot) {
          this.options.onFailover?.({
            fromSlot: slot,
            toSlot: nextSlot,
            reason: analysis.reason,
          });
          logger.info(
            { from: `${slot.provider}/${slot.model}`, to: `${nextSlot.provider}/${nextSlot.model}`, reason: analysis.reason },
            'Provider failover'
          );
          // Use nextSlot directly on next iteration
          currentSlot = nextSlot;
          this.activeSlotIndex = this.options.slots.indexOf(nextSlot);
          continue;
        } else {
          // No next slot available
          attemptedSlots++;
          currentSlot = null;
        }
      }
    }

    // Build detailed error message with all attempted providers
    const errorDetails = this.lastErrors && this.lastErrors.length > 0 
      ? ` Attempted: ${this.lastErrors.join('; ')}.`
      : '';
    
    throw new ProviderError(`All providers exhausted without a successful response.${errorDetails}`);
  }

  /** Returns the next available slot in priority order, optionally skipping one. */
  private findNextAvailableSlot(skipSlot?: ProviderSlot): ProviderSlot | null {
    // Start from active slot index if set
    const startIndex = this.activeSlotIndex >= 0 ? this.activeSlotIndex : 0;
    
    // First try slots after the active one
    for (let i = startIndex; i < this.options.slots.length; i++) {
      const slot = this.options.slots[i];
      if (skipSlot && slot === skipSlot) continue;
      if (this.health.isAvailable(slot)) return slot;
    }
    
    // Then wrap around to beginning
    for (let i = 0; i < startIndex; i++) {
      const slot = this.options.slots[i];
      if (skipSlot && slot === skipSlot) continue;
      if (this.health.isAvailable(slot)) return slot;
    }
    
    return null;
  }

  private async getOrBuildProvider(slot: ProviderSlot): Promise<LLMProvider> {
    const key = `${slot.provider}/${slot.model}`;
    logger.debug({ slot: key, cached: this.providerCache.has(key) }, 'ProviderChain getOrBuildProvider');
    
    if (this.providerCache.has(key)) return this.providerCache.get(key)!;

    try {
      logger.debug({ slot: key }, 'ProviderChain building provider');
      const provider = await this.buildProvider(slot);
      this.providerCache.set(key, provider);
      return provider;
    } catch (err) {
      logger.debug({ slot: key, error: (err as Error).message }, 'ProviderChain buildProvider failed');
      // If build failed due to auth issue, try inline authentication
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('not authenticated') || errMsg.includes('No credential')) {
        // Try to authenticate inline
        const authSuccess = await this.authenticateProvider(slot.provider);
        if (authSuccess) {
          // Retry building provider after auth
          const provider = await this.buildProvider(slot);
          this.providerCache.set(key, provider);
          return provider;
        }
      }
      throw err;
    }
  }

  private async buildProvider(slot: ProviderSlot): Promise<LLMProvider> {
    // CLI-based providers bypass proxy
    if (slot.provider === 'codex') {
      logger.debug({ slot: `${slot.provider}/${slot.model}` }, 'ProviderChain building Codex');

      const available = await CodexProvider.isAvailable();
      logger.debug({ slot: `${slot.provider}/${slot.model}`, available }, 'ProviderChain Codex isAvailable');

      if (!available) {
        throw new ProviderError('Codex CLI not found');
      }

      // Check for auth file
      const { existsSync } = await import('fs');
      const { homedir } = await import('os');
      const { join } = await import('path');

      const authFilePath = join(homedir(), '.codex', 'auth.json');
      logger.debug({ slot: `${slot.provider}/${slot.model}`, authFilePath, exists: existsSync(authFilePath) }, 'ProviderChain Codex auth file check');

      if (!existsSync(authFilePath)) {
        throw new ProviderError('Codex not authenticated. Run: /providers auth codex');
      }

      return new CodexProvider(slot.model);
    }
    
    // GitHub Copilot CLI-based provider
    if (slot.provider === 'copilot') {
      const provider = createCopilotProvider(slot.model);
      if (!provider) {
        throw new ProviderError('Copilot CLI not available. Run: gh auth login');
      }
      return provider;
    }

    // Proxy tier — other providers route through backend
    if (this.options.proxyConfig) {
      return new ProxyProvider(
        this.options.proxyConfig.backendUrl,
        this.options.proxyConfig.getAccessToken,
        slot.provider
      );
    }

    // Codemie provider (SSO OAuth) - check CredentialStore
    if (slot.provider === 'codemie') {
      const provider = await createCodemieProvider();
      if (!provider) {
        throw new ProviderError('Codemie not authenticated. Run: /providers auth codemie');
      }
      return provider;
    }

    // API key providers - check for stored credentials
    const apiKey = await this.options.resolveApiKey(slot.provider);
    if (!apiKey) {
      throw new ProviderError(`No credential configured for provider '${slot.provider}'. Run: /providers auth ${slot.provider}`);
    }

    switch (slot.provider) {
      case 'anthropic':
      case 'claude':  // Alias for anthropic
        return new AnthropicProvider(apiKey);
      case 'openai':    return new OpenAIProvider(apiKey);
      case 'gemini':    return new GeminiProvider(apiKey);
      case 'qwen': {
        const openRouterKey = process.env.OPENROUTER_API_KEY ?? process.env.EPAM_API_KEY_OPENROUTER;
        if (openRouterKey) return new QwenProvider({ apiKey: openRouterKey, openRouterMode: true });
        return new QwenProvider({ apiKey });
      }
      case 'cursor':    return new CursorProvider({ apiKey });
      default:
        throw new ProviderError(`Unknown provider: '${slot.provider}'`);
    }
  }

  /**
   * Authenticate a provider on-demand during failover
   */
  async authenticateProvider(provider: string): Promise<boolean> {
    if (this.options.onAuthenticateProvider) {
      return this.options.onAuthenticateProvider(provider);
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
