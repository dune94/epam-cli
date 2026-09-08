/**
 * EVERY PROVIDER SET DECLARES ITS OWN PLAN PASS — none inherits one.
 *
 * llm-handler.sh reads ${EPAM_PLAN_EXECUTE:-1}, so an overlay that says nothing still gets a
 * plan-then-answer round on every call. That is a REASONING behaviour and a 2.5x per-call cost
 * (measured claude-haiku-4-5, 2026-08-26: $0.04947 with, $0.01969 without, the discarded plan
 * being 55% of the call) arrived at by an absence rather than a decision.
 *
 * It also made runs incomparable with neither file saying so: the four claude overlays set 0
 * while codemie, openrouter and mockserver silently took the default of 1, so a cost delta
 * between two stacks mixed the change under test with a whole extra model pass. Operator,
 * 2026-09-08: "Codemie must have its own setting it cannot just fall through that is a terrible
 * design."
 *
 * This asserts DECLARATION, not a particular value — which stack plans is an operator decision
 * that may change. What may not change is a set acquiring the behaviour by default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PROJECTS = join(REPO_ROOT, 'orchestrations/projects');
const SETS_FILE = join(REPO_ROOT, 'orchestrations/config/provider-sets.json');

/** The sets the engine knows about — read, never listed here, so a new one is covered on arrival. */
function knownSets(): string[] {
  const j = JSON.parse(readFileSync(SETS_FILE, 'utf8'));
  return Object.keys(j.sets || j);
}

function overlays(): { file: string; project: string; set: string; declared: string | null }[] {
  const out: { file: string; project: string; set: string; declared: string | null }[] = [];
  for (const p of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, p);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^config\.([a-z0-9-]+)\.env$/.exec(f);
      if (!m) continue;
      const body = readFileSync(join(dir, f), 'utf8');
      const d = /^EPAM_PLAN_EXECUTE=(.*)$/m.exec(body);
      out.push({ file: `${p}/${f}`, project: p, set: m[1], declared: d ? d[1].trim() : null });
    }
  }
  return out;
}

describe('every provider set declares its plan pass', () => {
  it('GUARD: overlays are found, and the hub really does default the value', () => {
    const all = overlays();
    expect(all.length, 'no provider-set overlays found — this suite proves nothing')
      .toBeGreaterThan(3);
    const hub = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/llm-handler.sh'), 'utf8');
    expect(hub, 'the hub no longer defaults EPAM_PLAN_EXECUTE, so the fall-through this guards '
      + 'against may have moved').toContain('${EPAM_PLAN_EXECUTE:-1}');
  });

  it('NO OVERLAY FALLS THROUGH to the hub default', () => {
    const missing = overlays().filter((o) => o.declared === null).map((o) => o.file);
    expect(missing, `these overlays inherit the plan pass instead of declaring it: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('EVERY KNOWN SET HAS AN OVERLAY in every project that has any', () => {
    const all = overlays();
    const sets = knownSets();
    const byProject = new Map<string, Set<string>>();
    for (const o of all) {
      if (!byProject.has(o.project)) byProject.set(o.project, new Set());
      byProject.get(o.project)!.add(o.set);
    }
    const gaps: string[] = [];
    for (const [project, have] of byProject) {
      for (const s of sets) if (!have.has(s)) gaps.push(`${project}/config.${s}.env`);
    }
    expect(gaps, `a known provider set has no overlay, so it runs on whatever the hub defaults `
      + `to: ${gaps.join(', ')}`).toEqual([]);
  });

  it('the declared value is a boolean the hub understands', () => {
    const bad = overlays().filter((o) => o.declared !== null && !['0', '1'].includes(o.declared))
      .map((o) => `${o.file}=${o.declared}`);
    expect(bad, `EPAM_PLAN_EXECUTE is compared to "1" as a string; anything else silently means `
      + `off: ${bad.join(', ')}`).toEqual([]);
  });
});
