import { describe, it, expect } from 'vitest';
import { closeLabel } from './toast.js';

describe('toast', () => {
  it('names the close control', () => {
    expect(typeof closeLabel()).toBe('string');
  });
});
