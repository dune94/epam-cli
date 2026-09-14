import { describe, it, expect } from 'vitest';
import { getGreeting } from './hello';

describe('getGreeting', () => {
  it('returns hello dolly', () => {
    expect(getGreeting()).toBe('hello dolly');
  });
});
