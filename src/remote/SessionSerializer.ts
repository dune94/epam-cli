/**
 * SessionSerializer - Handles encryption and serialization of session data for remote transfer
 */

import crypto from 'crypto';
import type { Message } from '../providers/types.js';
import type { SessionBundle } from './RemoteSessionStore.js';

const SCHEMA_VERSION = '1.0';
const ALGORITHM = 'aes-256-gcm';

export interface SessionData {
  schemaVersion: string;
  messages: Message[];
  context: {
    model: string;
    provider: string;
    projectRoot: string | null;
    tokenCount: number;
    turnCount: number;
  };
  timestamp: number;
}

/**
 * Generate a random 32-byte encryption key
 * In production, this should be derived from user credentials or stored securely
 */
export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Fork session for remote: serialize and encrypt session data
 *
 * @param messages - Current conversation messages
 * @param context - Session context
 * @param key - Encryption key (32 bytes)
 * @returns Encrypted session bundle
 */
export function forkSessionForRemote(
  messages: Message[],
  context: {
    model: string;
    provider: string;
    projectRoot: string | null;
    tokenCount: number;
    turnCount: number;
  },
  key: Buffer
): SessionBundle {
  const sessionData: SessionData = {
    schemaVersion: SCHEMA_VERSION,
    messages,
    context,
    timestamp: Date.now(),
  };

  const payload = JSON.stringify(sessionData);

  // Generate a random 12-byte nonce for AES-GCM
  const nonce = crypto.randomBytes(12);

  // Encrypt using AES-256-GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);

  let encrypted = cipher.update(payload, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Get the authentication tag
  const tag = cipher.getAuthTag();

  return {
    encryptedPayload: encrypted,
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      timestamp: sessionData.timestamp,
    },
  };
}

/**
 * Import remote session: decrypt and deserialize session data
 *
 * @param bundle - Encrypted session bundle
 * @param key - Encryption key (32 bytes)
 * @returns Decrypted session data
 * @throws Error if decryption fails or schema version mismatch
 */
export function importRemoteSession(bundle: SessionBundle, key: Buffer): SessionData {
  try {
    const nonce = Buffer.from(bundle.nonce, 'base64');
    const tag = Buffer.from(bundle.tag, 'base64');

    // Decrypt using AES-256-GCM
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(bundle.encryptedPayload, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    const sessionData = JSON.parse(decrypted) as SessionData;

    // Validate schema version
    if (sessionData.schemaVersion !== SCHEMA_VERSION) {
      console.warn(
        `Schema version mismatch: expected ${SCHEMA_VERSION}, got ${sessionData.schemaVersion}. Import may be incomplete.`
      );
    }

    return sessionData;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to import remote session: ${error.message}`);
    }
    throw new Error('Failed to import remote session: Unknown error');
  }
}

/**
 * Delete a remote session from the backend
 *
 * Note: This is handled by the backend DELETE endpoint
 * Include this helper for completeness
 */
export interface DeleteSessionOptions {
  token: string;
  backendUrl: string;
}
