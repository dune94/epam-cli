/**
 * A DECLARED SET IS COMPLETE, OR IT IS A TRAP.
 *
 * A set whose settings file has no ladders resolves to no escalation chain, and
 * seam-invocation.js reports an unresolvable tier to stderr and CONTINUES — every seam would
 * run with none, exactly as twenty hello-dolly seams once did. That is why the CodeMie set was
 * held back until its ladders existed: an undeclared set fails loudly, an empty one silently.
 *
 * This asserts the set is whole BEFORE anything runs on it: every tier reachable, every model
 * configured, every knob the runner names resolvable, and no dead end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const CFG = join(ROOT, 'orchestrations/config');
const REG = JSON.parse(readFileSync(join(CFG, 'provider-sets.json'), 'utf8'));

const CODEMIE = Object.entries<any>(REG.sets).find(([, c]) => /codemie/i.test(c.settingsFile));

describe('the codemie set is complete', () => {
  it('is declared in the registry', () => {
    expect(CODEMIE, 'no set points at a codemie settings file').toBeTruthy();
  });

  const file = CODEMIE ? join(CFG, CODEMIE[1].settingsFile) : '';
  const j = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

  it('its settings file exists and declares ladders — an empty set fails SILENTLY', () => {
    expect(j, `missing settings file: ${file}`).toBeTruthy();
    expect(Object.keys(j.ladders || {}).length).toBeGreaterThan(0);
  });

  it('declares a tier order covering exactly its tiers', () => {
    expect([...(j.ladderTierOrder || [])].sort()).toEqual(Object.keys(j.ladders).sort());
  });

  it('every tier has a startModel, and that model can escalate — no dead ends', () => {
    for (const [tier, v] of Object.entries<any>(j.ladders)) {
      expect(v.startModel, `${tier}: no startModel`).toBeTruthy();
      const froms = new Set((v.modelLadder || []).map((h: any) => h.from));
      expect(froms.has(v.startModel), `${tier}: ${v.startModel} is a dead end`).toBe(true);
    }
  });

  it('EVERY model named anywhere in a ladder resolves a modelOverrides entry', () => {
    // A model with no entry runs unconfigured — no cap, no compaction, no cache ttl. That is
    // the state every Claude model was in, and it is how 1,486 turns happened.
    const models = new Set<string>();
    for (const v of Object.values<any>(j.ladders)) {
      models.add(v.startModel);
      for (const h of v.modelLadder || []) { models.add(h.from); models.add(h.to); }
    }
    const subs = Object.values<any>(j.modelOverrides || {}).map((o) => o.matchSubstring).filter(Boolean);
    const unconfigured = [...models].filter((m) => !subs.some((sub: string) => m.includes(sub)));
    expect(unconfigured, 'these models would run with no budget at all').toEqual([]);
  });

  it('declares a runner, and EVERY setting it names is defined for every model', () => {
    const runners = j.runners || {};
    expect(Object.keys(runners).length, 'the set declares no runner — its knobs reach nothing').toBeGreaterThan(0);
    const runner = Object.values<any>(runners)[0];
    const named = [...new Set([...Object.values<any>(runner.env || {}), ...Object.values<any>(runner.flags || {})])];
    expect(named.length).toBeGreaterThan(0);

    // A declaration naming a setting nothing defines is a SILENT NO-OP — the exact defect
    // this layering exists to remove.
    const perModel = Object.values<any>(j.modelOverrides || {});
    const rungKeys = new Set<string>();
    for (const v of Object.values<any>(j.ladders)) for (const r of v.rungs || []) Object.keys(r).forEach((k) => rungKeys.add(k));
    const definable = new Set<string>([...rungKeys, ...perModel.flatMap((o) => Object.keys(o))]);
    const orphans = named.filter((n) => !definable.has(n) && n !== 'timeoutSeconds');
    expect(orphans, 'the runner names settings nothing declares — they would pass nothing').toEqual([]);
  });

  it('the fallback is a real model that is NOT the top rung of every tier', () => {
    const fb = (j.finalFallback || {}).model;
    expect(fb, 'no post-exhaustion fallback declared').toBeTruthy();
    const ceilings = Object.values<any>(j.ladders).map((v) => {
      const tos = (v.modelLadder || []).map((h: any) => h.to);
      const froms = new Set((v.modelLadder || []).map((h: any) => h.from));
      return tos.find((t: string) => !froms.has(t));
    });
    expect(ceilings.every((c) => c === fb), 'a fallback equal to every ceiling is a no-op').toBe(false);
  });
});
