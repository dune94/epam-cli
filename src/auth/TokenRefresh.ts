import type { TokenSet } from './types.js';
import { AuthError } from '../utils/errors.js';

export class TokenRefresh {
  constructor(
    private readonly backendUrl: string,
    private readonly clientId: string
  ) {}

  async refresh(tokenSet: TokenSet): Promise<TokenSet> {
    if (!tokenSet.refreshToken) {
      throw new AuthError('No refresh token available. Please run `epam login` again.');
    }

    const res = await fetch(`${this.backendUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenSet.refreshToken,
        client_id: this.clientId,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AuthError(`Token refresh failed: ${res.status} ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string | undefined) ?? tokenSet.refreshToken,
      idToken: (data.id_token as string | undefined) ?? tokenSet.idToken,
      expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
      tokenType: (data.token_type as string | undefined) ?? 'Bearer',
      scope: (data.scope as string | undefined) ?? tokenSet.scope,
    };
  }
}
