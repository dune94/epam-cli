/**
 * RedisSessionStore
 *
 * Shared session storage via Redis for team context sharing.
 * Activated when EPAM_REDIS_URL is set (e.g. redis://localhost:6379).
 *
 * Key patterns:
 *   epam:session:<ulid>          — SessionBundle JSON (7-day TTL)
 *   epam:handoffs:<email>        — list of session IDs directed to a user
 *   epam:team:<name>:sessions    — list of session IDs shared with a team
 */

import Redis from 'ioredis';
import type { SessionBundle } from '../cli/repl/commands/ShareCommand.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

let _client: Redis | null = null;

export function getRedisClient(): Redis | null {
  const url = process.env.EPAM_REDIS_URL;
  if (!url) return null;

  if (!_client) {
    _client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
    });
    _client.on('error', () => {
      // Silently fail — Redis is optional; callers check for null
    });
  }
  return _client;
}

export function isRedisAvailable(): boolean {
  return Boolean(process.env.EPAM_REDIS_URL);
}

/** Store a session bundle. Returns the session ID (key suffix). */
export async function storeSession(bundle: SessionBundle, sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) throw new Error('Redis not configured (EPAM_REDIS_URL not set)');
  await redis.set(`epam:session:${sessionId}`, JSON.stringify(bundle), 'EX', SESSION_TTL_SECONDS);
}

/** Fetch a session bundle by ID. Returns null if not found or Redis unavailable. */
export async function fetchSession(sessionId: string): Promise<SessionBundle | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(`epam:session:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionBundle;
  } catch {
    return null;
  }
}

/** Record that a session was handed off to a specific user. */
export async function enqueueHandoff(recipientEmail: string, sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const key = `epam:handoffs:${recipientEmail}`;
  await redis.lpush(key, sessionId);
  await redis.expire(key, SESSION_TTL_SECONDS);
}

/** List session IDs handed off to a user (newest first). */
export async function listHandoffs(recipientEmail: string): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    return await redis.lrange(`epam:handoffs:${recipientEmail}`, 0, 19);
  } catch {
    return [];
  }
}

/** Record that a session was shared with a team. */
export async function enqueueTeamSession(teamName: string, sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const key = `epam:team:${teamName}:sessions`;
  await redis.lpush(key, sessionId);
  await redis.expire(key, SESSION_TTL_SECONDS);
}

/** List session IDs shared with a team (newest first). */
export async function listTeamSessions(teamName: string): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    return await redis.lrange(`epam:team:${teamName}:sessions`, 0, 19);
  } catch {
    return [];
  }
}

/** Returns metadata for a stored session without the full turn data. */
export async function getSessionMeta(
  sessionId: string
): Promise<{ exportedBy: string; exportedAt: string; teamNote?: string; model: string; provider: string; turnCount: number } | null> {
  const bundle = await fetchSession(sessionId);
  if (!bundle) return null;
  return {
    exportedBy: bundle.exportedBy,
    exportedAt: bundle.exportedAt,
    teamNote: bundle.teamNote,
    model: bundle.model,
    provider: bundle.provider,
    turnCount: bundle.turns.length,
  };
}

/** Detect if a string looks like a Redis session code (ULID — 26 uppercase alphanumeric chars). */
export function isSessionCode(arg: string): boolean {
  return /^[0-9A-Z]{26}$/.test(arg.trim().toUpperCase());
}
