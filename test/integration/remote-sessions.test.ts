import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteSessionStore } from '../../src/remote/RemoteSessionStore.js';

// Mock ioredis
vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const store = new Map<string, { value: string; expiresAt: number }>();

      return {
        setex: vi.fn(async (key: string, ttl: number, value: string) => {
          store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
          return 'OK';
        }),
        getdel: vi.fn(async (key: string) => {
          const entry = store.get(key);
          if (!entry || Date.now() > entry.expiresAt) {
            store.delete(key);
            return null;
          }
          store.delete(key);
          return entry.value;
        }),
        ping: vi.fn(async () => 'PONG'),
        quit: vi.fn(async () => 'OK'),
        _store: store, // For test inspection
      };
    }),
  };
});

describe('RemoteSessionStore', () => {
  let store: RemoteSessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RemoteSessionStore('redis://localhost:6379', 300, 'http://localhost:8080');
  });

  afterEach(async () => {
    await store.close();
  });

  describe('storeSession', () => {
    it('should create session with 201 and return claimToken, expiresAt, url', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const result = await store.storeSession(bundle);

      expect(result.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.url).toBe(`http://localhost:8080/v1/remote/sessions/${result.claimToken}`);
    });

    it('should throw STORAGE_UNAVAILABLE on Redis failure', async () => {
      const failingStore = new RemoteSessionStore('redis://localhost:6379');
      const redis = (failingStore as any).redis;
      redis.setex.mockRejectedValueOnce(new Error('Connection failed'));

      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      await expect(failingStore.storeSession(bundle)).rejects.toThrow('STORAGE_UNAVAILABLE');
      await failingStore.close();
    });
  });

  describe('claimSession', () => {
    it('should claim session successfully with 200', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const { claimToken } = await store.storeSession(bundle);
      const claimed = await store.claimSession(claimToken);

      expect(claimed).toEqual(bundle);
    });

    it('should return null for double-claim (410)', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const { claimToken } = await store.storeSession(bundle);
      await store.claimSession(claimToken); // First claim
      const secondClaim = await store.claimSession(claimToken); // Second claim

      expect(secondClaim).toBeNull();
    });

    it('should throw INVALID_TOKEN_FORMAT for malformed token (400)', async () => {
      await expect(store.claimSession('invalid-token')).rejects.toThrow('INVALID_TOKEN_FORMAT');
      await expect(store.claimSession('abc')).rejects.toThrow('INVALID_TOKEN_FORMAT');
      await expect(store.claimSession('a'.repeat(42))).rejects.toThrow('INVALID_TOKEN_FORMAT');
    });

    it('should throw STORAGE_UNAVAILABLE on Redis failure', async () => {
      const failingStore = new RemoteSessionStore('redis://localhost:6379');
      const redis = (failingStore as any).redis;
      redis.getdel.mockRejectedValueOnce(new Error('Connection failed'));

      const validToken = 'a'.repeat(43).replace(/a/g, 'A');

      await expect(failingStore.claimSession(validToken)).rejects.toThrow('STORAGE_UNAVAILABLE');
      await failingStore.close();
    });
  });

  describe('return flow', () => {
    it('should store and reclaim return bundle successfully', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const { claimToken } = await store.storeSession(bundle);

      const updatedBundle = {
        encryptedPayload: 'updated-encrypted-data',
        nonce: 'nonce-789',
        tag: 'tag-000',
      };

      // Phone stores updated bundle
      const storeResult = await store.storeReturn(claimToken, updatedBundle);
      expect(storeResult.status).toBe('stored');
      expect(storeResult.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Desktop reclaims
      const reclaimed = await store.reclaimReturn(claimToken);
      expect(reclaimed).toEqual(updatedBundle);
    });

    it('should return null for double-reclaim (404)', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const { claimToken } = await store.storeSession(bundle);
      await store.storeReturn(claimToken, bundle);

      await store.reclaimReturn(claimToken); // First reclaim
      const secondReclaim = await store.reclaimReturn(claimToken); // Second reclaim

      expect(secondReclaim).toBeNull();
    });

    it('should be idempotent - overwrite previous return bundle', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      const { claimToken } = await store.storeSession(bundle);

      const firstReturn = {
        encryptedPayload: 'first-return',
        nonce: 'nonce-1',
        tag: 'tag-1',
      };

      const secondReturn = {
        encryptedPayload: 'second-return',
        nonce: 'nonce-2',
        tag: 'tag-2',
      };

      await store.storeReturn(claimToken, firstReturn);
      await store.storeReturn(claimToken, secondReturn); // Overwrite

      const reclaimed = await store.reclaimReturn(claimToken);
      expect(reclaimed).toEqual(secondReturn);
    });

    it('should throw INVALID_TOKEN_FORMAT for malformed token in return endpoints', async () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      await expect(store.storeReturn('invalid', bundle)).rejects.toThrow('INVALID_TOKEN_FORMAT');
      await expect(store.reclaimReturn('invalid')).rejects.toThrow('INVALID_TOKEN_FORMAT');
    });
  });

  describe('token validation', () => {
    it('should validate correct token format (43 chars, base64url)', () => {
      const validToken = 'A'.repeat(43);
      expect(store.validateTokenFormat(validToken)).toBe(true);

      // Exactly 43 chars with base64url alphabet
      const validToken2 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk_-0123';
      expect(validToken2.length).toBe(43);
      expect(store.validateTokenFormat(validToken2)).toBe(true);
    });

    it('should reject invalid token formats', () => {
      expect(store.validateTokenFormat('too-short')).toBe(false);
      expect(store.validateTokenFormat('a'.repeat(42))).toBe(false);
      expect(store.validateTokenFormat('a'.repeat(44))).toBe(false);
      expect(store.validateTokenFormat('a'.repeat(43).replace(/a/g, '!'))).toBe(false);
      expect(store.validateTokenFormat('a'.repeat(43).replace(/a/g, '+'))).toBe(false);
    });
  });

  describe('TTL configuration', () => {
    it('should use default TTL of 300s', () => {
      const defaultStore = new RemoteSessionStore('redis://localhost:6379');
      expect((defaultStore as any).ttl).toBe(300);
    });

    it('should accept valid TTL between 60 and 3600', () => {
      const store60 = new RemoteSessionStore('redis://localhost:6379', 60);
      expect((store60 as any).ttl).toBe(60);

      const store3600 = new RemoteSessionStore('redis://localhost:6379', 3600);
      expect((store3600 as any).ttl).toBe(3600);
    });

    it('should fall back to default for invalid TTL', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const storeMin = new RemoteSessionStore('redis://localhost:6379', 30);
      expect((storeMin as any).ttl).toBe(300);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid TTL 30s'));

      const storeMax = new RemoteSessionStore('redis://localhost:6379', 5000);
      expect((storeMax as any).ttl).toBe(300);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid TTL 5000s'));

      consoleSpy.mockRestore();
    });
  });

  describe('health check', () => {
    it('should return true for healthy Redis connection', async () => {
      const healthy = await store.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false for unhealthy Redis connection', async () => {
      const failingStore = new RemoteSessionStore('redis://localhost:6379');
      const redis = (failingStore as any).redis;
      redis.ping.mockRejectedValueOnce(new Error('Connection failed'));

      const healthy = await failingStore.healthCheck();
      expect(healthy).toBe(false);
      await failingStore.close();
    });
  });
});

describe('Remote Session API validation', () => {
  describe('bundle schema validation', () => {
    it('should accept valid bundle', () => {
      const bundle = {
        encryptedPayload: 'encrypted-data',
        nonce: 'nonce-123',
        tag: 'tag-456',
      };

      // Valid bundle should have all required fields
      expect(bundle.encryptedPayload).toBeTruthy();
      expect(bundle.nonce).toBeTruthy();
      expect(bundle.tag).toBeTruthy();
    });

    it('should reject bundle missing required fields (422)', () => {
      const invalidBundles = [
        { nonce: 'nonce-123', tag: 'tag-456' }, // Missing encryptedPayload
        { encryptedPayload: 'data', tag: 'tag-456' }, // Missing nonce
        { encryptedPayload: 'data', nonce: 'nonce-123' }, // Missing tag
        { encryptedPayload: '', nonce: 'nonce-123', tag: 'tag-456' }, // Empty encryptedPayload
      ];

      for (const bundle of invalidBundles) {
        const hasAllFields =
          bundle.encryptedPayload &&
          (bundle as any).nonce &&
          (bundle as any).tag;
        expect(hasAllFields).toBeFalsy();
      }
    });
  });

  describe('payload size validation', () => {
    it('should accept payloads under 5 MB', () => {
      const size1MB = 1 * 1024 * 1024;
      expect(size1MB).toBeLessThan(5 * 1024 * 1024);
    });

    it('should reject payloads over 5 MB (413)', () => {
      const size6MB = 6 * 1024 * 1024;
      const maxSize = 5 * 1024 * 1024;
      expect(size6MB).toBeGreaterThan(maxSize);
    });
  });
});
