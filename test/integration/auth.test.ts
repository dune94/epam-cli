import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Auth: DeviceFlow (mock fetch)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('startFlow sends correct request and parses response', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: 'dev-code-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.example.com/activate',
        expires_in: 300,
        interval: 5,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { DeviceFlow } = await import('../../src/auth/DeviceFlow.js');
    const flow = new DeviceFlow({
      backendUrl: 'https://auth.example.com',
      clientId: 'test-client',
      scope: 'openid',
    });

    const result = await flow.startFlow();
    expect(result.deviceCode).toBe('dev-code-123');
    expect(result.userCode).toBe('ABCD-1234');
    expect(result.interval).toBe(5);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/oauth/device/code',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('startFlow throws AuthError on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    }));

    const { DeviceFlow } = await import('../../src/auth/DeviceFlow.js');
    const flow = new DeviceFlow({
      backendUrl: 'https://auth.example.com',
      clientId: 'test-client',
      scope: 'openid',
    });

    await expect(flow.startFlow()).rejects.toThrow('Failed to start device flow');
  });
});
