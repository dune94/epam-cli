import { describe, it, expect } from 'vitest';
import { getGreeting } from './hello';

describe('getGreeting', () => {
  it('returns a greeting', () => {
    expect(typeof getGreeting()).toBe('string');
    expect(getGreeting().length).toBeGreaterThan(0);
  });
});
