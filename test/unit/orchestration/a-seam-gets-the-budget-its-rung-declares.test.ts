/**
 * THE ITERATION BUDGET COMES FROM THE SAME PLACE THE MODEL DOES.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * A seam resolves its MODEL from the ladder, which lives in the provider set — the stack owns its
 * models. Its ITERATION BUDGET was resolved somewhere else entirely: iterationMap() reads only the
 * project's llm-settings.json modelOverrides, matching on a model-name substring.
 *
 * So when mock3 moved to the claude stack, every seam started on claude-haiku-4-5-20251001 while
 * the project's overrides still named minimax-m3, glm-5.2 and kimi-k3 — leftovers from the
 * openrouter stack. Nothing matched, and every seam of every run logged "the project declares no
 * iteration budget for it — the seam will run on the engine default, which is nobody's choice",
 * then ran on that default. Live on 2026-08-27, on every seam.
 *
 * Meanwhile the budgets DO exist: the ladder declares maxIterations per RUNG
 * (ladders.high.rungs[1].maxIterations = 250). The seam already knows its tier and its rung — it
 * resolved its model from exactly that. It simply never read the budget sitting beside it.
 *
 * Restating the budgets per project is the duplication the ladder move removed. The rung declares
 * it once; the seam reads it there.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const REGISTRY = require(join(ROOT, 'orchestrations/agents/invocation-profiles.json'));

/** A seam that declares a ladder position — discovered, never named. */
const SEAM = Object.entries<any>(REGISTRY.profiles)
  .filter(([, p]) => p && p.ladder)
  .map(([n]) => n).sort()[0];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Tier names and per-rung budgets, built from the registry's own position vocabulary. */
const POSITIONS: string[] = REGISTRY._ladderPositions.names;
const TIERS = POSITIONS.map((_, i) => `tier-${i}`);
const BUDGETS = [11, 22, 33];   // distinct, so a wrong rung cannot look right

function project(extra: any = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'rung-budget-')); dirs.push(d);
  const ladders: any = {};
  for (const t of TIERS) {
    ladders[t] = {
      modelLadder: [{ from: `model-${t}-0`, to: `model-${t}-1` }, { from: `model-${t}-1`, to: `model-${t}-2` }],
      rungs: BUDGETS.map((b, i) => ({ rung: i, maxIterations: b })),
    };
  }
  writeFileSync(join(d, 'llm-settings.json'),
    JSON.stringify({ ladderTierOrder: TIERS, ladders, ...extra }));
  return d;
}

function envFor(dir: string, rung: number): Record<string, string> {
  const base: Record<string, string> = { EPAM_MODEL_LADDER_TIER_ORDER: TIERS.join(' '), EPAM_PROJECT_CONFIG_DIR: dir };
  for (const t of TIERS) {
    const K = t.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    base[`EPAM_MODEL_LADDER_${K}`] = `model-${t}-0=model-${t}-1|model-${t}-1=model-${t}-2`;
    base[`EPAM_MODEL_LADDER_${K}_START`] = `model-${t}-0`;
  }
  return seamInvocationEnv(SEAM, undefined, { env: base, rung });
}

describe('the fixture is real', () => {
  it('a seam with a ladder exists and resolves a model', () => {
    expect(SEAM, 'no seam declares a ladder — the test would prove nothing').toBeTruthy();
    expect(envFor(project(), 0).EPAM_MODEL).toBeTruthy();
  });
});

describe('THE DEFECT: the budget was looked up somewhere the model never came from', () => {
  it('rung 0 gets the budget rung 0 declares', () => {
    expect(envFor(project(), 0).EPAM_MAX_ITERATIONS,
      'the seam fell through to the engine default while its own rung declared a budget')
      .toBe(String(BUDGETS[0]));
  });

  it('climbing a rung takes the budget of the rung climbed to', () => {
    expect(envFor(project(), 1).EPAM_MAX_ITERATIONS).toBe(String(BUDGETS[1]));
    expect(envFor(project(), 2).EPAM_MAX_ITERATIONS).toBe(String(BUDGETS[2]));
  });

  it('past the top rung it holds the top rung\'s budget rather than losing it', () => {
    expect(envFor(project(), 99).EPAM_MAX_ITERATIONS).toBe(String(BUDGETS[BUDGETS.length - 1]));
  });
});

describe('an explicit per-model override still wins', () => {
  it('a project that named this model on purpose is not overruled by the rung default', () => {
    const dir = project({
      modelOverrides: {
        pinned: { matchOn: 'model', matchSubstring: 'model-tier-0-0', maxIterations: 999 },
      },
    });
    expect(envFor(dir, 0).EPAM_MAX_ITERATIONS,
      'a deliberate per-model budget was discarded in favour of the rung default')
      .toBe('999');
  });
});
