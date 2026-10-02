/**
 * A SET OVERRIDES ONE INHERITED TIER AND KEEPS THE REST.
 *
 * Operator, 2026-10-01: the copilot set's ladders must be ideal for cost. Copilot bills per token at
 * each model's API rate (GitHub, June 2026), and the copilot set inherited the claude set's ladders —
 * tuned for a subscription, where a token has no per-model price. The copilot set now declares the
 * tiers it prices differently; a tier it does not declare is still the claude set's, so the two never
 * drift where they agree. Before this, a set's own `ladders` replaced the inherited object whole.
 *
 * EXECUTED: the real resolver (lib/llm-settings-resolve.js readSetFile) on the real set files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = join(__dirname, '../../../orchestrations/config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readSetFile } = require(join(__dirname, '../../../orchestrations/scripts/lib/llm-settings-resolve.js'));
const raw = (f: string) => JSON.parse(readFileSync(join(CONFIG, f), 'utf8'));
const tiers = (o: any) => Object.keys(o || {}).filter((k) => !k.startsWith('$'));

const copilotFile = raw('llm-defaults.copilot.json');
const baseFile = raw(copilotFile.inheritFrom.file);
const declared = tiers(copilotFile.ladders);
const resolved = readSetFile(join(CONFIG, 'llm-defaults.copilot.json'));

describe('a set overrides one inherited tier and keeps the rest', () => {
  it('the copilot set declares at least one tier of its own, and inherits at least one', () => {
    expect(declared.length, 'the copilot set declares no ladder tier — nothing is priced for Copilot').toBeGreaterThan(0);
    expect(tiers(baseFile.ladders).filter((t) => !declared.includes(t)).length, 'every tier is redeclared — the inheritance proves nothing').toBeGreaterThan(0);
  });

  it('a tier the copilot set declares is its own', () => {
    for (const t of declared) expect(resolved.ladders[t]).toEqual(copilotFile.ladders[t]);
  });

  it('a tier the copilot set does not declare is still the inherited one', () => {
    for (const t of tiers(baseFile.ladders).filter((x) => !declared.includes(x))) expect(resolved.ladders[t]).toEqual(baseFile.ladders[t]);
  });

  it('the set it inherits from is unchanged', () => {
    expect(readSetFile(join(CONFIG, copilotFile.inheritFrom.file)).ladders).toEqual(baseFile.ladders);
  });

  it('every declared tier still climbs: each step starts where the last one ended', () => {
    for (const t of declared) {
      const l = resolved.ladders[t];
      expect(l.modelLadder[0].from).toBe(l.startModel);
      for (let i = 1; i < l.modelLadder.length; i += 1) expect(l.modelLadder[i].from).toBe(l.modelLadder[i - 1].to);
      expect(l.rungs.length).toBe(l.modelLadder.length + 1);
    }
  });
});
