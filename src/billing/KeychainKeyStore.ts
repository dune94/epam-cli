import type { SubscriptionTier } from './types.js';

const SERVICE_NAME = 'epam-cli-byok';

async function getKeytar() {
  try {
    const keytar = await import('keytar');
    return keytar.default ?? keytar;
  } catch {
    return null;
  }
}

const memoryStore = new Map<string, string>();

export async function storeApiKey(provider: string, apiKey: string): Promise<void> {
  const keytar = await getKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, provider, apiKey);
    return;
  }
  // In-memory fallback (session-only)
  memoryStore.set(provider, apiKey);
}

export async function getApiKey(provider: string): Promise<string | null> {
  const keytar = await getKeytar();
  if (keytar) {
    return keytar.getPassword(SERVICE_NAME, provider);
  }
  return memoryStore.get(provider) ?? null;
}

export async function deleteApiKey(provider: string): Promise<void> {
  const keytar = await getKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE_NAME, provider);
  }
  memoryStore.delete(provider);
}

export async function listStoredProviders(): Promise<string[]> {
  const keytar = await getKeytar();
  if (keytar) {
    const creds = await keytar.findCredentials(SERVICE_NAME);
    return creds.map(c => c.account);
  }
  return Array.from(memoryStore.keys());
}
