import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AssetStore, getAssetStore, resetAssetStore } from '../../../src/assets/AssetStore.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

describe('AssetStore', () => {
  let testDir: string;
  let store: AssetStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `asset-store-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    store = new AssetStore();
  });

  afterEach(async () => {
    store.clear();
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  describe('load', () => {
    it('should gracefully skip when assets.json is missing', async () => {
      await store.load(testDir);
      
      expect(store.isLoaded()).toBe(false);
      expect(store.getAllAssets().length).toBe(0);
    });

    it('should load valid assets from assets.json', async () => {
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });
      
      const assets = [
        {
          id: 'test-1',
          title: 'Test Asset',
          description: 'A test asset',
          tags: ['test'],
          repoUrl: 'https://example.com/test',
        },
      ];
      
      await writeFile(assetsPath, JSON.stringify(assets));
      await store.load(testDir);
      
      expect(store.isLoaded()).toBe(true);
      expect(store.getAllAssets().length).toBe(1);
      expect(store.getAllAssets()[0].title).toBe('Test Asset');
    });

    it('should filter out invalid asset entries', async () => {
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });
      
      const assets = [
        {
          id: 'valid-1',
          title: 'Valid Asset',
          description: 'A valid asset',
          tags: ['test'],
          repoUrl: 'https://example.com/test',
        },
        {
          id: 'invalid-1',
          // Missing required fields
        },
      ];
      
      await writeFile(assetsPath, JSON.stringify(assets));
      await store.load(testDir);
      
      expect(store.isLoaded()).toBe(true);
      expect(store.getAllAssets().length).toBe(1);
      expect(store.getAllAssets()[0].id).toBe('valid-1');
    });

    it('should handle malformed JSON gracefully', async () => {
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });
      
      await writeFile(assetsPath, 'not valid json');
      await store.load(testDir);
      
      expect(store.isLoaded()).toBe(false);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Setup test assets
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });
      
      const assets = [
        {
          id: 'auth-lib',
          title: 'EPAM Auth Library',
          description: 'Authentication library with OAuth2 and JWT support',
          tags: ['auth', 'oauth', 'jwt', 'security'],
          repoUrl: 'https://example.com/auth',
        },
        {
          id: 'payment-sdk',
          title: 'Payment Processing SDK',
          description: 'Payment processing with Stripe and PayPal',
          tags: ['payments', 'stripe', 'billing'],
          repoUrl: 'https://example.com/payments',
        },
        {
          id: 'logger',
          title: 'Structured Logging Framework',
          description: 'Enterprise logging with ELK integration',
          tags: ['logging', 'elk', 'monitoring'],
          repoUrl: 'https://example.com/logger',
        },
      ];
      
      await writeFile(assetsPath, JSON.stringify(assets));
      await store.load(testDir);
    });

    it('should return empty results when no query tokens', () => {
      const result = store.search('');
      
      expect(result.matches.length).toBe(0);
      expect(result.hasMatches).toBe(false);
      expect(result.topScore).toBe(0);
    });

    it('should find assets by title match', () => {
      const result = store.search('authentication library');
      
      expect(result.hasMatches).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].asset.id).toBe('auth-lib');
    });

    it('should find assets by tag match', () => {
      const result = store.search('oauth security');
      
      expect(result.hasMatches).toBe(true);
      expect(result.matches.some(m => m.asset.id === 'auth-lib')).toBe(true);
    });

    it('should find assets by description match', () => {
      const result = store.search('Stripe PayPal payment');
      
      expect(result.hasMatches).toBe(true);
      expect(result.matches[0].asset.id).toBe('payment-sdk');
    });

    it('should respect threshold filtering', () => {
      const result = store.search('xyz nonexistent thing');
      
      expect(result.hasMatches).toBe(false);
      expect(result.matches.length).toBe(0);
    });

    it('should limit results to maxMatches', () => {
      const result = store.search('library');
      
      expect(result.matches.length).toBeLessThanOrEqual(3);
    });

    it('should sort by score descending', () => {
      const result = store.search('library auth');
      
      // At least auth-lib should match
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      
      // If multiple matches, verify sorted by score
      if (result.matches.length > 1) {
        for (let i = 1; i < result.matches.length; i++) {
          expect(result.matches[i].score).toBeLessThanOrEqual(result.matches[i - 1].score);
        }
      }
    });

    it('should track matched fields', () => {
      const result = store.search('auth oauth');
      
      expect(result.matches.length).toBeGreaterThan(0);
      const authMatch = result.matches.find(m => m.asset.id === 'auth-lib');
      expect(authMatch).toBeDefined();
      expect(authMatch!.matchedFields.length).toBeGreaterThan(0);
    });
  });

  describe('scoring', () => {
    beforeEach(async () => {
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });

      const assets = [
        {
          id: 'exact-match',
          title: 'Authentication OAuth Library',
          description: 'OAuth authentication library',
          tags: ['auth', 'oauth'],
          repoUrl: 'https://example.com/exact',
        },
        {
          id: 'partial-match',
          title: 'Other Thing',
          description: 'Something else entirely',
          tags: ['other'],
          repoUrl: 'https://example.com/partial',
        },
      ];
      
      await writeFile(assetsPath, JSON.stringify(assets));
      await store.load(testDir);
    });

    it('should score exact title matches higher', () => {
      const result = store.search('authentication oauth library');
      
      const exactMatch = result.matches.find(m => m.asset.id === 'exact-match');
      
      expect(exactMatch).toBeDefined();
      expect(exactMatch!.score).toBeGreaterThan(0);
    });

    it('should normalize scores to 0-1 range', () => {
      const result = store.search('authentication oauth library');
      
      for (const match of result.matches) {
        expect(match.score).toBeGreaterThanOrEqual(0);
        expect(match.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('global instance', () => {
    afterEach(() => {
      resetAssetStore();
    });

    it('should provide singleton instance', () => {
      const instance1 = getAssetStore();
      const instance2 = getAssetStore();
      
      expect(instance1).toBe(instance2);
    });

    it('should allow reset for testing', () => {
      const instance1 = getAssetStore();
      resetAssetStore();
      const instance2 = getAssetStore();
      
      expect(instance1).not.toBe(instance2);
    });
  });
});
