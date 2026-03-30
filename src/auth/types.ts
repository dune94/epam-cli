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

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

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
