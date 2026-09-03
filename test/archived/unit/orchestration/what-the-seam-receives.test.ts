/**
 * THE RECEIVER, NOT THE PROVIDER.
 *
 * Every test I wrote about the provider sets asserted what the CONFIG RESOLVES — the provider
 * side. None asserted what a SEAM ACTUALLY RECEIVES. That gap cost real money twice on
 * 2026-08-25: the mockserver set declared ANTHROPIC_BASE_URL=http://localhost:1080, the
 * resolver returned it, a dry run printed it — and the seams never saw it. MockServer logged
 * ZERO requests while models answered from the live API.
 *
 * A declaration nothing receives is indistinguishable from no declaration, except that it
 * reads as configured. These assertions call the SAME function the pipeline calls
 * (seamInvocationEnv) and inspect what comes back, so a value that stops arriving fails here
 * rather than in a bill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MOD = join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js');
const REG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const PROFILES = JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));

function fresh() { delete require.cache[require.resolve(MOD)]; return require(MOD); }
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

/** What a seam ACTUALLY receives — the same call the pipeline makes. */
function received(seam: string, set: string): Record<string, string> {
  process.env.EPAM_PROVIDER_SET = set;
  process.env.EPAM_PROJECT_CONFIG_DIR = join(ROOT, 'orchestrations/projects/metrolinx');
  const { seamInvocationEnv } = fresh();
  try { return seamInvocationEnv(seam, undefined, { sourceEnv: process.env }) || {}; }
  catch { return {}; }
}

/** What the SET declares its runner passes — the provider side. */
function declared(set: string): Record<string, string> {
  const cfg = REG.sets[set];
  const j = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', cfg.settingsFile), 'utf8'));
  const runner = Object.values<any>(j.runners || {})[0] || {};
  return runner.env || {};
}

const SEAMS = Object.keys(PROFILES.profiles || {}).filter((s) => PROFILES.profiles[s].ladder);

describe('what the seam receives', () => {
  it('there are seams and sets to check — otherwise this is vacuous', () => {
    expect(SEAMS.length).toBeGreaterThan(10);
    expect(Object.keys(REG.sets).length).toBeGreaterThan(1);
  });

  it('a seam receives a MODEL under every declared set', () => {
    for (const set of Object.keys(REG.sets)) {
      for (const seam of SEAMS.slice(0, 6)) {
        const env = received(seam, set);
        expect(env.EPAM_MODEL, `${seam} receives no model under '${set}'`).toBeTruthy();
      }
    }
  });

  it('THE MONEY BUG: a seam RECEIVES every env var its set declares', () => {
    // This is the assertion whose absence cost money. The set declared ANTHROPIC_BASE_URL and
    // the seam never got it, so calls went to the live API while MockServer sat idle.
    const missing: string[] = [];
    for (const set of Object.keys(REG.sets)) {
      const want = Object.keys(declared(set));
      if (!want.length) continue;
      for (const seam of SEAMS.slice(0, 4)) {
        const env = received(seam, set);
        for (const k of want) {
          if (!(k in env)) missing.push(`${set}/${seam}: ${k}`);
        }
      }
    }
    expect(missing, 'the set declares these and the seam never receives them').toEqual([]);
  });

  it('under the free set, a seam receives an endpoint that is NOT a vendor host', () => {
    const free = Object.keys(REG.sets).find((s) => /mockserver/i.test(s));
    if (!free) return;
    for (const seam of SEAMS.slice(0, 4)) {
      const env = received(seam, free);
      const base = env.ANTHROPIC_BASE_URL || '';
      expect(base, `${seam} has no redirect — it would call the live API`).toBeTruthy();
      expect(base, `${seam} points at a vendor host`).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
    }
  });

  it('swapping the set changes what the seam receives', () => {
    const seam = SEAMS[0];
    const a = received(seam, 'codemie').EPAM_MODEL;
    const b = received(seam, 'openrouter').EPAM_MODEL;
    expect(a, 'codemie must resolve a model').toBeTruthy();
    expect(b, 'openrouter must resolve a model').toBeTruthy();
    expect(a, 'the swap changed nothing the seam can see').not.toBe(b);
  });
});
