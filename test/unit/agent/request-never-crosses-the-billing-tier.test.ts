/**
 * A REQUEST MUST NOT SILENTLY CROSS A PRICING TIER.
 *
 * MiniMax-M3 bills per REQUEST, not per attempt: input up to 512K tokens is charged at the
 * standard base rate, and above 512K (to a 1M ceiling) at DOUBLED rates. Crossing it is invisible
 * — the request succeeds, returns normally, and costs twice as much per token from that turn on.
 *
 * Measured 2026-08-10 on the killed run: max single request 126,942 tokens, 24.2% of the cap, zero
 * requests over. So this has never fired. It is a guard against a cliff we are approaching, not a
 * fix for damage already done, and the honest reason to add it now is that the thing which used to
 * bound history — compaction — is currently producing ZERO compactions across 1,154 turns, so the
 * only ceiling on a request today is the iteration budget.
 *
 * THE TIER IS A VENDOR FACT, SO IT IS CONFIGURATION. Nothing here hardcodes 512K, a model name, or
 * a vendor. A model with no declared tier is UNCAPPED rather than capped at some invented number:
 * inventing a limit for a model whose pricing we do not know is the same error as inventing a
 * verification command for a stack we do not recognise.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// From src, like every other pricing test: tsup bundles to a single dist/epam.js, so a
// dist/billing/pricing.js path does not exist and the whole file failed to load.
import { standardTierMaxInputTokens } from '../../../src/billing/pricing.js';

const ROOT = join(__dirname, '../../../');
const PRICING = join(ROOT, 'orchestrations/config/model-pricing.json');

describe('the tier boundary is declared as configuration', () => {
  it('the pricing config can express a standard-tier input ceiling', () => {
    const cfg = JSON.parse(readFileSync(PRICING, 'utf8'));
    const m = cfg.models['MiniMax-M3'];
    expect(m, 'MiniMax-M3 is missing from the pricing config').toBeTruthy();
    expect(
      m.standardTierMaxInputTokens,
      'the tier ceiling is not declared, so nothing can enforce it without hardcoding a vendor ' +
      'number in code',
    ).toBe(524288);
  });

  it('the ceiling is readable through the pricing accessor', () => {
    expect(standardTierMaxInputTokens('MiniMax-M3')).toBe(524288);
  });

  it('a model with no declared tier is UNCAPPED, not capped at a guess', () => {
    // An invented ceiling would truncate or force-compact a model whose real limit is higher.
    expect(standardTierMaxInputTokens('some-model-we-have-never-priced')).toBeNull();
  });

  it('every model that declares a ceiling declares a positive integer', () => {
    const cfg = JSON.parse(readFileSync(PRICING, 'utf8'));
    for (const [name, m] of Object.entries<Record<string, unknown>>(cfg.models)) {
      const v = m.standardTierMaxInputTokens;
      if (v === undefined || v === null) continue;
      expect(Number.isInteger(v) && (v as number) > 0, `${name} declares a bad ceiling: ${v}`).toBe(true);
    }
  });
});

/*
 * DEFERRED PAST THE 2026-08-10 MEASUREMENT RUN — see the note in AgentRunner's compaction block.
 *
 * The vendor fact and the accessor above ARE implemented and asserted. Only the wiring is held
 * back, because the guard belongs in the same block whose reconfiguration took caching 0% -> 96%
 * and produced zero compactions, and adding a trigger there would confound a run whose purpose is
 * to measure a read-dedupe delta. Marked skipped rather than deleted so the contract stays
 * written: `describe.skip` is a deferral on the record, a deleted test is a decision nobody can
 * see. Un-skip when implementing.
 */
describe.skip('the guard is wired into the request path', () => {
  const src = readFileSync(join(ROOT, 'src/agent/AgentRunner.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

  it('the runner consults the ceiling before dispatching', () => {
    expect(
      code,
      'nothing reads the tier ceiling in the request path, so a request can cross it silently',
    ).toContain('standardTierMaxInputTokens');
  });

  it('crossing the ceiling forces compaction rather than being logged and ignored', () => {
    // The failure mode this repo keeps producing: a limit that is read, logged, and never applied
    // (the coverage gate, the prompt trim, toolPolicy.readDedupe). A ceiling must change behaviour.
    expect(code).toMatch(/tierCeiling|overTier|tierTriggerHit/);
  });

  it('the ceiling does not silently replace the normal compaction trigger', () => {
    // It is an ADDITIONAL hard stop; the cache-preserving autoCompressAt behaviour stays.
    expect(code).toContain('autoCompressAt');
  });
});
