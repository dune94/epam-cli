import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler } from './types.js';
import type { ProviderSlot } from './health/types.js';
import { ProviderHealth } from './health/ProviderHealth.js';
import { analyzeError } from './health/FailoverPolicy.js';
import { AnthropicProvider } from './anthropic/AnthropicProvider.js';
import { OpenAIProvider } from './openai/OpenAIProvider.js';
import { GeminiProvider } from './gemini/GeminiProvider.js';
import { ProxyProvider } from './proxy/ProxyProvider.js';
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
    return this.callWithFailover(
      slot => this.getOrBuildProvider(slot).then(p => p.complete({ ...request, model: slot.model }))
    );
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

    while (attemptedSlots < this.options.slots.length) {
      const slot = this.findNextAvailableSlot();
      if (!slot) {
        throw new ProviderError(
          'All providers in the chain are currently unavailable. ' +
          'Use /chain reset to clear circuit breakers or wait for cooldowns to expire.'
        );
      }

      try {
        const result = await call(slot);
        // Success — ensure slot is marked healthy
        this.health.markHealthy(slot);
        this.activeSlotIndex = this.options.slots.indexOf(slot);
        return result;
      } catch (err) {
        const analysis = analyzeError(err);
        const errMsg = err instanceof Error ? err.message : String(err);

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

        // Failover: mark this slot as failed
        this.health.recordFailure(slot, errMsg, analysis.statusCode);
        attemptedSlots++;
        sameSlotRetried = false;

        // Find the next available slot
        const nextSlot = this.findNextAvailableSlot(slot);
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
        }
      }
    }

    throw new ProviderError('All providers exhausted without a successful response.');
  }

  /** Returns the next available slot in priority order, optionally skipping one. */
  private findNextAvailableSlot(skipSlot?: ProviderSlot): ProviderSlot | null {
    for (const slot of this.options.slots) {
      if (skipSlot && slot === skipSlot) continue;
      if (this.health.isAvailable(slot)) return slot;
    }
    return null;
  }

  private async getOrBuildProvider(slot: ProviderSlot): Promise<LLMProvider> {
    const key = `${slot.provider}/${slot.model}`;
    if (this.providerCache.has(key)) return this.providerCache.get(key)!;

    const provider = await this.buildProvider(slot);
    this.providerCache.set(key, provider);
    return provider;
  }

  private async buildProvider(slot: ProviderSlot): Promise<LLMProvider> {
    // Proxy tier — all providers route through backend
    if (this.options.proxyConfig) {
      return new ProxyProvider(
        this.options.proxyConfig.backendUrl,
        this.options.proxyConfig.getAccessToken,
        slot.provider
      );
    }

    // BYOK/Brokered/Bridge — resolve API key
    const apiKey = await this.options.resolveApiKey(slot.provider);
    if (!apiKey) {
      throw new ProviderError(`No credential configured or resolved for provider '${slot.provider}'`);
    }

    switch (slot.provider) {
      case 'anthropic': return new AnthropicProvider(apiKey);
      case 'openai':    return new OpenAIProvider(apiKey);
      case 'gemini':    return new GeminiProvider(apiKey);
      default:
        throw new ProviderError(`Unknown provider: '${slot.provider}'`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
