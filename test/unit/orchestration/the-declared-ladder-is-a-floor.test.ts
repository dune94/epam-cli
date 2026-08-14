/**
 * AN ARCHETYPE'S DECLARED LADDER IS A FLOOR, AND `highest` REACHES THE HIGHEST LADDER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION. Found in the metrolinx run of 2026-08-14.
 *
 * The operator asked for the writer on the highest ladder. The story-writer archetype declares
 * `ladder: HIGHEST` and nothing read it: the tier came from the story record —
 * `.ladderTier // "medium"` — which the CPA pre-pass had written as "high". So a declaration made
 * deliberately was overridden by a value an automated pass produced, silently, every run.
 *
 * Underneath that sat a second defect. The branch that maps a tier to a ladder had no `highest`
 * case at all:
 *
 *     case "$tier" in
 *       high) ladder="${EPAM_MODEL_LADDER_HIGH:-}" ;;
 *       *)    ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
 *     esac
 *
 * so a story on tier `highest` would have fallen through to the MEDIUM ladder — the opposite of
 * what it asked for, and the kind of failure nobody notices because a ladder is still present.
 *
 * The rule: the archetype's ladder is the floor, the story may raise it, nothing may lower it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Execute the REAL tier/ladder resolution with a given story tier and archetype floor. */
function resolve(opts: { storyTier?: string; archetypeLadder?: string; order?: string }): string {
  const src = readFileSync(ORCH, 'utf8');
  const at = src.indexOf('_resolve_ladder_tier()');
  expect(at, 'the tier resolver is missing — this test is anchored on it').toBeGreaterThan(0);
  const fn = src.slice(at, src.indexOf('\n}', at) + 2);

  const script = `set -uo pipefail
log() { :; }
EPAM_MODEL_LADDER_TIER_ORDER=${JSON.stringify(opts.order ?? 'medium high highest')}
_story_archetype_ladder() { printf '%s' ${JSON.stringify(opts.archetypeLadder ?? '')}; }
${fn}
_resolve_ladder_tier ${JSON.stringify(opts.storyTier ?? '')}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

describe('THE ARCHETYPE IS A FLOOR', () => {
  it('a story tier BELOW the archetype floor is raised to the floor', () => {
    // THE LIVE CASE: story says "high", story-writer declares HIGHEST, the writer ran "high".
    expect(resolve({ storyTier: 'high', archetypeLadder: 'HIGHEST' })).toBe('highest');
  });

  it('a story tier ABOVE the floor is kept — the CPA may still raise a hard story', () => {
    expect(resolve({ storyTier: 'highest', archetypeLadder: 'HIGH' })).toBe('highest');
  });

  it('equal tiers resolve to that tier', () => {
    expect(resolve({ storyTier: 'high', archetypeLadder: 'HIGH' })).toBe('high');
  });

  it('no archetype floor falls back to the story tier', () => {
    expect(resolve({ storyTier: 'high', archetypeLadder: '' })).toBe('high');
  });

  it('no story tier and no floor is medium, exactly as before', () => {
    expect(resolve({})).toBe('medium');
  });

  it('an unknown tier name never silently becomes medium when a floor exists', () => {
    // Absent must not mean lowest: a typo in the PRD should not quietly downgrade the writer.
    expect(resolve({ storyTier: 'nonsense', archetypeLadder: 'HIGHEST' })).toBe('highest');
  });
});

describe('THE ENGINE HOLDS NO TIER VOCABULARY', () => {
  it('the resolver names no tier — ordering comes from the declaration', () => {
    // An engine that ranks `highest > high > medium` embeds a project's vocabulary in shared code
    // and silently ranks an unknown tier lowest. lib/model-ladders.sh already refuses to list tier
    // names for exactly this reason; the reader must not reintroduce them.
    const src = readFileSync(ORCH, 'utf8');
    const at = src.indexOf('_resolve_ladder_tier() {');
    const body = src.slice(at, src.indexOf('\n}', at))
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const t of ['highest', 'high', 'medium']) {
      expect(body, `the resolver hardcodes the tier name '${t}'`).not.toContain(t);
    }
  });

  it('the ladder variable is DERIVED from the tier, not selected by a branch', () => {
    // The branch this replaced knew only `high` and a medium default, so a story on any other
    // tier received the MEDIUM ladder while still appearing to have one.
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the tier-to-ladder branch is back')
      .not.toMatch(/case "\$tier" in[\s\S]{0,200}EPAM_MODEL_LADDER_HIGH/);
    expect(src, 'the ladder variable is not derived the way the exporter names it')
      .toMatch(/EPAM_MODEL_LADDER_\$\(printf '%s' "\$tier" \| tr/);
  });

  it('a tier the settings declare needs no engine change to work', () => {
    // The contract that matters: adding a tier is a config edit.
    expect(resolve({ storyTier: 'experimental', archetypeLadder: 'HIGH',
                     order: 'medium high experimental' })).toBe('experimental');
  });
});

describe('NO DECLARED ORDER MEANS NO FLOOR', () => {
  it('without an order the story tier is used unchanged', () => {
    // A project that has not declared an order must see no silent change in behaviour.
    expect(resolve({ storyTier: 'high', archetypeLadder: 'HIGHEST', order: '' })).toBe('high');
  });
});
