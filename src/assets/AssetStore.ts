import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import {
  type Asset,
  type AssetMatch,
  type AssetSearchResult,
  type AssetSearchConfig,
  DEFAULT_ASSET_SEARCH_CONFIG,
  AssetSchema,
} from './types.js';

// Re-export types for convenience
export type { Asset, AssetMatch, AssetSearchResult, AssetSearchConfig };

/**
 * AssetStore: Manages enterprise asset discovery for RAG POC.
 *
 * Reads assets from .epam/assets.json and provides keyword-based
 * search functionality to discover relevant assets for user queries.
 */
export class AssetStore {
  private assets: Asset[] = [];
  private loaded: boolean = false;
  private loadFailed: boolean = false;
  private config: AssetSearchConfig;

  constructor(config: Partial<AssetSearchConfig> = {}) {
    this.config = { ...DEFAULT_ASSET_SEARCH_CONFIG, ...config };
  }

  /**
   * Load assets from .epam/assets.json.
   * Gracefully handles missing file (common case).
   *
   * @param projectRoot - Project root directory
   */
  async load(projectRoot: string = process.cwd()): Promise<void> {
    if (this.loaded || this.loadFailed) {
      return;
    }

    const assetsPath = join(projectRoot, '.epam', 'assets.json');

    if (!existsSync(assetsPath)) {
      logger.debug({ path: assetsPath }, 'AssetStore: No assets.json found, skipping');
      this.loadFailed = true; // Mark as failed to avoid repeated checks
      return;
    }

    try {
      const content = await readFile(assetsPath, 'utf-8');
      const data = JSON.parse(content);

      // Validate and filter assets
      if (Array.isArray(data)) {
        this.assets = data
          .map((asset, index) => this.validateAsset(asset, index))
          .filter((asset): asset is Asset => asset !== null);

        this.loaded = true;
        logger.info({ assetCount: this.assets.length }, 'AssetStore: Loaded assets');
      } else {
        logger.warn('AssetStore: assets.json should contain an array');
        this.loadFailed = true;
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'AssetStore: Failed to load assets.json');
      this.loadFailed = true;
    }
  }

  /**
   * Validate a single asset entry.
   */
  private validateAsset(asset: unknown, index: number): Asset | null {
    try {
      const validated = AssetSchema.parse(asset);
      return validated;
    } catch (err) {
      logger.warn({ index, error: (err as Error).message }, 'AssetStore: Invalid asset entry');
      return null;
    }
  }

  /**
   * Search for assets matching a query.
   *
   * Uses keyword matching: tokenizes query and assets, scores by term overlap
   * in title, description, and tags fields.
   *
   * @param query - User message or search query
   * @returns Search results with top matching assets
   */
  search(query: string): AssetSearchResult {
    if (!this.loaded || this.assets.length === 0) {
      return { matches: [], hasMatches: false, topScore: 0 };
    }

    const queryTokens = this.tokenize(query);

    if (queryTokens.size === 0) {
      return { matches: [], hasMatches: false, topScore: 0 };
    }

    const matches: AssetMatch[] = [];

    for (const asset of this.assets) {
      const match = this.scoreAsset(asset, queryTokens);
      if (match.score >= this.config.threshold) {
        matches.push(match);
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Return top N matches
    const topMatches = matches.slice(0, this.config.maxMatches);
    const topScore = topMatches.length > 0 ? topMatches[0].score : 0;

    return {
      matches: topMatches,
      hasMatches: topMatches.length > 0,
      topScore,
    };
  }

  /**
   * Score an asset against query tokens.
   */
  private scoreAsset(asset: Asset, queryTokens: Set<string>): AssetMatch {
    const matchedFields: Array<'title' | 'description' | 'tags'> = [];
    let totalScore = 0;

    // Tokenize asset fields
    const titleTokens = this.tokenize(asset.title);
    const descriptionTokens = this.tokenize(asset.description);
    const tagTokens = new Set(asset.tags.map(t => t.toLowerCase()));

    // Score title matches (highest weight)
    const titleMatches = this.countMatches(titleTokens, queryTokens);
    if (titleMatches > 0) {
      const titleScore = titleMatches / Math.max(titleTokens.size, 1);
      totalScore += titleScore * 0.5; // 50% weight for title
      matchedFields.push('title');
    }

    // Score description matches (medium weight)
    const descriptionMatches = this.countMatches(descriptionTokens, queryTokens);
    if (descriptionMatches > 0) {
      const descriptionScore = descriptionMatches / Math.max(descriptionTokens.size, 1);
      totalScore += descriptionScore * 0.3; // 30% weight for description
      matchedFields.push('description');
    }

    // Score tag matches (lower weight but high precision)
    const tagMatches = this.countMatches(tagTokens, queryTokens);
    if (tagMatches > 0) {
      const tagScore = tagMatches / Math.max(asset.tags.length, 1);
      totalScore += tagScore * 0.2; // 20% weight for tags
      matchedFields.push('tags');
    }

    // Normalize score to 0-1 range
    const normalizedScore = Math.min(totalScore, 1.0);

    return {
      asset,
      score: normalizedScore,
      matchedFields,
    };
  }

  /**
   * Tokenize text into lowercase words.
   */
  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[\s\-_./]+/)
        .filter(token => token.length >= 2) // Skip very short tokens
    );
  }

  /**
   * Count how many tokens match.
   */
  private countMatches(tokens: Set<string> | string[], queryTokens: Set<string>): number {
    let count = 0;
    const tokenArray = tokens instanceof Set ? Array.from(tokens) : tokens;

    for (const token of tokenArray) {
      if (queryTokens.has(token)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Get all loaded assets (for debugging/testing).
   */
  getAllAssets(): Asset[] {
    return [...this.assets];
  }

  /**
   * Check if assets are loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Clear loaded assets (for testing).
   */
  clear(): void {
    this.assets = [];
    this.loaded = false;
    this.loadFailed = false;
  }
}

/**
 * Singleton instance for global asset store.
 */
let globalAssetStore: AssetStore | null = null;

/**
 * Get the global asset store instance.
 */
export function getAssetStore(): AssetStore {
  if (!globalAssetStore) {
    globalAssetStore = new AssetStore();
  }
  return globalAssetStore;
}

/**
 * Reset the global asset store (for testing).
 */
export function resetAssetStore(): void {
  globalAssetStore = null;
}
