/**
 * ALL 40 SEAMS ASKED FOR A LADDER TIER NOTHING DEFINED.
 *
 * invocation-profiles.json declared each seam's ladder position as `base`, `mid` or `top`. Every
 * provider set declares its tiers as `medium`, `high`, `highest`. Not one name overlapped, so every
 * seam in the pipeline resolved NO model from the ladder it declared and ran on whatever the
 * environment happened to be carrying.
 *
 * seam-invocation.js said so on every run:
 *
 *   seam 'project-roster-review' asks for ladder position 'top' but EPAM_MODEL_LADDER_TIER_ORDER
 *   is unset — the project declares no tier order, so no position can be resolved
 *
 * The consequence is not subtle. "The ladder is the source of truth" was not true of a single seam:
 * a run could declare which model each seam climbs to and none of it applied. It surfaced on
 * 2026-09-01 when the roster review tried to size itself from its model's capacity and found no
 * model to ask.
 *
 * This is the same defect as the roster gate reading a verdict nobody emits — two files naming the
 * same thing differently, with nothing asserting they agree. That is what this test is: the tier
 * names come from the PROVIDER SET, and every seam must name one that exists there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CONFIG = join(REPO, 'orchestrations/config');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const profiles = registry.profiles || registry;
const seams = Object.entries<any>(profiles)
  .filter(([n, p]) => !n.startsWith('_') && !n.startsWith('$') && p && typeof p === 'object');
const sets = readdirSync(CONFIG).filter((f) => /^llm-defaults\..*\.json$/.test(f));

describe('every seam names a ladder tier that exists', () => {
  it('there are seams and provider sets to check — otherwise this proves nothing', () => {
    expect(seams.length, 'no seams found in the registry').toBeGreaterThan(20);
    expect(sets.length, 'no provider sets found').toBeGreaterThan(1);
  });

  it('THE DEFECT: every declared tier exists in EVERY provider set', () => {
    // A tier valid in one stack and missing from another means the seam silently loses its model
    // the moment the operator hot-swaps sets — which is the whole point of having sets.
    const mismatches: string[] = [];
    for (const f of sets) {
      const declared = new Set(Object.keys(JSON.parse(readFileSync(join(CONFIG, f), 'utf8')).ladders || {}));
      for (const [name, p] of seams) {
        if (!p.ladder) continue;
        if (!declared.has(p.ladder)) mismatches.push(`${f}: ${name} asks for '${p.ladder}'`);
      }
    }
    expect(mismatches, `${mismatches.length} seam/set tier mismatch(es):\n${mismatches.slice(0, 10).join('\n')}`)
      .toEqual([]);
  });

  it('and the tier actually yields a start model, not merely a key', () => {
    // A tier that exists but declares no startModel resolves nothing, which is the same failure
    // wearing a valid name.
    const j = JSON.parse(readFileSync(join(CONFIG, 'llm-defaults.claude.json'), 'utf8'));
    const used = [...new Set(seams.map(([, p]) => p.ladder).filter(Boolean))];
    expect(used.length, 'no seam declares a ladder at all').toBeGreaterThan(0);
    for (const tier of used) {
      expect(j.ladders[tier]?.startModel, `tier '${tier}' declares no startModel`).toBeTruthy();
    }
  });

  it('the tier names are NOT redefined in the seam registry', () => {
    // The provider set owns them. A second list here is a second thing to drift, and drifting is
    // exactly what happened: base/mid/top against medium/high/highest.
    const raw = readFileSync(REGISTRY, 'utf8');
    for (const gone of ['"base"', '"mid"', '"top"']) {
      expect(raw.includes(`"ladder": ${gone}`),
        `the registry still declares ladder ${gone}, which no provider set defines`).toBe(false);
    }
  });
});
