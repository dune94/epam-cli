// ── Langfuse Tracer — singleton wrapper for LLM observability ───────────────
//
// Initializes the Langfuse client from env vars or config, and provides
// trace/generation helpers consumed by TracedProvider.
//
// Env vars:
//   LANGFUSE_SECRET_KEY   — required for tracing to activate
//   LANGFUSE_PUBLIC_KEY   — required for tracing to activate
//   LANGFUSE_BASE_URL     — defaults to http://localhost:3100 (self-hosted)
//   LANGFUSE_ENABLED      — set to "0" or "false" to disable

import { Langfuse } from 'langfuse';
import { logger } from '../utils/logger.js';

let _instance: Langfuse | null = null;
let _enabled: boolean | null = null;

/**
 * Check whether Langfuse tracing is configured and enabled.
 */
export function isLangfuseEnabled(): boolean {
  if (_enabled !== null) return _enabled;

  const explicitDisable = process.env.LANGFUSE_ENABLED;
  if (explicitDisable === '0' || explicitDisable === 'false') {
    _enabled = false;
    return false;
  }

  const hasKeys = !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
  _enabled = hasKeys;
  return hasKeys;
}

/**
 * Get or create the Langfuse client singleton.
 * Returns null if tracing is not configured.
 */
export function getLangfuse(): Langfuse | null {
  if (!isLangfuseEnabled()) return null;

  if (!_instance) {
    _instance = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY!,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3100',
      release: process.env.npm_package_version,
    });

    logger.debug('Langfuse tracing initialized');
  }

  return _instance;
}

/**
 * Flush all pending Langfuse events. Call before process exit.
 */
export async function flushLangfuse(): Promise<void> {
  if (_instance) {
    try {
      await _instance.flushAsync();
    } catch (err) {
      logger.debug({ err }, 'Langfuse flush failed (non-fatal)');
    }
  }
}

/**
 * Shutdown Langfuse client. Call on process exit.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_instance) {
    try {
      await _instance.shutdownAsync();
    } catch {
      // ignore
    }
    _instance = null;
    _enabled = null;
  }
}
