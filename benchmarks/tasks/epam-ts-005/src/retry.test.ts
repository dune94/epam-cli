import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from './retry';

describe('fetchWithRetry', () => {
  it('succeeds on first attempt without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(fetchWithRetry(fn, 3)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(fetchWithRetry(fn, 2)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('resets attempt count for each invocation', async () => {
    // First call: exhaust retries
    const failing = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(fetchWithRetry(failing, 1)).rejects.toThrow();

    // Second call: should get a fresh attempt budget
    const succeeding = vi.fn().mockResolvedValue('fresh');
    await expect(fetchWithRetry(succeeding, 1)).resolves.toBe('fresh');
  });

  it('second call gets full retry budget', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('x'));
    await expect(fetchWithRetry(failing, 1)).rejects.toThrow();

    // Should call fn 3 times (1 + 2 retries), not 0 times
    const fn2 = vi.fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('ok');
    await expect(fetchWithRetry(fn2, 2)).resolves.toBe('ok');
    expect(fn2).toHaveBeenCalledTimes(2);
  });
});
