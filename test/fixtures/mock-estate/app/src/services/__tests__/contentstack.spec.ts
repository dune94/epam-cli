import { describe, it, expect } from 'vitest';
import { Stack } from '../contentstack';

describe('Stack configuration', () => {
  it('is created for the configured environment', () => {
    expect(Stack).toBeTruthy();
  });
});
