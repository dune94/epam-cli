import { describe, it, expect } from 'vitest';
import { parseRange } from './range';

describe('parseRange', () => {
  it('returns empty array for invalid range', () => {
    expect(parseRange(5, 3)).toEqual([]);
  });

  it('ascending range is correctly ordered', () => {
    expect(parseRange(1, 3)).toEqual([1, 2, 3]);
  });

  it('includes end value in range', () => {
    expect(parseRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('single value range returns one element', () => {
    expect(parseRange(7, 7)).toEqual([7]);
  });
});
