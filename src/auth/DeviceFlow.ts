import type { TokenSet, DeviceAuthorizationResponse } from './types.js';
import { AuthError } from '../utils/errors.js';

interface DeviceFlowConfig {
  backendUrl: string;
  clientId: string;
  scope: string;
}

export class DeviceFlow {
  constructor(private config: DeviceFlowConfig) {}

  async startFlow(): Promise<DeviceAuthorizationResponse> {
    const res = await fetch(`${this.config.backendUrl}/oauth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        scope: this.config.scope,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AuthError(`Failed to start device flow: ${res.status} ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    return {
      deviceCode: data.device_code as string,
      userCode: data.user_code as string,
      verificationUri: data.verification_uri as string,
      verificationUriComplete: data.verification_uri_complete as string | undefined,
      expiresIn: data.expires_in as number,
      interval: (data.interval as number | undefined) ?? 5,
    };
  }

  async pollForToken(
    deviceCode: string,
    intervalSeconds: number,
    timeoutMs: number = 300000
  ): Promise<TokenSet> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this.sleep(intervalSeconds * 1000);

      try {
        const res = await fetch(`${this.config.backendUrl}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: this.config.clientId,
          }).toString(),
        });

        const data = await res.json() as Record<string, unknown>;

        if (res.ok) {
          return {
            accessToken: data.access_token as string,
            refreshToken: data.refresh_token as string | undefined,
            idToken: data.id_token as string | undefined,
            expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
            tokenType: (data.token_type as string | undefined) ?? 'Bearer',
            scope: data.scope as string | undefined,
          };
        }

        if (data.error === 'authorization_pending' || data.error === 'slow_down') {
          if (data.error === 'slow_down') {
            intervalSeconds += 5;
          }
          continue;
        }

        if (data.error === 'expired_token') {
          throw new AuthError('Device code expired. Please run `epam login` again.');
        }

        if (data.error === 'access_denied') {
          throw new AuthError('Authorization was denied.');
        }

        throw new AuthError(`Token error: ${(data.error_description ?? data.error) as string}`);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        // Network error — retry
      }
    }

    throw new AuthError('Device flow timed out. Please run `epam login` again.');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
