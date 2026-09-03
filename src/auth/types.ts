export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;        // Unix timestamp ms
  tokenType: string;
  scope?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface JWTClaims {
  sub: string;
  email?: string;
  name?: string;
  tier?: string;
  exp: number;
  iat: number;
  iss: string;
  aud: string | string[];
}

export type AuthState =
  | { status: 'authenticated'; tokenSet: TokenSet; user: UserProfile }
  | { status: 'unauthenticated' }
  | { status: 'refreshing' };

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/**
 * THE PROVIDERS, ONCE — as a value, because a type cannot be iterated.
 *
 * This was a type alone, so every caller that needed to LOOP over providers wrote the list again:
 * provider.ts, doctor.ts, keys.ts and UserCommand.ts each carried their own copy, and by
 * 2026-08-28 they had drifted — three listed three providers, the fourth listed six. Found by the
 * hardcoding audit.
 *
 * The type is derived from the value below, so the two can never disagree: adding a provider here
 * updates every caller and every exhaustiveness check at once.
 */
export const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'] as const;

export type ProviderName = typeof PROVIDER_NAMES[number];

export type ProviderCredentialSource =
  | 'epam_brokered_local'
  | 'provider_browser'
  | 'manual_api_key';

export type ProviderCredentialType = 'api_key' | 'browser_session' | 'brokered_key';

export interface ProviderCredentialRecord {
  provider: ProviderName;
  type: ProviderCredentialType;
  source: ProviderCredentialSource;
  secret: string;
  accountLabel?: string;
  workspaceLabel?: string;
  organizationLabel?: string;
  createdAt: string;
  expiresAt?: string;
  refreshable?: boolean;
}
