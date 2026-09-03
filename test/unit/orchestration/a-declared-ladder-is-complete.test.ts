/**
 * A LADDER DECLARATION IS COMPLETE OR IT IS A TRAP.
 *
 * skyscanner declared chains for medium and high, no `highest` at all, and no `startModel`
 * for any tier. Nothing failed: the chains were honoured, the missing tier fell through, and
 * the missing start was simply unset. model-ladders.sh records what that costs — on
 * 2026-08-14 an unset start meant seam_ladder_export set no EPAM_MODEL, repro-test-writer
 * refused with "no model resolved for this seam", and the run could not converge.
 *
 * A start is DECLARED, never inferred: these chains have several independent roots
 * (MiniMax, zhipuai, z-ai, moonshotai), so "the first hop's from" picks whichever root the
 * JSON happened to list first.
 *
 * Partial declarations are the failure mode. This asserts completeness, not content.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const PROJECTS = join(__dirname, '../../../orchestrations/projects');

// RESOLVED, not raw. Projects no longer declare ladders — the active set does, and they
// inherit. What must be complete is what a project RUNS WITH, whichever layer supplied it.
const { resolveLlmSettings } = require('../../../orchestrations/scripts/lib/llm-settings-resolve.js');
const withLadders = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, json: resolveLlmSettings({ projectConfigDir: join(PROJECTS, d.name) }) }))
  .filter((p) => p.json.ladders && Object.keys(p.json.ladders).length > 0);

describe('a declared ladder is complete', () => {
  it('finds projects declaring ladders, so this suite cannot pass vacuously', () => {
    expect(withLadders.length).toBeGreaterThan(0);
    expect(withLadders.map((p) => p.name)).toContain('skyscanner');
  });

  for (const p of withLadders) {
    it(`${p.name}: every declared tier has a startModel`, () => {
      const missing = Object.entries(p.json.ladders)
        .filter(([, v]: [string, any]) => !v.startModel)
        .map(([t]) => t);
      expect(missing, `${p.name} tiers without a startModel`).toEqual([]);
    });

    it(`${p.name}: declares a ladderTierOrder covering exactly its tiers`, () => {
      const order = p.json.ladderTierOrder;
      expect(order, `${p.name} declares no ladderTierOrder`).toBeDefined();
      expect([...order].sort()).toEqual(Object.keys(p.json.ladders).sort());
    });

    it(`${p.name}: every startModel can escalate — it is a 'from' in its own chain`, () => {
      for (const [tier, v] of Object.entries<any>(p.json.ladders)) {
        const froms = new Set((v.modelLadder || []).map((h: any) => h.from));
        expect(
          froms.has(v.startModel),
          `${p.name}.${tier}: startModel ${v.startModel} has no escalation edge out — it would be a dead end`,
        ).toBe(true);
      }
    });
  }

  it('all ladder-declaring projects agree on the tier vocabulary', () => {
    const orders = withLadders.map((p) => JSON.stringify([...(p.json.ladderTierOrder || [])].sort()));
    expect(new Set(orders).size, `tier vocabularies differ: ${orders.join(' vs ')}`).toBe(1);
  });
});
