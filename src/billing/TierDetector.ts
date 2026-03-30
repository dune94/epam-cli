import { extractTier } from '../auth/JWTDecoder.js';
import { loadTokenSet } from '../auth/TokenStore.js';
import type { SubscriptionTier, TierCapabilities } from './types.js';
import { TIER_CAPABILITIES } from './types.js';

export async function detectTier(): Promise<SubscriptionTier> {
  const tokenSet = await loadTokenSet();
  if (!tokenSet) return 'free';

  const tier = extractTier(tokenSet.accessToken);
  if (tier === 'pro' || tier === 'enterprise') return tier;
  return 'free';
}

export async function getTierCapabilities(): Promise<TierCapabilities> {
  const tier = await detectTier();
  return TIER_CAPABILITIES[tier];
}

export function parseTier(value: string | undefined): SubscriptionTier {
  if (value === 'pro' || value === 'enterprise') return value;
  return 'free';
}
