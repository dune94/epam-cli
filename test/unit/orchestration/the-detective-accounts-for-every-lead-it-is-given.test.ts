/**
 * THE DETECTIVE ACCOUNTS FOR EVERY LEAD IT IS GIVEN.
 *
 * AMSD-2974, 2026-10-04: the gotransit detective received the estimation assessment naming GO's
 * stand-alone toasts (cart unavailable-products, trip-search) and dropped them without a word — the
 * spec's only work was a version bump. Operator-approved: the detective's framing of the assessment asks
 * it to return, for every in-scope location named, a fix site it confirmed (changeRequired true) or a
 * refutation with its evidence (changeRequired false) — in the detective's existing contract. Prompt
 * text only; the detective still judges. EXECUTED: the real renderer, as the detective's prompt gets it.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(ORCH, 'scripts/lib/engine-prompt.js'));

describe('the detective accounts for every lead it is given', () => {
  const block = renderEngineTemplate('estimation-assessment', { __TICKET__: 'T-1', __ASSESSMENT__: 'Stand-alone toast in src/cart/Cart.tsx' }, 'code-graph-detective');
  it('the assessment reaches it', () => { expect(block).toContain('Stand-alone toast in src/cart/Cart.tsx'); });
  it('every in-scope location named must come back accounted for — confirmed or refuted, never dropped', () => {
    expect(block).toMatch(/every (in-scope )?location/i);
    expect(block).toMatch(/changeRequired[^.]*true/);
    expect(block).toMatch(/changeRequired[^.]*false/);
    expect(block).toMatch(/evidence/i);
    expect(block).toMatch(/never (silently )?(drop|omit)/i);
  });
  it('no other consumer\'s framing changed', () => {
    const writer = renderEngineTemplate('estimation-assessment', { __TICKET__: 'T-1', __ASSESSMENT__: 'x' }, 'story-writer');
    expect(writer).not.toMatch(/changeRequired/);
  });
});
