/**
 * THE ENGINE NAMES NO LADDER TIER.
 *
 * Operator rule, 2026-08-15: "you cannot hard code highest or high or medium — it must be
 * injected from config."
 *
 * The project already owns the ordering, and llm-settings.json says so in its own words:
 *
 *   ladderTierOrder: ["medium","high","highest"]
 *   "Lowest to highest. Consumers compare tiers through this; the engine holds no ordering
 *    of its own, so adding a tier is a change here and nowhere else."
 *
 * But invocation-profiles.json contradicted it: 25 seams named `HIGHEST` or `medium`
 * literally. A project that calls its tiers anything else — cheap/standard/premium, t1/t2/t3
 * — has seams pointing at tiers it does not have, and seam-invocation reports the miss and
 * then CONTINUES, so every one of them runs with no escalation chain. That is not
 * hypothetical: hello-dolly declared only high and medium, and twenty seams asking for
 * HIGHEST ran unladdered through its whole mint.
 *
 * So a seam declares a POSITION in the project's own order, and the project's order supplies
 * the name. The engine holds no tier vocabulary, which is what its own comment already
 * claimed.
 *
 * Positions are relative to the declared order, so they stay meaningful whatever a project
 * calls its tiers and however many it has.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const PROJECTS = join(ROOT, 'orchestrations/projects');

// WHAT A PROJECT RESOLVES, not what its file literally holds. A tier ORDER is part of a
// stack's ladder declaration, and projects inherit both since 2026-08-25. Reading the raw
// project file asserted a LOCATION; the contract is that whatever a project runs with
// declares an order, so a seam's position can be resolved to a tier.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLlmSettings } = require('../../../orchestrations/scripts/lib/llm-settings-resolve.js');
const resolved = (p: string) => resolveLlmSettings({ projectConfigDir: join(PROJECTS, p) });
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Tier names any project in this repo happens to use — the engine may name none of them. */
function projectTierNames(): string[] {
  const names = new Set<string>();
  for (const p of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, p, 'llm-settings.json');
    if (!existsSync(f)) continue;
    for (const t of Object.keys(resolved(p).ladders || {})) names.add(t.toLowerCase());
    for (const t of resolved(p).ladderTierOrder || []) names.add(String(t).toLowerCase());
  }
  return [...names];
}

describe('the registry declares a position, never a tier name', () => {
  it('is not vacuous — projects do declare tier names, and seams do ask for ladders', () => {
    expect(projectTierNames().length).toBeGreaterThan(1);
    const seams = Object.values(readJson(REGISTRY).profiles || {}).filter((v: any) => v?.ladder);
    expect(seams.length).toBeGreaterThan(10);
  });

  it('no seam names a tier that belongs to a project', () => {
    const tiers = projectTierNames();
    const offenders = Object.entries(readJson(REGISTRY).profiles || {})
      .filter(([, v]: any) => v?.ladder)
      .filter(([, v]: any) => tiers.includes(String(v.ladder).toLowerCase()))
      .map(([k, v]: any) => `${k} -> ${v.ladder}`);
    expect(offenders,
      `${offenders.length} seam(s) name a project's tier. A project using different tier `
      + 'names would leave these unladdered.').toEqual([]);
  });

  it('every seam ladder is a POSITION the order can resolve', () => {
    // Positions are relative to ladderTierOrder (lowest → highest), so they survive a project
    // renaming its tiers or declaring a different number of them.
    const allowed = new Set(['base', 'mid', 'top']);
    const bad = Object.entries(readJson(REGISTRY).profiles || {})
      .filter(([, v]: any) => v?.ladder)
      .filter(([, v]: any) => !allowed.has(String(v.ladder).toLowerCase()))
      .map(([k, v]: any) => `${k} -> ${v.ladder}`);
    expect(bad, `not a position: ${bad.join(', ')}`).toEqual([]);
  });
});

describe('every project declares the order that resolves those positions', () => {
  for (const p of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, p, 'llm-settings.json');
    if (!existsSync(f)) continue;
    it(`${p} declares ladderTierOrder`, () => {
      const order = resolved(p).ladderTierOrder;
      expect(Array.isArray(order) && order.length > 0,
        `${p} has ladders but no declared order, so a position cannot be resolved`).toBe(true);
    });
    it(`${p}'s order names only tiers it actually declares`, () => {
      const doc = resolved(p);
      const declared = Object.keys(doc.ladders || {});
      const missing = (doc.ladderTierOrder || []).filter((t: string) => !declared.includes(t));
      expect(missing, `${p} orders tier(s) it does not declare: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('the resolver holds no tier vocabulary either', () => {
  it('seam-invocation.js names no tier', () => {
    const src = readFileSync(join(SCRIPTS, 'lib/seam-invocation.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const t of projectTierNames()) {
      expect(src.toLowerCase(), `seam-invocation.js hardcodes the tier '${t}'`)
        .not.toMatch(new RegExp(`['"\`]${t}['"\`]`));
    }
  });
});
