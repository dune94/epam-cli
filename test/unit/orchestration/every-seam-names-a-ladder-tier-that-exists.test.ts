/**
 * EVERY SEAM'S LADDER POSITION RESOLVES TO A REAL TIER IN EVERY PROVIDER SET.
 *
 * 2026-09-01: "all 40 seams asked for a ladder tier nothing defined" — seams declared positions
 * (base/mid/top), sets declare medium/high/highest, and seam-invocation.js warned on every run
 * that no position could be resolved. The response was to rename every seam to a literal tier
 * name, and this test then asserted the names existed in every set.
 *
 * That diagnosis was wrong, and the rename resolved nothing: the warning kept printing with
 * 'highest' in it. The cause was seam-invocation.js reading the project's own llm-settings.json
 * for the tier order and the chains — a file that has carried neither since the ladders moved to
 * the provider SET on 2026-08-25 (`_laddersMovedToSet`). Every shell caller that had sourced
 * model-ladders.sh exported them and worked; every other caller resolved nothing, whichever
 * vocabulary the seam used. Found 2026-09-11 by snapshotting every seam's resolution on every set
 * with and without the exports.
 *
 * The resolver now reads the project's EFFECTIVE settings (engine, set, project — the document
 * model-ladders.sh exports from), and the registry is back on positions, as the 2026-08-15 rule
 * requires: "you cannot hard code highest or high or medium — it must be injected from config."
 *
 * So what this test asserts, END TO END through the real resolver: every seam declares a position
 * the registry names, and on every provider set that position lands on a tier that declares a
 * start model — with nothing exported into the environment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CONFIG = join(REPO, 'orchestrations/config');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
// Every project the repository declares, derived — a position must land on a tier for each.
const PROJECTS = readdirSync(join(REPO, 'orchestrations/projects'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(REPO, 'orchestrations/projects', e.name, 'config.env')))
  .map((e) => join(REPO, 'orchestrations/projects', e.name));

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const profiles = registry.profiles || registry;
const positions: string[] = registry._ladderPositions?.names || [];
const seams = Object.entries<any>(profiles)
  .filter(([n, p]) => !n.startsWith('_') && !n.startsWith('$') && p && typeof p === 'object');
const sets = JSON.parse(readFileSync(join(CONFIG, 'provider-sets.json'), 'utf8')).sets as Record<string, { settingsFile: string }>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveTierPosition } = require(join(REPO, 'orchestrations/scripts/lib/seam-invocation.js'));

describe('every seam names a ladder position that resolves in every provider set', () => {
  it('there are seams, positions, provider sets and projects to check — otherwise this proves nothing', () => {
    expect(seams.length, 'no seams found in the registry').toBeGreaterThan(20);
    expect(PROJECTS.length, 'no projects declared').toBeGreaterThan(0);
    expect(positions.length, 'the registry names no positions').toBeGreaterThan(1);
    expect(Object.keys(sets).length, 'no provider sets found').toBeGreaterThan(1);
  });

  it('every seam declares a POSITION the registry names — never a tier name of its own', () => {
    const bad = seams.filter(([, p]) => p.ladder && !positions.includes(p.ladder)).map(([n, p]) => `${n} -> ${p.ladder}`);
    expect(bad, 'seams naming something other than a declared position (a tier name belongs to the set, not the engine)').toEqual([]);
  });

  it('THE DEFECT: on EVERY provider set, with NOTHING exported, each position lands on a tier that declares a start model', () => {
    const misses: string[] = [];
    for (const [set, cfg] of Object.entries(sets)) {
      const decl = JSON.parse(readFileSync(join(CONFIG, cfg.settingsFile), 'utf8'));
      const prev = process.env.EPAM_PROVIDER_SET; process.env.EPAM_PROVIDER_SET = set;
      try {
        for (const project of PROJECTS) {
          const env = { EPAM_PROJECT_CONFIG_DIR: project, EPAM_PROVIDER_SET: set };
          const who = `${set}/${project.split('/').pop()}`;
          for (const [name, p] of seams) {
            if (!p.ladder) continue;
            const tier = resolveTierPosition(p.ladder, env);
            if (!tier) { misses.push(`${who}: ${name} position '${p.ladder}' resolves to no tier`); continue; }
            if (!decl.ladders?.[tier]?.startModel) misses.push(`${who}: ${name} -> '${tier}' declares no startModel`);
          }
        }
      } finally { if (prev === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prev; }
    }
    expect(misses, `${misses.length} seam/set miss(es):\n${misses.slice(0, 10).join('\n')}`).toEqual([]);
  });

  it('the tier names are NOT written into the seam registry', () => {
    // The provider set owns them. A literal here is the 2026-09-01 regression.
    const tierNames = new Set<string>();
    for (const cfg of Object.values(sets)) {
      for (const t of Object.keys(JSON.parse(readFileSync(join(CONFIG, cfg.settingsFile), 'utf8')).ladders || {})) tierNames.add(t);
    }
    const raw = readFileSync(REGISTRY, 'utf8');
    for (const t of tierNames) {
      expect(raw.includes(`"ladder": "${t}"`), `the registry declares ladder "${t}" literally — a set's tier name, hardcoded in the engine`).toBe(false);
    }
  });
});
