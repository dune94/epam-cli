/**
 * EVERY SEAM GETS ITS LADDER, FROM EVERY CALLER, WITH NO EXCEPTIONS.
 *
 * A seam declares which ladder position it climbs, and the project declares what each tier
 * contains. Both are data. But the resolution read them out of AMBIENT ENVIRONMENT —
 * EPAM_MODEL_LADDER_TIER_ORDER and EPAM_MODEL_LADDER_<TIER>, exported by model-ladders.sh — so a
 * seam invoked from a process whose caller never sourced that library silently resolved to no
 * ladder, no chain and no iteration budget.
 *
 * That is not a discovery problem. It is every agent launched from any script that does not
 * happen to source one shell library: resolve-codeline-scope.sh and ingest-jira-tickets.sh don't,
 * and codeline-discovery runs under both. The declaration was correct, the consumer was correct,
 * and the value was absent — the same shape as a tool grant declared and never delivered.
 *
 * The project's own llm-settings.json declares `ladderTierOrder` and `ladders.<tier>`, so the
 * answer is on disk whether or not a shell exported it. These tests hold the seam to resolving it
 * from that declaration, with the environment deliberately stripped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/seam-invocation.js');

/** A project that declares its tiers and chains, exactly as llm-settings.json does. */
const projectDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'llm-settings.json'), JSON.stringify({
    ladderTierOrder: ['medium', 'high', 'highest'],
    // The real shape lib/model-settings.js reads: a match rule plus the budget. Inventing a
    // simpler shape here would have tested this file's idea of the format, not the format.
    modelOverrides: {
      topRung: { matchOn: 'model', matchSubstring: 'model-c', maxIterations: 120 },
    },
    ladders: {
      medium: { startModel: 'model-a', modelLadder: [{ from: 'model-a', to: 'model-b' }] },
      high: { startModel: 'model-b', modelLadder: [{ from: 'model-b', to: 'model-c' }] },
      highest: {
        startModel: 'model-c',
        modelLadder: [{ from: 'model-c', to: 'model-d' }, { from: 'model-d', to: 'model-e' }],
      },
    },
  }));
  return d;
};

const ENV = { ...process.env };
let dir = '';

beforeEach(() => { dir = projectDir(); });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.env = { ...ENV };
});

/** The environment a caller that never sourced model-ladders.sh actually provides: none of it. */
const strippedEnv = (projectConfigDir: string) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^EPAM_MODEL_LADDER/.test(k)) continue;
    if (typeof v === 'string') env[k] = v;
  }
  env.EPAM_PROJECT_CONFIG_DIR = projectConfigDir;
  return env;
};

const envFor = (seam: string, projectConfigDir: string) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { seamInvocationEnv } = require(LIB);
  return seamInvocationEnv(seam, undefined, { env: strippedEnv(projectConfigDir) }) || {};
};

describe('a caller that never sourced the ladder library still gets one', () => {
  it('resolves the chain from the project declaration, not from ambient env', () => {
    const env = envFor('codeline-discovery', dir);
    // codeline-discovery declares position "top" -> the LAST tier the project declares.
    expect(env.EPAM_MODEL_LADDER, 'the seam resolved to no ladder at all').toBeTruthy();
    expect(env.EPAM_MODEL_LADDER).toBe('model-c=model-d|model-d=model-e');
  });

  it('carries the tier\'s declared start model', () => {
    // The seam publishes it as EPAM_MODEL — the model this seam OPENS on, which is what every
    // consumer reads.
    const env = envFor('codeline-discovery', dir);
    expect(env.EPAM_MODEL).toBe('model-c');
  });

  it('and therefore has an iteration budget — the ladder defines iterations', () => {
    // The budget belongs to the rung. With no ladder there is no rung, so this was unset and the
    // agent ran on whatever default its runner happened to hold.
    const env = envFor('codeline-discovery', dir);
    expect(Number(env.EPAM_MAX_ITERATIONS || 0)).toBeGreaterThan(0);
  });
});

describe('positions resolve against the project\'s own tier names', () => {
  it('base is the lowest tier the project declares', () => {
    // A seam declaring "base" must not be handed the top chain.
    const env = envFor('cpa-inference', dir);
    expect(env.EPAM_MODEL_LADDER).toBe('model-a=model-b');
  });
});

describe('an operator override still outranks the declaration', () => {
  it('an explicit chain in the environment wins', () => {
    // The declaration is the fallback, not a new authority: someone debugging must keep the lever.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { seamInvocationEnv } = require(LIB);
    const env = { ...strippedEnv(dir), EPAM_MODEL_LADDER_HIGHEST: 'forced-a=forced-b' };
    const out = seamInvocationEnv('codeline-discovery', undefined, { env }) || {};
    expect(out.EPAM_MODEL_LADDER).toBe('forced-a=forced-b');
  });
});

describe('every seam that declares a ladder actually receives one', () => {
  it('no seam is left without a chain', () => {
    // The sweep. One seam resolving correctly proves the mechanism; this proves the coverage,
    // which is what "all agents, no exceptions" means.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const reg = require(join(__dirname, '../../../orchestrations/agents/invocation-profiles.json'));
    const seams: Array<[string, { ladder?: string }]> = [];
    (function walk(o: Record<string, unknown>) {
      for (const k of Object.keys(o)) {
        const v = o[k] as Record<string, unknown>;
        if (v && typeof v === 'object') {
          if (v.ladder) seams.push([k, v as { ladder?: string }]);
          walk(v);
        }
      }
    }((reg.profiles || {}) as Record<string, unknown>));

    expect(seams.length, 'no seam declares a ladder — this test is checking nothing')
      .toBeGreaterThan(0);

    const without = seams
      .filter(([name]) => !envFor(name, dir).EPAM_MODEL_LADDER)
      .map(([name]) => name);
    expect(without, `seams declaring a ladder that receive none: ${without.join(', ')}`).toEqual([]);
  });
});
