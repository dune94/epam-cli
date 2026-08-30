/**
 * RETEST OF bb801cf, c12e667 AND d7789ee — three cost fixes, none shipped with a test.
 *
 * Cost tracking is the operator's stated priority #1, and every one of these failures is silent:
 * the number is present, plausible, and wrong.
 *
 *   bb801cf — parseCostRecord read cache_read_input_tokens and never
 *             cache_creation_input_tokens, so the ledger could not see creation at all. Every row
 *             of one run recorded 0 while a "say ok" probe against the same runner reported
 *             cache_creation_input_tokens: 16827 — creation dwarfing a nine-token prompt. Reads
 *             and creations are priced differently, so one number that mixes them cannot be
 *             priced correctly.
 *
 *   c12e667 — the extraction landed and buildCostSnapshot still wrote cache_create_tokens: 0.
 *             Half a fix reads exactly like a whole one in a ledger.
 *
 *   d7789ee — codeline-discovery emitted its own row AND called the hub, so one call wrote two
 *             rows. A naive sum over the ledger then overstates the bill.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cost = require('../../orchestrations/scripts/lib/cost-emitter.js');

/** A provider result in the shape the runner really writes, with both cache figures present. */
const RESULT = {
  cost_usd: 0.0123,
  usage: {
    input_tokens: 9,
    output_tokens: 4,
    cache_read_input_tokens: 512,
    cache_creation_input_tokens: 16827,
  },
};

describe('the ledger records what was billed', () => {
  it('parseCostRecord reads cache CREATION, not only cache reads', () => {
    // bb801cf. Creation and reads carry different prices; a ledger blind to creation cannot price
    // the call at all.
    const parsed = cost.parseCostRecord(JSON.stringify(RESULT));
    expect(parsed, 'a well-formed result did not parse').toBeTruthy();
    expect(parsed.tokensCached, 'cache reads were lost').toBe(512);
    expect(parsed.tokensCacheCreate, 'cache CREATION was not read — the defect in bb801cf')
      .toBe(16827);
  });

  it('buildCostSnapshot carries the creation figure through to the row', () => {
    // c12e667. The extraction can be correct and the row still write a hardcoded 0 — which is why
    // this asserts the ROW, not the parse.
    const parsed = cost.parseCostRecord(JSON.stringify(RESULT));
    const snap = cost.buildCostSnapshot({
      agent: 'some-agent', storyId: 'S-1', phase: 'core',
      model: 'a-model', provider: 'a-provider', cost: parsed, turns: 1,
    });
    expect(snap, 'no snapshot was built').toBeTruthy();
    // READ FROM THE ROW AS IT IS REALLY SHAPED. I guessed three field names before looking; the
    // figures live under `detail`, and asserting a name that does not exist would have failed for
    // the wrong reason — or worse, passed against `undefined` if I had used a loose matcher.
    const created = snap.detail?.tokensCacheCreate;
    expect(created, 'the row still writes zero creation tokens — present, plausible, and wrong')
      .toBe(16827);
  });

  it('a zero creation figure is only ever a real zero', () => {
    // The negative: absent must not silently read as 16827 either. A result that genuinely had no
    // cache creation must record none.
    const noCache = cost.parseCostRecord(JSON.stringify({
      cost_usd: 0.001, usage: { input_tokens: 9, output_tokens: 4 },
    }));
    expect(noCache.tokensCacheCreate).toBe(0);
  });

  it('codeline-discovery declares that it records its own cost, so the hub does not double it',
    () => {
      // d7789ee. One call must not write two ledger rows: a naive sum then overstates the bill,
      // which is exactly how one run reported $2.57 against $1.29 actually billed.
      const src = readFileSync(
        join(__dirname, '../../orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');
      expect(src, 'discovery does not declare it records its own cost, so the hub writes a second row')
        .toContain('EPAM_COST_RECORDED_BY_CALLER');
    });
});
