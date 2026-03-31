import type { AuthManager } from '../auth/AuthManager.js';
import { createAuthInterceptor } from './interceptors.js';
import { HttpError } from './errors.js';
import type { UserProfile } from '../auth/types.js';

export class BackendClient {
  private fetch: ReturnType<typeof createAuthInterceptor>;

  constructor(
    private readonly backendUrl: string,
    authManager: AuthManager
  ) {
    this.fetch = createAuthInterceptor(authManager);
  }

  async getUserProfile(): Promise<UserProfile & { tier: string }> {
    return this.request<UserProfile & { tier: string }>('/v1/users/me');
  }

  async getSubscription(): Promise<{
    tier: string;
    expiresAt: string;
    features: Record<string, unknown>;
  }> {
    return this.request('/v1/subscription');
  }

  async proxyRequest(
    provider: string,
    path: string,
    body: unknown
  ): Promise<unknown> {
    return this.request(`/v1/proxy/${provider}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async syncPush(projectId: string, payload: unknown): Promise<void> {
    await this.request(`/v1/sync/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async syncPull(projectId: string): Promise<{ contextMd: string; decisionsJsonl: string; timestamp: string }> {
    return this.request<{ contextMd: string; decisionsJsonl: string; timestamp: string }>(
      `/v1/sync/${encodeURIComponent(projectId)}`
    );
  }

  async getProjectConstraints(projectId: string): Promise<unknown> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/constraints`);
  }

  async createRemoteSession(bundle: {
    encryptedPayload: string;
    nonce: string;
    tag: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ claimToken: string; expiresAt: string; url: string }> {
    return this.request('/v1/remote/sessions', {
      method: 'POST',
      body: JSON.stringify(bundle),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async claimRemoteSession(token: string): Promise<{
    encryptedPayload: string;
    nonce: string;
    tag: string;
    metadata?: Record<string, unknown>;
  }> {
    return this.request(`/v1/remote/sessions/${encodeURIComponent(token)}`);
  }

  async returnRemoteSession(
    token: string,
    bundle: {
      encryptedPayload: string;
      nonce: string;
      tag: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ status: string; expiresAt: string }> {
    return this.request(`/v1/remote/sessions/${encodeURIComponent(token)}/return`, {
      method: 'POST',
      body: JSON.stringify(bundle),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async reclaimRemoteSession(token: string): Promise<{
    encryptedPayload: string;
    nonce: string;
    tag: string;
    metadata?: Record<string, unknown>;
  }> {
    return this.request(`/v1/remote/sessions/${encodeURIComponent(token)}/return`);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.backendUrl}${path}`;
    const response = await this.fetch(url, options);

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      throw new HttpError(response.status, response.statusText, body, url);
    }

    return response.json() as Promise<T>;
  }
}
