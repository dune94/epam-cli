import { beforeEach, describe, expect, it, vi } from 'vitest';

const keytarStore = new Map<string, string>();
const fallbackFileStore = new Map<string, string>();

vi.mock('keytar', () => ({
  default: {
    async setPassword(service: string, account: string, password: string) {
      keytarStore.set(`${service}:${account}`, password);
    },
    async getPassword(service: string, account: string) {
      return keytarStore.get(`${service}:${account}`) ?? null;
    },
    async deletePassword(service: string, account: string) {
      keytarStore.delete(`${service}:${account}`);
      return true;
    },
    async findCredentials(service: string) {
      const prefix = `${service}:`;
      return Array.from(keytarStore.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, password]) => ({
          account: key.slice(prefix.length),
          password,
        }));
    },
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    async access(path: string) {
      if (!fallbackFileStore.has(path)) {
        throw new Error('ENOENT');
      }
    },
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const value = fallbackFileStore.get(path);
      if (value == null) {
        throw new Error('ENOENT');
      }
      return value;
    },
    async writeFile(path: string, content: string) {
      fallbackFileStore.set(path, content);
    },
    async unlink(path: string) {
      fallbackFileStore.delete(path);
    },
  },
}));

describe('ProviderCredentialStore', () => {
  beforeEach(() => {
    keytarStore.clear();
    fallbackFileStore.clear();
    vi.resetModules();
  });

  it('stores and loads manual provider credentials with metadata', async () => {
    const {
      saveProviderCredential,
      loadProviderCredential,
      resolveProviderSecret,
    } = await import('../../../src/auth/ProviderCredentialStore.js');

    await saveProviderCredential({
      provider: 'anthropic',
      type: 'api_key',
      source: 'manual_api_key',
      secret: 'sk-ant-test-1234',
      accountLabel: 'bradley_jerome@epam.com',
      workspaceLabel: 'EPAM',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    const credential = await loadProviderCredential('anthropic');
    expect(credential?.source).toBe('manual_api_key');
    expect(credential?.accountLabel).toBe('bradley_jerome@epam.com');
    expect(credential?.workspaceLabel).toBe('EPAM');
    expect(await resolveProviderSecret('anthropic')).toBe('sk-ant-test-1234');
  });

  it('falls back to legacy BYOK storage when no provider record exists', async () => {
    keytarStore.set('epam-cli-byok:openai', 'sk-openai-legacy');

    const { loadProviderCredential } = await import('../../../src/auth/ProviderCredentialStore.js');
    const credential = await loadProviderCredential('openai');

    expect(credential?.source).toBe('manual_api_key');
    expect(credential?.secret).toBe('sk-openai-legacy');
  });

  it('resolves best available credential source based on precedence', async () => {
    const {
      saveProviderCredential,
      resolveProviderSecret,
    } = await import('../../../src/auth/ProviderCredentialStore.js');

    await saveProviderCredential({
      provider: 'openai',
      type: 'api_key',
      source: 'manual_api_key',
      secret: 'sk-openai-manual',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    await saveProviderCredential({
      provider: 'openai',
      type: 'browser_session',
      source: 'provider_browser',
      secret: 'sk-openai-browser',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    expect(await resolveProviderSecret('openai')).toBe('sk-openai-browser');

    await saveProviderCredential({
      provider: 'openai',
      type: 'brokered_key',
      source: 'epam_brokered_local',
      secret: 'sk-openai-brokered',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    expect(await resolveProviderSecret('openai')).toBe('sk-openai-brokered');
  });

  it('rejects expired credentials', async () => {
    const {
      saveProviderCredential,
      resolveProviderSecret,
    } = await import('../../../src/auth/ProviderCredentialStore.js');

    await saveProviderCredential({
      provider: 'gemini',
      type: 'browser_session',
      source: 'provider_browser',
      secret: 'sk-gemini-expired',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    });

    expect(await resolveProviderSecret('gemini')).toBeNull();
  });

  it('falls back to encrypted file storage when keytar runtime calls fail', async () => {
    vi.doMock('keytar', () => ({
      default: {
        async setPassword() {
          throw new Error('dbus unavailable');
        },
        async getPassword() {
          throw new Error('dbus unavailable');
        },
        async deletePassword() {
          throw new Error('dbus unavailable');
        },
        async findCredentials() {
          throw new Error('dbus unavailable');
        },
      },
    }));

    const {
      saveProviderCredential,
      loadProviderCredential,
      listProviderCredentials,
      deleteProviderCredential,
    } = await import('../../../src/auth/ProviderCredentialStore.js');

    await saveProviderCredential({
      provider: 'anthropic',
      type: 'api_key',
      source: 'manual_api_key',
      secret: 'sk-ant-fallback-1234',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    expect((await loadProviderCredential('anthropic'))?.secret).toBe('sk-ant-fallback-1234');
    expect((await listProviderCredentials()).map(record => record.provider)).toContain('anthropic');

    await deleteProviderCredential('anthropic');
    expect(await loadProviderCredential('anthropic')).toBeNull();
  });
});
