import { describe, it, expect, vi } from 'vitest';
import { memoize } from './cache';

describe('memoize', () => {
  it('cache miss returns undefined (fn called)', () => {
    const fn = vi.fn((x: number) => x * 2);
    const memo = memoize(fn);
    expect(memo(5)).toBe(10);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('primitive keys are stored correctly', () => {
    const fn = vi.fn((x: number) => x + 1);
    const memo = memoize(fn);
    memo(3);
    memo(3);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('cache hit returns previously stored value', () => {
    const fn = vi.fn((x: { v: number }) => x.v * 10);
    const memo = memoize(fn);
    const arg = { v: 7 };
    expect(memo(arg)).toBe(70);
    expect(memo(arg)).toBe(70);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('distinct objects get distinct cache entries', () => {
    const fn = vi.fn((x: { v: number }) => x.v);
    const memo = memoize(fn);
    expect(memo({ v: 1 })).toBe(1);
    expect(memo({ v: 2 })).toBe(2);
    // Both objects must have been computed (no collision)
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
