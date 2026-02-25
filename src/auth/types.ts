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
