/**
 * EVERY SEAM CAN REACH ITS LADDER.
 *
 * Operator direction, 2026-08-15: every prompt must be wired into the ladder.
 *
 * A seam declares which ladder it climbs (`ladder: HIGHEST`), and a PROJECT declares what
 * that ladder contains (llm-settings.json → ladders.<tier>.modelLadder). Those are two
 * different files owned by two different parties, and nothing held them in step.
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
 * This is a DATA defect, not an engine one: a project is data, and the engine may require a
 * tier by name. What must not happen is a project silently missing one.
 *
 * Case is not the issue — seam-invocation.js and model-ladders.sh both upper-case the tier
 * before use, so `HIGHEST` and `highest` resolve identically. This test normalises the same
 * way rather than asserting a spelling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const PROJECTS = join(ROOT, 'orchestrations/projects');

const norm = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '_');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Tiers the ENGINE requires, taken from the registry rather than from a list kept by hand. */
function requiredTiers(): string[] {
  const r = readJson(REGISTRY);
  return [...new Set(
    Object.values(r.profiles || {})
      .map((v: any) => v && v.ladder)
      .filter(Boolean)
      .map((l: any) => norm(l)),
  )].sort();
}

/** Projects that declare model settings at all — one without them is a different question. */
function projectsWithSettings(): Array<{ name: string; file: string }> {
  return readdirSync(PROJECTS)
    .map((name) => ({ name, file: join(PROJECTS, name, 'llm-settings.json') }))
    .filter((p) => existsSync(p.file));
}

function declaredTiers(file: string): Record<string, any> {
  const doc = readJson(file);
  const ladders = doc.ladders || doc.tiers || {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(ladders)) out[norm(k)] = v;
  return out;
}

describe('the engine states which ladders it needs', () => {
  it('is not vacuous — seams do require ladders', () => {
    expect(requiredTiers().length).toBeGreaterThan(0);
  });

  it('every required tier is a real name, not an empty string', () => {
    for (const t of requiredTiers()) expect(t.length).toBeGreaterThan(0);
  });
});

describe('every project declares every ladder its seams will climb', () => {
  const required = requiredTiers();

  for (const p of projectsWithSettings()) {
    it(`${p.name} declares all of: ${required.join(', ')}`, () => {
      const declared = declaredTiers(p.file);
      const missing = required.filter((t) => !(t in declared));
      expect(missing,
        `${p.name} is missing ladder tier(s) ${missing.join(', ')} — every seam asking for `
        + 'one would run with no escalation chain, which seam-invocation reports and then '
        + 'continues past').toEqual([]);
    });

    it(`${p.name}'s declared ladders each contain at least one hop`, () => {
      // A tier that exists but is empty is the same failure with a friendlier name: the
      // seam resolves, finds nothing to climb to, and cannot escalate when it fails.
      const declared = declaredTiers(p.file);
      const empty = Object.entries(declared)
        .filter(([t]) => required.includes(t))
        .filter(([, v]: any) => !Array.isArray(v?.modelLadder) || v.modelLadder.length === 0)
        .map(([t]) => t);
      expect(empty, `${p.name} declares empty ladder(s): ${empty.join(', ')}`).toEqual([]);
    });
  }
});
