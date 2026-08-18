import { describe, it, expect } from 'vitest';
import { getGreeting } from './hello';

describe('getGreeting', () => {
  it('returns hello world', () => {
    expect(getGreeting()).toBe('hello world');
  });
});
