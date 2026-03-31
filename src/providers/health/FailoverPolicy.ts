import type { FailoverAnalysis } from './types.js';

// Errors that mean "this provider can't handle it right now — try next"
const FAILOVER_STATUS_CODES = new Set([429, 503, 529, 502, 504]);

// Errors that are the caller's fault — no point trying another provider
const FATAL_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

// Network-level error codes that warrant a retry then failover
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function analyzeError(err: unknown): FailoverAnalysis {
  if (err instanceof Error) {
    // Check for HTTP status embedded in error (ProviderError pattern)
    const statusCode = (err as Error & { statusCode?: number; status?: number }).statusCode
      ?? (err as Error & { status?: number }).status;

    if (statusCode != null) {
      if (FATAL_STATUS_CODES.has(statusCode)) {
        return { decision: 'fatal', reason: `HTTP ${statusCode}: ${err.message}`, statusCode };
      }
      if (FAILOVER_STATUS_CODES.has(statusCode)) {
        return { decision: 'failover', reason: `HTTP ${statusCode}: rate limit or overload`, statusCode };
      }
      if (statusCode >= 500) {
        // Other 5xx: retry once, then failover (handled at ProviderChain level)
        return { decision: 'retry_same', reason: `HTTP ${statusCode}: server error`, statusCode };
      }
    }

    // Network errors - should failover to next provider
    const code = (err as Error & { code?: string }).code;
    if (code && NETWORK_ERROR_CODES.has(code)) {
      return { decision: 'failover', reason: `Network error: ${code}` };
    }
    
    // "fetch failed" or "TypeError: fetch failed" - network issue, failover
    // BUT first check if there's a detailed API error message
    if (err.message.includes('fetch failed')) {
      // Check for embedded API error details
      if (err.message.includes('credit balance')) {
        return { decision: 'fatal', reason: 'API error: Credit balance too low' };
      }
      if (err.message.includes('rate limit')) {
        return { decision: 'failover', reason: 'API error: Rate limit exceeded' };
      }
      if (err.message.includes('Invalid API key') || err.message.includes('authentication')) {
        return { decision: 'fatal', reason: 'API error: Authentication failed' };
      }
      return { decision: 'failover', reason: 'Network error: fetch failed' };
    }

    // Timeout by name convention
    if (err.name === 'AbortError' || err.message.toLowerCase().includes('timeout')) {
      return { decision: 'retry_same', reason: 'Request timeout' };
    }

    // Context window exhausted signal (thrown by AgentRunner when stopReason === 'max_tokens')
    if (err.message.includes('max_tokens')) {
      return { decision: 'failover', reason: 'Context window exhausted' };
    }
  }

  // Unknown errors: failover to be safe
  return { decision: 'failover', reason: `Unexpected error: ${String(err)}` };
}

export function cooldownForDecision(statusCode?: number): number {
  if (statusCode === 429) return 5 * 60 * 1000;  // 5 min for rate limits
  if (statusCode != null && statusCode >= 500) return 2 * 60 * 1000; // 2 min for server errors
  return 3 * 60 * 1000; // 3 min default
}
