import {
  deleteProviderCredential,
  listProviderCredentials,
  loadProviderCredential,
  saveProviderCredential,
} from '../auth/ProviderCredentialStore.js';

export async function storeApiKey(provider: string, apiKey: string): Promise<void> {
  await saveProviderCredential({
    provider: provider as 'anthropic' | 'openai' | 'gemini',
    type: 'api_key',
    source: 'manual_api_key',
    secret: apiKey,
    createdAt: new Date().toISOString(),
  });
}

export async function getApiKey(provider: string): Promise<string | null> {
  const credential = await loadProviderCredential(provider);
  return credential?.secret ?? null;
}

export async function deleteApiKey(provider: string): Promise<void> {
  await deleteProviderCredential(provider, 'manual_api_key');
}

export async function listStoredProviders(): Promise<string[]> {
  const credentials = await listProviderCredentials();
  return credentials.map(record => record.provider);
}
