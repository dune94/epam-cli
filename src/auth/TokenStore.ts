import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { getEpamGlobalDir } from '../utils/platform.js';
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { AuthError } from '../utils/errors.js';
import type { TokenSet } from './types.js';

const SERVICE_NAME = 'epam-cli';
const ACCOUNT_NAME = 'default';
const FALLBACK_CREDENTIALS_PATH = path.join(getEpamGlobalDir(), '.credentials');

// AES-256-GCM encryption key derived from machine-id
function getMachineKey(): Buffer {
  // Use a stable machine-specific value
  const machineId = process.env.MACHINE_ID ?? (require('os').hostname() as string) + (process.env.USER ?? 'default');
  return crypto.createHash('sha256').update(machineId).digest();
}

function encrypt(data: string): string {
  const key = getMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    encrypted: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  });
}

function decrypt(payload: string): string {
  const key = getMachineKey();
  const { iv, encrypted, tag } = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

async function tryKeytar(): Promise<typeof import('keytar') | null> {
  try {
    const keytar = await import('keytar');
    return keytar.default ?? keytar;
  } catch {
    return null;
  }
}

export async function saveTokenSet(tokenSet: TokenSet): Promise<void> {
  const data = JSON.stringify(tokenSet);

  const keytar = await tryKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, data);
      return;
    } catch {
      // Fall through to file storage
    }
  }

  // File fallback
  try {
    await ensureDir(getEpamGlobalDir());
    const encrypted = encrypt(data);
    await fs.writeFile(FALLBACK_CREDENTIALS_PATH, encrypted, { mode: 0o600 });
  } catch (err) {
    throw new AuthError(`Failed to save credentials: ${(err as Error).message}`, err as Error);
  }
}

export async function loadTokenSet(): Promise<TokenSet | null> {
  const keytar = await tryKeytar();
  if (keytar) {
    try {
      const data = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
      if (data) return JSON.parse(data) as TokenSet;
    } catch {
      // Fall through to file
    }
  }

  // File fallback
  if (!(await pathExists(FALLBACK_CREDENTIALS_PATH))) return null;
  try {
    const encrypted = await fs.readFile(FALLBACK_CREDENTIALS_PATH, 'utf-8');
    const data = decrypt(encrypted);
    return JSON.parse(data) as TokenSet;
  } catch {
    return null;
  }
}

export async function deleteTokenSet(): Promise<void> {
  const keytar = await tryKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    } catch {
      // Ignore
    }
  }

  // Also remove file
  try {
    if (await pathExists(FALLBACK_CREDENTIALS_PATH)) {
      await fs.unlink(FALLBACK_CREDENTIALS_PATH);
    }
  } catch {
    // Ignore
  }
}
