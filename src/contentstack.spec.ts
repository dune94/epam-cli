import { describe, it, expect } from 'vitest';
import { options } from './contentstack';
describe('live preview', () => {
  it('configures live_preview', () => {
    expect(options.live_preview).toEqual({ enable: true, host: expect.any(String) });
  });
});
