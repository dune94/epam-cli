/**
 * EVERY SEAM CAN REACH ITS LADDER.
 *
 * Operator direction, 2026-08-15: every prompt must be wired into the ladder.
 *
 * A seam declares a POSITION in the project's ladder order (`ladder: top`), and the PROJECT
 * declares both the order (ladderTierOrder, lowest → highest) and what each tier contains
 * (ladders.<tier>.modelLadder). Those are two files owned by two parties, and nothing held
 * them in step.
 *
 * LIVE, mock3, 2026-08-15 — the first end-to-end mint run printed:
 *
 *   [seam-invocation] agent 'guard-vocabulary' resolved to seam 'guard-vocabulary' which
 *   asks for ladder 'HIGHEST', but EPAM_MODEL_LADDER_HIGHEST is unset in this process
 *
 * hello-dolly declares `high` and `medium`. Twenty seams require `highest`. So on that
 * project every one of them ran with no ladder and no escalation chain — and seam-invocation
 * calls this "not fatal", so the run continued. A seam that cannot reach its ladder has no
 * model to escalate to when it fails, which is precisely when a ladder is supposed to help.
 *
 * TWO defects, both now closed: hello-dolly declared no `highest` tier (data), and the
 * registry named tiers literally (engine). A seam now declares a position and the project
 * supplies the name, so the engine holds no tier vocabulary — which is what llm-settings.json
 * already claimed in its own words.
 *
 * Case is not the issue — seam-invocation.js and model-ladders.sh both upper-case the tier
 * before use. This test resolves positions exactly as the engine does, rather than asserting
 * any spelling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stackNames } from '../../support/llm-settings';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const PROJECTS = join(ROOT, 'orchestrations/projects');

const norm = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '_');

// A PROJECT NO LONGER DECLARES ITS OWN LADDERS — IT RESOLVES THEM.
//
// ladders and ladderTierOrder moved into config/llm-defaults.<set>.json on 2026-08-25. Reading
// the project file directly found neither, so all four projects reported that no seam could
// reach any ladder — a total pipeline failure that was really a reader left behind. Production
// resolves through lib/llm-settings-resolve.js, so the check does too.
//
// And it now runs for EVERY declared stack, not just the default one: a stack is hot-swappable
// only if a swap cannot leave a seam without a chain, and the whole point of the migration was
// that the ladder travels with the stack.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLlmSettings } = require(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'));

function resolved(projectDir: string, set: string): any {
  const prior = process.env.EPAM_PROVIDER_SET;
  process.env.EPAM_PROVIDER_SET = set;
  try {
    return { ...readJson(join(projectDir, 'llm-settings.json')), ...resolveLlmSettings({ projectConfigDir: projectDir }) };
  } finally {
    if (prior === undefined) delete process.env.EPAM_PROVIDER_SET;
    else process.env.EPAM_PROVIDER_SET = prior;
  }
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * POSITIONS the engine requires, taken from the registry. A seam declares a position in the
 * project's own order (base|mid|top) and never a tier NAME, so what must be checked is that
 * each project's order can RESOLVE every position — not that it happens to use some spelling.
 */
function requiredPositions(): string[] {
  const r = readJson(REGISTRY);
  return [...new Set(
    Object.values(r.profiles || {})
      .map((v: any) => v && v.ladder)
      .filter(Boolean)
      .map((l: any) => String(l).toLowerCase()),
  )].sort();
}

/** The same resolution seam-invocation.js performs, against a project's declared order. */
function resolvePosition(position: string, order: string[]): string {
  if (!order.length) return '';
  if (position === 'base') return order[0];
  if (position === 'top') return order[order.length - 1];
  if (position === 'mid') return order[Math.floor((order.length - 1) / 2)];
  return order.includes(position) ? position : '';
}

/** Projects that declare model settings at all — one without them is a different question. */
function projectsWithSettings(): Array<{ name: string; file: string }> {
  return readdirSync(PROJECTS)
    .map((name) => ({ name, file: join(PROJECTS, name, 'llm-settings.json') }))
    .filter((p) => existsSync(p.file));
}

function declaredTiers(doc: any): Record<string, any> {
  const ladders = doc.ladders || doc.tiers || {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(ladders)) out[norm(k)] = v;
  return out;
}

describe('the engine states which ladder positions it needs', () => {
  it('is not vacuous — seams do require ladders', () => {
    expect(requiredPositions().length).toBeGreaterThan(0);
  });

  it('every required position is a real value, not an empty string', () => {
    for (const p of requiredPositions()) expect(p.length).toBeGreaterThan(0);
  });
});

describe('every project declares every ladder its seams will climb', () => {
  const required = requiredPositions();

  for (const p of projectsWithSettings()) for (const set of stackNames()) {
    it(`${p.name} on the ${set} stack resolves every position: ${required.join(', ')}`, () => {
      const doc = resolved(join(PROJECTS, p.name), set);
      const order: string[] = (doc.ladderTierOrder || []).map((t: string) => String(t).toLowerCase());
      const declared = declaredTiers(doc);
      const unresolved = required
        .map((pos) => ({ pos, tier: resolvePosition(pos, order) }))
        .filter(({ tier }) => !tier || !(norm(tier) in declared))
        .map(({ pos, tier }) => `${pos}${tier ? ` -> ${tier}` : ''}`);
      expect(unresolved,
        `${p.name} cannot resolve position(s) ${unresolved.join(', ')} — every seam asking `
        + 'for one would run with no escalation chain, which seam-invocation reports and then '
        + 'continues past').toEqual([]);
    });

    it(`${p.name} on the ${set} stack declares ladders that each contain at least one hop`, () => {
      // A tier that exists but is empty is the same failure with a friendlier name: the
      // seam resolves, finds nothing to climb to, and cannot escalate when it fails.
      const doc = resolved(join(PROJECTS, p.name), set);
      const declared = declaredTiers(doc);
      const order: string[] = (doc.ladderTierOrder || []).map((t: string) => String(t).toLowerCase());
      const needed = new Set(required.map((pos) => norm(resolvePosition(pos, order))));
      const empty = Object.entries(declared)
        .filter(([t]) => needed.has(t))
        .filter(([, v]: any) => !Array.isArray(v?.modelLadder) || v.modelLadder.length === 0)
        .map(([t]) => t);
      expect(empty, `${p.name} on ${set} declares empty ladder(s): ${empty.join(', ')}`).toEqual([]);
    });
  }
});
