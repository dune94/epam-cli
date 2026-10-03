import { describe, it, expect } from 'vitest';
import { renderNotice } from './notice.js';

describe('notice', () => {
  it('renders the message', () => {
    expect(renderNotice('Saved')).toContain('Saved');
  });
});
