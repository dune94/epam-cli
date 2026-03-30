export type SubscriptionTier = 'free' | 'pro' | 'enterprise';

export interface TierCapabilities {
  tier: SubscriptionTier;
  byok: boolean;          // bring-your-own-key
  usesProxy: boolean;     // route through backend proxy
  maxContextTokens: number;
  maxOutputTokens: number;
  rateLimit: {
    requestsPerMinute: number;
    tokensPerDay: number;
  };
}

export const TIER_CAPABILITIES: Record<SubscriptionTier, TierCapabilities> = {
  free: {
    tier: 'free',
    byok: true,
    usesProxy: false,
    maxContextTokens: 100000,
    maxOutputTokens: 4096,
    rateLimit: { requestsPerMinute: 10, tokensPerDay: 100000 },
  },
  pro: {
    tier: 'pro',
    byok: false,
    usesProxy: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 1000000 },
  },
  enterprise: {
    tier: 'enterprise',
    byok: false,
    usesProxy: true,
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
    rateLimit: { requestsPerMinute: 300, tokensPerDay: 10000000 },
  },
};
