import { z } from 'zod';

/**
 * Asset schema for RAG Asset Discovery POC.
 * Assets are reusable enterprise resources (libraries, services, patterns)
 * that can be discovered via keyword matching.
 */
export const AssetSchema = z.object({
  /** Unique asset identifier */
  id: z.string(),
  /** Human-readable title */
  title: z.string(),
  /** Description of what the asset does */
  description: z.string(),
  /** Keywords/tags for search */
  tags: z.array(z.string()),
  /** URL to repository or documentation */
  repoUrl: z.string(),
  /** Optional: category for grouping */
  category: z.string().optional(),
  /** Optional: ownership team */
  owner: z.string().optional(),
  /** Optional: maturity level */
  maturity: z.enum(['experimental', 'stable', 'deprecated']).optional(),
});

export type Asset = z.infer<typeof AssetSchema>;

/**
 * Matched asset with search score.
 */
export interface AssetMatch {
  /** The matched asset */
  asset: Asset;
  /** Search score (higher = better match) */
  score: number;
  /** Which fields matched */
  matchedFields: Array<'title' | 'description' | 'tags'>;
}

/**
 * Asset search result.
 */
export interface AssetSearchResult {
  /** Top matching assets (up to 3) */
  matches: AssetMatch[];
  /** Whether any matches exceeded the threshold */
  hasMatches: boolean;
  /** Highest score found */
  topScore: number;
}

/**
 * Configuration for asset search.
 */
export interface AssetSearchConfig {
  /** Minimum score threshold (0.0 - 1.0) */
  threshold: number;
  /** Maximum number of matches to return */
  maxMatches: number;
  /** Whether to include category in search */
  searchCategory: boolean;
}

/**
 * Default search configuration.
 */
export const DEFAULT_ASSET_SEARCH_CONFIG: AssetSearchConfig = {
  threshold: 0.1,
  maxMatches: 3,
  searchCategory: false,
};
