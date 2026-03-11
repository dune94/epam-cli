import Redis from 'ioredis';

export interface SessionBundle {
  encryptedPayload: string;
  nonce: string;
  tag: string;
  metadata?: Record<string, unknown>;
}

export interface StoreSessionResult {
  claimToken: string;
  expiresAt: string;
  url: string;
}

export class RemoteSessionStore {
  private readonly redis: Redis;
  private readonly ttl: number;
  private readonly baseUrl: string;

  constructor(redisUrl: string, ttlSeconds?: number, baseUrl?: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 1000);
      },
    });

    // Validate and set TTL (default 300s, min 60s, max 3600s)
    const rawTtl = ttlSeconds || 300;
    if (rawTtl < 60 || rawTtl > 3600) {
      console.warn(
        `Invalid TTL ${rawTtl}s, must be between 60 and 3600. Falling back to default 300s.`
      );
      this.ttl = 300;
    } else {
      this.ttl = rawTtl;
    }

    this.baseUrl = baseUrl || 'http://localhost:8080';
  }

  /**
   * Generate a cryptographically random 32-byte token, base64url-encoded (43 chars)
   */
  private generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    // Convert to base64url encoding
    let base64 = Buffer.from(bytes).toString('base64');
    base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return base64;
  }

  /**
   * Validate token format: exactly 43 characters, base64url alphabet [A-Za-z0-9_-]
   */
  validateTokenFormat(token: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(token);
  }

  /**
   * Store a session bundle and return claim token with expiry
   */
  async storeSession(bundle: SessionBundle): Promise<StoreSessionResult> {
    const token = this.generateToken();
    const key = `epam:remote:session:${token}`;
    const expiresAt = new Date(Date.now() + this.ttl * 1000).toISOString();

    try {
      await this.redis.setex(key, this.ttl, JSON.stringify(bundle));
    } catch (error) {
      throw new Error('STORAGE_UNAVAILABLE');
    }

    return {
      claimToken: token,
      expiresAt,
      url: `${this.baseUrl}/v1/remote/sessions/${token}`,
    };
  }

  /**
   * Atomically retrieve and delete a session (single-use claim)
   * Returns null if token not found or already claimed
   */
  async claimSession(token: string): Promise<SessionBundle | null> {
    if (!this.validateTokenFormat(token)) {
      throw new Error('INVALID_TOKEN_FORMAT');
    }

    const key = `epam:remote:session:${token}`;

    try {
      // GETDEL atomically gets and deletes the key
      const value = await this.redis.getdel(key);

      if (!value) {
        return null;
      }

      return JSON.parse(value) as SessionBundle;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw error;
      }
      throw new Error('STORAGE_UNAVAILABLE');
    }
  }

  /**
   * Store an updated session bundle for return (phone -> desktop)
   * Idempotent: overwrites previous return bundle and resets TTL
   */
  async storeReturn(token: string, bundle: SessionBundle): Promise<{ status: string; expiresAt: string }> {
    if (!this.validateTokenFormat(token)) {
      throw new Error('INVALID_TOKEN_FORMAT');
    }

    const key = `epam:remote:return:${token}`;
    const expiresAt = new Date(Date.now() + this.ttl * 1000).toISOString();

    try {
      await this.redis.setex(key, this.ttl, JSON.stringify(bundle));
    } catch (error) {
      throw new Error('STORAGE_UNAVAILABLE');
    }

    return {
      status: 'stored',
      expiresAt,
    };
  }

  /**
   * Atomically retrieve and delete a return bundle (desktop reclaim)
   * Returns null if return bundle not found
   */
  async reclaimReturn(token: string): Promise<SessionBundle | null> {
    if (!this.validateTokenFormat(token)) {
      throw new Error('INVALID_TOKEN_FORMAT');
    }

    const key = `epam:remote:return:${token}`;

    try {
      const value = await this.redis.getdel(key);

      if (!value) {
        return null;
      }

      return JSON.parse(value) as SessionBundle;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw error;
      }
      throw new Error('STORAGE_UNAVAILABLE');
    }
  }

  /**
   * Check if Redis connection is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
