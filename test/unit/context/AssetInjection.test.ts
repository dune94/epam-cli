import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAssetAlertBlock,
  injectAssetAlert,
} from '../../../src/context/ContextBuilder.js';
import { getAssetStore, resetAssetStore } from '../../../src/assets/AssetStore.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { AssetMatch } from '../../../src/assets/types.js';

describe('ContextBuilder - Asset Injection', () => {
  describe('buildAssetAlertBlock', () => {
    it('should return empty string for no matches', () => {
      const result = buildAssetAlertBlock([]);
      expect(result).toBe('');
    });

    it('should build asset alert block with correct format', () => {
      const matches: AssetMatch[] = [
        {
          asset: {
            id: 'test-1',
            title: 'Test Asset',
            description: 'Test description',
            tags: ['test'],
            repoUrl: 'https://example.com/test',
          },
          score: 0.8,
          matchedFields: ['title'],
        },
      ];

      const result = buildAssetAlertBlock(matches);

      expect(result).toContain('[ASSET ALERT]');
      expect(result).toContain('Test Asset');
      expect(result).toContain('https://example.com/test');
      expect(result).toContain('Test description');
    });

    it('should format multiple assets', () => {
      const matches: AssetMatch[] = [
        {
          asset: {
            id: 'test-1',
            title: 'Asset One',
            description: 'First asset',
            tags: ['test'],
            repoUrl: 'https://example.com/one',
          },
          score: 0.9,
          matchedFields: ['title'],
        },
        {
          asset: {
            id: 'test-2',
            title: 'Asset Two',
            description: 'Second asset',
            tags: ['test'],
            repoUrl: 'https://example.com/two',
          },
          score: 0.7,
          matchedFields: ['description'],
        },
      ];

      const result = buildAssetAlertBlock(matches);

      expect(result).toContain('Asset One');
      expect(result).toContain('Asset Two');
      expect(result.split('\n').length).toBe(3); // Header + 2 assets
    });
  });

  describe('injectAssetAlert', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `context-builder-test-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
      resetAssetStore();
    });

    afterEach(async () => {
      resetAssetStore();
      if (existsSync(testDir)) {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it('should return original message when no assets.json', async () => {
      const message = 'How do I implement authentication?';
      const result = await injectAssetAlert(message, testDir);

      expect(result).toBe(message);
    });

    it('should inject asset alert when matches found', async () => {
      // Setup test assets with keywords that will match the query
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });

      const assets = [
        {
          id: 'auth-lib',
          title: 'OAuth Authentication Library',
          description: 'Implement OAuth authentication in your app',
          tags: ['auth', 'oauth', 'authentication'],
          repoUrl: 'https://example.com/auth',
        },
      ];

      await writeFile(assetsPath, JSON.stringify(assets));

      const message = 'How do I implement OAuth authentication?';
      const result = await injectAssetAlert(message, testDir);

      expect(result).toContain('[ASSET ALERT]');
      expect(result).toContain('OAuth Authentication Library');
      expect(result).toContain(message); // Original message preserved
    });

    it('should not inject when query has no matches above threshold', async () => {
      // Setup test assets
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });

      const assets = [
        {
          id: 'payment-sdk',
          title: 'Payment SDK',
          description: 'Payment processing',
          tags: ['payments'],
          repoUrl: 'https://example.com/payments',
        },
      ];

      await writeFile(assetsPath, JSON.stringify(assets));

      const message = 'How do I make coffee?';
      const result = await injectAssetAlert(message, testDir);

      expect(result).toBe(message);
    });

    it('should prepend asset block before user message', async () => {
      const assetsPath = join(testDir, '.epam', 'assets.json');
      await mkdir(join(testDir, '.epam'), { recursive: true });

      const assets = [
        {
          id: 'test',
          title: 'Test Asset',
          description: 'Test',
          tags: ['test'],
          repoUrl: 'https://example.com',
        },
      ];

      await writeFile(assetsPath, JSON.stringify(assets));

      const message = 'test query';
      const result = await injectAssetAlert(message, testDir);

      const assetBlockEnd = result.indexOf('\n\n');
      expect(assetBlockEnd).toBeGreaterThan(0);
      expect(result.substring(assetBlockEnd + 2)).toBe(message);
    });
  });
});
