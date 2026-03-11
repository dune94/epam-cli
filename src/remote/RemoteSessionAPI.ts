import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { RemoteSessionStore, SessionBundle } from './RemoteSessionStore.js';

const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Rate limiter state per user
 */
interface RateLimitState {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitState>();

/**
 * Middleware: Rate limiting (5 requests per minute per authenticated user)
 */
export function createRateLimiter(limitPerMinute: number = 5): RequestHandler {
  return (req: Request & { user?: { sub: string } }, res: Response, next: NextFunction) => {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const state = rateLimitMap.get(userId);

    if (!state || now > state.resetAt) {
      // New window
      rateLimitMap.set(userId, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (state.count >= limitPerMinute) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil((state.resetAt - now) / 1000),
      });
    }

    state.count++;
    next();
  };
}

/**
 * Middleware: Validate request body size
 */
export function validatePayloadSize(req: Request, res: Response, next: NextFunction): void {
  const contentLength = parseInt(req.get('content-length') || '0', 10);

  if (contentLength > MAX_PAYLOAD_SIZE) {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', maxSize: MAX_PAYLOAD_SIZE });
    return;
  }

  next();
}

/**
 * Validate session bundle schema
 */
function validateBundleSchema(bundle: unknown): { valid: boolean; errors?: string[] } {
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle must be an object'] };
  }

  const b = bundle as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.encryptedPayload !== 'string' || !b.encryptedPayload) {
    errors.push('Missing or invalid field: encryptedPayload');
  }
  if (typeof b.nonce !== 'string' || !b.nonce) {
    errors.push('Missing or invalid field: nonce');
  }
  if (typeof b.tag !== 'string' || !b.tag) {
    errors.push('Missing or invalid field: tag');
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Create remote session API routes
 */
export function createRemoteSessionRoutes(store: RemoteSessionStore) {
  /**
   * POST /v1/remote/sessions
   * Store a new session bundle and return claim token
   */
  const createSession: RequestHandler = async (req, res) => {
    try {
      const bundle = req.body as SessionBundle;

      // Validate bundle schema
      const validation = validateBundleSchema(bundle);
      if (!validation.valid) {
        return res.status(422).json({
          error: 'INVALID_BUNDLE_SCHEMA',
          details: validation.errors,
        });
      }

      const result = await store.storeSession(bundle);
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'STORAGE_UNAVAILABLE') {
        return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
      }
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  };

  /**
   * GET /v1/remote/sessions/:token
   * Claim a session (single-use, atomically deletes)
   */
  const claimSession: RequestHandler = async (req, res) => {
    try {
      const { token } = req.params;

      const bundle = await store.claimSession(token);

      if (bundle === null) {
        // Token was already claimed or never existed
        return res.status(410).json({ error: 'TOKEN_ALREADY_CLAIMED' });
      }

      res.status(200).json(bundle);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'INVALID_TOKEN_FORMAT') {
          return res.status(400).json({ error: 'INVALID_TOKEN_FORMAT' });
        }
        if (error.message === 'STORAGE_UNAVAILABLE') {
          return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
        }
      }
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  };

  /**
   * POST /v1/remote/sessions/:token/return
   * Store an updated session bundle for return (idempotent)
   */
  const returnSession: RequestHandler = async (req, res) => {
    try {
      const { token } = req.params;
      const bundle = req.body as SessionBundle;

      // Validate bundle schema
      const validation = validateBundleSchema(bundle);
      if (!validation.valid) {
        return res.status(422).json({
          error: 'INVALID_BUNDLE_SCHEMA',
          details: validation.errors,
        });
      }

      const result = await store.storeReturn(token, bundle);
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'INVALID_TOKEN_FORMAT') {
          return res.status(400).json({ error: 'INVALID_TOKEN_FORMAT' });
        }
        if (error.message === 'STORAGE_UNAVAILABLE') {
          return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
        }
      }
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  };

  /**
   * GET /v1/remote/sessions/:token/return
   * Reclaim the updated session bundle (single-use, atomically deletes)
   */
  const reclaimSession: RequestHandler = async (req, res) => {
    try {
      const { token } = req.params;

      const bundle = await store.reclaimReturn(token);

      if (bundle === null) {
        return res.status(404).json({ error: 'RETURN_NOT_FOUND' });
      }

      res.status(200).json(bundle);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'INVALID_TOKEN_FORMAT') {
          return res.status(400).json({ error: 'INVALID_TOKEN_FORMAT' });
        }
        if (error.message === 'STORAGE_UNAVAILABLE') {
          return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
        }
      }
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  };

  return {
    createSession,
    claimSession,
    returnSession,
    reclaimSession,
  };
}
