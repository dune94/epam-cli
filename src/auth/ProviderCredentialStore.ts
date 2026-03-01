import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { SubscriptionTier } from '../billing/types.js';
import { getEpamGlobalDir } from '../utils/platform.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import type { ProviderName, ProviderCredentialSource, ProviderCredentialRecord, ProviderCredentialType } from './types.js';

export { ProviderName, ProviderCredentialSource, ProviderCredentialRecord };

const SERVICE_NAME = 'epam-cli-provider-credentials';
const LEGACY_BYOK_SERVICE = 'epam-cli-byok';
const FALLBACK_CREDENTIALS_PATH = path.join(getEpamGlobalDir(), '.provider-credentials');

async function getKeytar() {
  try {
    const keytar = await import('keytar');
    return keytar.default ?? keytar;
  } catch {
    return null;
  }
}

const memoryStore = new Map<string, string>();

function getMachineKey(): Buffer {
  const machineId = process.env.MACHINE_ID ?? `${process.env.USER ?? 'default'}@${require('os').hostname() as string}`;
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

function encode(record: ProviderCredentialRecord): string {
  return JSON.stringify(record);
}

function decode(raw: string): ProviderCredentialRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderCredentialRecord>;
    if (!parsed || typeof parsed.secret !== 'string' || typeof parsed.provider !== 'string') {
      return null;
    }
    
    let type: ProviderCredentialType = 'api_key';
    if (parsed.type) {
      type = parsed.type;
    } else {
      if (parsed.source === 'provider_browser') type = 'browser_session';
      else if (parsed.source === 'epam_brokered_local') type = 'brokered_key';
    }

    return {
      provider: parsed.provider as ProviderName,
      type,
      source: (parsed.source as ProviderCredentialSource) ?? 'manual_api_key',
      secret: parsed.secret,
      accountLabel: parsed.accountLabel,
      workspaceLabel: parsed.workspaceLabel,
      organizationLabel: parsed.organizationLabel,
      createdAt: parsed.createdAt ?? new Date(0).toISOString(),
      expiresAt: parsed.expiresAt,
      refreshable: parsed.refreshable,
    };
  } catch {
    return null;
  }
}

async function loadFallbackStore(): Promise<Record<string, string>> {
  if (!(await pathExists(FALLBACK_CREDENTIALS_PATH))) {
    return {};
  }

  try {
    const encrypted = await fs.readFile(FALLBACK_CREDENTIALS_PATH, 'utf-8');
    const decrypted = decrypt(encrypted);
    const parsed = JSON.parse(decrypted) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveFallbackStore(store: Record<string, string>): Promise<void> {
  await ensureDir(getEpamGlobalDir());
  const encrypted = encrypt(JSON.stringify(store));
  await fs.writeFile(FALLBACK_CREDENTIALS_PATH, encrypted, { mode: 0o600 });
}

async function loadLegacyApiKey(provider: string): Promise<ProviderCredentialRecord | null> {
  const keytar = await getKeytar();
  if (keytar) {
    try {
      const secret = await keytar.getPassword(LEGACY_BYOK_SERVICE, provider);
      if (secret) {
        return {
          provider: provider as ProviderName,
          type: 'api_key',
          source: 'manual_api_key',
          secret,
          createdAt: new Date(0).toISOString(),
        };
      }
    } catch {
      // Fall through to in-memory/file fallback.
    }
  }

  const secret = memoryStore.get(`legacy:${provider}`) ?? null;
  if (!secret) return null;
  return {
    provider: provider as ProviderName,
    type: 'api_key',
    source: 'manual_api_key',
    secret,
    createdAt: new Date(0).toISOString(),
  };
}

export async function saveProviderCredential(record: ProviderCredentialRecord): Promise<void> {
  const keytar = await getKeytar();
  const encoded = encode(record);
  const key = `${record.provider}:${record.source}`;
  
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, key, encoded);
      return;
    } catch {
      // Fall through to file fallback.
    }
  }

  memoryStore.set(key, encoded);
  const fallbackStore = await loadFallbackStore();
  fallbackStore[key] = encoded;
  await saveFallbackStore(fallbackStore);
}

export async function deleteProviderCredential(provider: string, source?: ProviderCredentialSource): Promise<void> {
  const keytar = await getKeytar();
  
  const sourcesToDelete = source ? [source] : ['manual_api_key', 'provider_browser', 'epam_brokered_local'];
  
  for (const s of sourcesToDelete) {
    const key = `${provider}:${s}`;
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE_NAME, key);
      } catch {
        // Fall through to file fallback cleanup.
      }
    }
    memoryStore.delete(key);
  }
  
  if (!source || source === 'manual_api_key') {
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE_NAME, provider); // legacy format
        await keytar.deletePassword(LEGACY_BYOK_SERVICE, provider);
      } catch {}
    }
    memoryStore.delete(provider);
    memoryStore.delete(`legacy:${provider}`);
  }

  const fallbackStore = await loadFallbackStore();
  for (const s of sourcesToDelete) {
    delete fallbackStore[`${provider}:${s}`];
  }
  if (!source || source === 'manual_api_key') {
    delete fallbackStore[provider];
    delete fallbackStore[`legacy:${provider}`];
  }
  await saveFallbackStore(fallbackStore);
}

export async function listProviderCredentials(): Promise<ProviderCredentialRecord[]> {
  const keytar = await getKeytar();
  const records: ProviderCredentialRecord[] = [];

  if (keytar) {
    try {
      const creds = await keytar.findCredentials(SERVICE_NAME);
      for (const cred of creds) {
        const record = decode(cred.password);
        if (record) records.push(record);
      }

      const legacy = await keytar.findCredentials(LEGACY_BYOK_SERVICE);
      for (const cred of legacy) {
        records.push({
          provider: cred.account as ProviderName,
          type: 'api_key',
          source: 'manual_api_key',
          secret: cred.password,
          createdAt: new Date(0).toISOString(),
        });
      }
    } catch {
      // Fall through to file fallback.
    }
  }

  const fallbackStore = {
    ...(await loadFallbackStore()),
    ...Object.fromEntries(memoryStore.entries()),
  };

  for (const [key, value] of Object.entries(fallbackStore)) {
    if (key.startsWith('legacy:')) {
      const provider = key.slice('legacy:'.length);
      records.push({
        provider: provider as ProviderName,
        type: 'api_key',
        source: 'manual_api_key',
        secret: value,
        createdAt: new Date(0).toISOString(),
      });
    } else {
      const record = decode(value);
      if (record) records.push(record);
    }
  }

  // Deduplicate by provider and source (preferring the first we found, which would be keytar)
  const unique = new Map<string, ProviderCredentialRecord>();
  for (const r of records) {
    const k = `${r.provider}:${r.source}`;
    if (!unique.has(k)) {
      unique.set(k, r);
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.provider.localeCompare(b.provider));
}

const SOURCE_PRIORITY: Record<ProviderCredentialSource, number> = {
  epam_brokered_local: 3,
  provider_browser: 2,
  manual_api_key: 1,
};

export async function resolveProviderCredential(provider: string): Promise<ProviderCredentialRecord | null> {
  const credentials = await listProviderCredentials();
  
  const now = new Date();
  const validForProvider = credentials.filter(c => {
    if (c.provider !== provider) return false;
    if (c.expiresAt && new Date(c.expiresAt) <= now) return false; // reject expired
    return true;
  });

  if (validForProvider.length === 0) return null;

  // Sort by priority (highest first)
  validForProvider.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]);

  return validForProvider[0];
}

export async function loadProviderCredential(provider: string): Promise<ProviderCredentialRecord | null> {
  return resolveProviderCredential(provider);
}

export async function resolveProviderSecret(provider: string): Promise<string | null> {
  const record = await resolveProviderCredential(provider);
  return record?.secret ?? null;
}
