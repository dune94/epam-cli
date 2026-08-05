import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
export interface ModelPricing {
  inputPerMillion: number;  // USD per 1M input tokens
  outputPerMillion: number; // USD per 1M output tokens
}

/**
 * Prices are CONFIGURATION, not code: orchestrations/config/model-pricing.json.
 *
 * They lived here as a literal table whose entire maintenance policy was the comment
 * "Prices as of early 2026 — update as providers change". Changing a price meant editing
 * TypeScript and rebuilding, nothing expired the table, and whoever needs to update a price
 * is the least likely person to be reading src/billing. A value that changes outside our
 * control, hidden where nobody looks, is stale by default and silently so.
 *
 * Read at runtime and cached, so an edit takes effect without a build.
 */
const PRICING_CONFIG_REL = 'orchestrations/config/model-pricing.json';

function findPricingConfig(): string | null {
  // Walk up from this module to the package root — the same derivation used for the engine
  // perimeter, so it holds for src/ and for the bundled dist/.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, PRICING_CONFIG_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface PricingFile {
  asOf?: string;
  models?: Record<string, ModelPricing>;
}

const _loaded: PricingFile = (() => {
  const file = findPricingConfig();
  if (!file) {
    // Never invent prices. An empty table makes getPricing return null, which callers
    // already handle as "unknown" — a wrong number would be worse than no number.
    process.emitWarning?.(
      `[pricing] ${PRICING_CONFIG_REL} not found — model prices unavailable. Cost display will be empty.`,
    );
    return {};
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PricingFile;
  } catch (e) {
    process.emitWarning?.(`[pricing] ${file} is unreadable: ${(e as Error).message}`);
    return {};
  }
})();

/** When these prices were last checked against the providers. */
export const PRICING_AS_OF: string = _loaded.asOf ?? 'unknown';

export const MODEL_PRICING: Record<string, ModelPricing> = _loaded.models ?? {};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens  / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.0000';
  if (usd < 0.0001) return `<$0.0001`;
  return `$${usd.toFixed(4)}`;
}

export function getPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? null;
}
