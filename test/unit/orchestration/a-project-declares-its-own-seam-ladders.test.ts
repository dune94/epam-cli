/**
 * A LADDER POSITION IS A PROJECT DECISION, NOT AN ENGINE ONE.
 *
 * seamInvocationEnv read `profile.ladder` from orchestrations/agents/invocation-profiles.json and
 * nowhere else. That file is SHARED, so moving a seam to a cheaper rung for one project moved it
 * for every project — and the only way to make one project cheap was to retune the rest with it.
 *
 * A project is DATA: retuning one must take zero engine changes. The registry keeps the DEFAULT; a
 * project overrides it in its own llm-settings.json, per seam or with '*' for all of them.
 *
 * NOTHING HERE IS NAMED. The seams, the positions and the tier vocabulary are all read from the
 * registry and the project's own declaration: naming them would bake today's roster into the test,
 * so a seam renamed or a position added would pass here and fail in the pipeline.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamLadderFor, seamInvocationEnv } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

const REGISTRY = JSON.parse(readFileSync(
  join(REPO_ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));

/** The position vocabulary, from the registry that owns it. */
const POSITIONS: string[] = REGISTRY._ladderPositions.names;

/** Seams grouped by the position they declare — the subjects, discovered rather than named. */
const BY_POSITION = new Map<string, string[]>();
for (const [seam, p] of Object.entries<any>(REGISTRY.profiles)) {
  if (p && p.ladder) BY_POSITION.set(p.ladder, [...(BY_POSITION.get(p.ladder) || []), seam]);
}
/** One seam declaring each position that any seam declares. */
const SUBJECT = Object.fromEntries(
  [...BY_POSITION.entries()].map(([pos, seams]) => [pos, seams.slice().sort()[0]]));

/** A position the registry knows that this seam does NOT already declare. */
function otherPosition(seam: string): string {
  const own = REGISTRY.profiles[seam].ladder;
  const other = POSITIONS.find((p) => p !== own);
  if (!other) throw new Error('the registry declares only one position — nothing to override to');
  return other;
}

function project(settings: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'seam-ladder-'));
  writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(settings));
  return dir;
}

function withProject(settings: any, fn: (dir: string) => void): void {
  const dir = project(settings);
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('a project declares its own seam ladders', () => {
  it('the registry declares a position vocabulary and seams that use it', () => {
    // Guards every case below against passing vacuously on an empty registry.
    expect(POSITIONS.length).toBeGreaterThan(1);
    expect(Object.keys(SUBJECT).length).toBeGreaterThan(0);
  });

  it('the registry still supplies the default when a project says nothing', () => {
    withProject({}, (dir) => {
      for (const [pos, seam] of Object.entries(SUBJECT)) {
        expect(seamLadderFor(seam, dir), `${seam} lost its registry default`).toBe(pos);
      }
    });
  });

  it('REPRODUCES the bug: a project moves a seam to another rung for ITSELF', () => {
    for (const seam of Object.values(SUBJECT)) {
      const want = otherPosition(seam);
      withProject({ seamLadders: { [seam]: want } }, (dir) => {
        expect(seamLadderFor(seam, dir),
          `${seam} cannot be retuned per project, so the only way to move it is to change the `
          + 'shared registry and move it for every other project too')
          .toBe(want);
      });
    }
  });

  it('the override is per SEAM — it does not leak to seams it did not name', () => {
    const named = Object.values(SUBJECT)[0];
    const others = Object.values(SUBJECT).filter((s) => s !== named);
    withProject({ seamLadders: { [named]: otherPosition(named) } }, (dir) => {
      for (const s of others) {
        expect(seamLadderFor(s, dir), `${s} inherited an override meant for ${named}`)
          .toBe(REGISTRY.profiles[s].ladder);
      }
    });
  });

  it("'*' is the default for every seam the project did not name, and a named seam still wins", () => {
    const [fallback, exception] = POSITIONS;
    const named = Object.values(SUBJECT)[0];
    withProject({ seamLadders: { '*': fallback, [named]: exception } }, (dir) => {
      for (const s of Object.values(SUBJECT)) {
        expect(seamLadderFor(s, dir)).toBe(s === named ? exception : fallback);
      }
      // A seam this registry does not hold yet still lands on the project's default, so a seam
      // added later cannot silently reopen the project on the registry's rung.
      expect(seamLadderFor('a-seam-no-registry-declares-yet', dir)).toBe(fallback);
    });
  });

  it('a position the registry does not declare is REFUSED, never guessed', () => {
    const bogus = `not-${POSITIONS.join('-or-')}`;
    const seam = Object.values(SUBJECT)[0];
    withProject({ seamLadders: { [seam]: bogus } }, (dir) => {
      expect(() => seamLadderFor(seam, dir)).toThrow(new RegExp(bogus));
    });
    withProject({ seamLadders: { '*': bogus } }, (dir) => {
      expect(() => seamLadderFor(seam, dir)).toThrow(new RegExp(bogus));
    });
  });

  it('a project with no settings file at all still resolves the registry default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-ladder-none-'));
    try {
      for (const [pos, seam] of Object.entries(SUBJECT)) expect(seamLadderFor(seam, dir)).toBe(pos);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * THE RESOLVER ANSWERING CORRECTLY IS NOT THE SEAM SPENDING LESS.
   *
   * A resolver that returned the project's position while seamInvocationEnv went on reading the
   * registry would pass everything above and bill the registry's rung anyway.
   */
  it('the override reaches the CALL: the seam is invoked with the project-chosen tier', () => {
    // A tier order and chain built from the position vocabulary itself, so this holds however many
    // positions the registry declares.
    const tiers = POSITIONS.map((_, i) => `tier-${i}`);
    const env: Record<string, string> = { EPAM_MODEL_LADDER_TIER_ORDER: tiers.join(' ') };
    for (const t of tiers) {
      const KEY = t.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      env[`EPAM_MODEL_LADDER_${KEY}`] = `model-${t}=model-${t}`;
      env[`EPAM_MODEL_LADDER_${KEY}_START`] = `model-${t}`;
    }
    const seam = Object.values(SUBJECT)[0];
    const want = otherPosition(seam);
    const modelFor = (dir: string) =>
      seamInvocationEnv(seam, undefined, { env: { ...env, EPAM_PROJECT_CONFIG_DIR: dir } }).EPAM_MODEL;

    let overridden = '';
    let untouched = '';
    withProject({ seamLadders: { [seam]: want } }, (d) => { overridden = modelFor(d); });
    withProject({}, (d) => { untouched = modelFor(d); });

    expect(overridden, 'the call resolved no model at all').toBeTruthy();
    expect(overridden, `${seam} was overridden to ${want} and still billed its registry rung`)
      .not.toBe(untouched);
    // and it landed on the tier the project's own order maps that position to
    expect(overridden).toBe(`model-${tiers[POSITIONS.indexOf(want)]}`);
  });
});
