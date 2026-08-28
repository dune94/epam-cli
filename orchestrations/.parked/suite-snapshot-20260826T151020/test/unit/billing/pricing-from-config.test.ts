/**
 * MODEL PRICES BELONG IN AN OBVIOUS CONFIG FILE, NOT BURIED IN TYPESCRIPT.
 *
 * They lived in src/billing/pricing.ts with this as the entire maintenance policy:
 *
 *   // Prices as of early 2026 — update as providers change
 *
 * So a price change meant editing TypeScript, rebuilding with tsup, and committing — and
 * nothing expired the table, warned that it was old, or reconciled it against a provider.
 * Whoever needs to update a price is the least likely person to be reading src/billing.
 * Hiding a value that changes outside our control is the risk, whether or not it is "data".
 *
 * It also had a concrete hole: kimi-k3 is the top rung of the HIGH ladder and was absent
 * from the table entirely, so nothing could price an escalation to it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_PRICING, getPricing, PRICING_AS_OF } from '../../../src/billing/pricing';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, so every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'
const REPO_ROOT_CFG = join(__dirname, '../../../orchestrations/config');

const REPO = join(__dirname, '../../../');
const CONFIG = join(REPO, 'orchestrations/config/model-pricing.json');

describe('prices come from a config file anyone can find', () => {
  it('the config file exists where configuration lives', () => {
    expect(
      existsSync(CONFIG),
      'a price that changes outside our control must be editable without touching ' +
        'TypeScript or running a build',
    ).toBe(true);
  });

  it('it declares when it was last checked, so staleness is visible', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.asOf, 'no asOf — nothing distinguishes current prices from two-year-old ones')
      .toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
    expect(PRICING_AS_OF).toBe(cfg.asOf);
  });

  it('the code reads that file rather than carrying its own copy', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const names = Object.keys(cfg.models);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      expect(MODEL_PRICING[n], `${n} is in the config but not exposed by the code`).toBeDefined();
      expect(MODEL_PRICING[n].inputPerMillion).toBe(cfg.models[n].inputPerMillion);
    }
  });

  it('editing the file changes the answer — no rebuild in the loop', () => {
    // Proven by construction: the table is read at runtime, so a value present in the file
    // is present in the export. A build-time import would fail the previous assertion only
    // by coincidence, so assert the source has no inline price table.
    const src = readFileSync(join(REPO, 'src/billing/pricing.ts'), 'utf8');
    expect(
      src,
      'an inline table means the config file is decoration and the real prices are still ' +
        'compiled in',
    ).not.toMatch(/inputPerMillion:\s*[0-9]/);
  });

  it('an unknown model returns null — never a silent zero', () => {
    expect(getPricing('no-such-model-xyz')).toBeNull();
  });
});

describe('every model the pipeline can actually use is priced', () => {
  it('no configured ladder rung is missing a price', () => {
    const settings = join(REPO_ROOT_CFG, `llm-defaults.${defaultStack()}.json`);
    if (!existsSync(settings)) return;
    const cfg = JSON.parse(readFileSync(settings, 'utf8'));
    // ladders: { high: { modelLadder: [ { from, to }, ... ] }, medium: {...} }
    const rungs = new Set<string>();
    for (const ladder of Object.values(cfg.ladders ?? {}) as Array<{ modelLadder?: Array<{ from: string; to: string }> }>) {
      for (const step of ladder.modelLadder ?? []) {
        if (step.from) rungs.add(step.from);
        if (step.to) rungs.add(step.to);
      }
    }
    // The rule is PRESENCE, not a number: a model the ladder can reach must appear in the
    // config, even if its price is explicitly null. A guessed price would be worse than a
    // visible gap — inventing plausible values is exactly how 8 fabricated acceptance
    // criteria ended up frozen into a PRD template.
    const cfgFile = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const absent = [...rungs].filter((m) => m && !(m in cfgFile.models));
    expect(
      absent,
      'a ladder can escalate to these models and the price config does not mention them at ' +
        'all — kimi-k3 was exactly this case',
    ).toEqual([]);

    // Report the known-unknowns so they are visible rather than silently zero.
    const unknown = [...rungs].filter((m) => m && cfgFile.models[m]?.inputPerMillion == null);
    if (unknown.length) {
      console.warn(`[pricing] ladder rungs with no checked price: ${unknown.join(', ')}`);
    }
  });
});
