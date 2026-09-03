/**
 * THE PROJECT DECLARES ITS EFFORT VOCABULARY, AND A DECLARED AGENT OUTRANKS A PROPOSAL.
 *
 * WRITTEN BEFORE THE FIX. RED WHEN WRITTEN.
 *
 * TWO SEPARATE DEFECTS, ONE CAUSE — the engine holding vocabulary the project already declares.
 *
 * 1. EFFORT ORDER IS HARDCODED IN FOUR PLACES.
 *
 *      case "$effort" in low) _rank_cur=1 ;; high) _rank_cur=3 ;; *) _rank_cur=2 ;; esac
 *
 *    The project declares `effortLadder: ["low","medium","high","max"]` in its llm-settings —
 *    FOUR tiers, ascending. The engine knows three. A story declared "max" falls through to the
 *    `*` branch and ranks 2, BELOW "high", so the highest effort a project can ask for is
 *    silently treated as mid. Adding a tier to the declaration changes nothing until four case
 *    statements are edited by hand.
 *
 *    Note this is a DIFFERENT vocabulary from `ladderTierOrder` (["medium","high","highest"]),
 *    which orders model chains, not reasoning effort. Ranking one with the other would be wrong.
 *
 * 2. CPA OVERRIDES EVERY AGENT, INCLUDING ONES WITH THEIR OWN DECLARED SETTINGS.
 *
 *    The CPA pre-pass proposes an effort tier and the writer path adopts it whenever it ranks
 *    higher. Nothing lets an archetype say "my effort is settled". The operator's rule: a
 *    declared agent is authoritative and a proposal cannot move it.
 *
 *    The protected set must be DERIVED — an archetype that declares `effort` in
 *    invocation-profiles.json is protected, and one that declares nothing keeps today's
 *    behaviour. No list of agent names anywhere in the engine.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const CLAUDE_SH = join(SCRIPTS, 'claude.sh');
const PROJECTS = join(ROOT, 'orchestrations/projects');

/** Every effort vocabulary any project declares, with its order. */
function declaredEffortLadders(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/llm-settings\.json$/.test(e.name)) continue;
      try {
        const d = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(d.effortLadder) && d.effortLadder.length) out.push(d.effortLadder.map(String));
      } catch { /* a project without settings contributes nothing */ }
    }
  };
  if (existsSync(PROJECTS)) walk(PROJECTS);
  return out;
}

const LADDERS = declaredEffortLadders();
const src = readFileSync(CLAUDE_SH, 'utf8');

describe('THE DECLARATION EXISTS', () => {
  it('at least one project declares an effort ladder', () => {
    // Without this, every assertion below passes for the wrong reason.
    expect(LADDERS.length, 'no project declares effortLadder — nothing to rank against').toBeGreaterThan(0);
  });
});

describe('EFFORT ORDER COMES FROM THE DECLARATION', () => {
  it('the engine does not rank effort tiers by literal', () => {
    // The four case statements that hardcode low=1/high=3 and default everything else to 2.
    const literalRanking = [...src.matchAll(/case\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+in\s+low\)\s*_rank/g)];
    expect(literalRanking.length,
      `${literalRanking.length} site(s) rank effort by hardcoded tier names. The order is declared ` +
      `as effortLadder; an engine that carries its own copy silently disagrees with it`)
      .toBe(0);
  });

  it('every tier the project declares is rankable, including the highest', () => {
    // `max` is declared and the engine's case statements do not mention it, so it ranks below
    // `high`. Drive the resolver and prove each declared tier ranks above the one before it.
    for (const ladder of LADDERS) {
      const script = `
        set -uo pipefail
        export EPAM_EFFORT_LADDER='${ladder.join(' ')}'
        source '${join(SCRIPTS, 'lib/effort-order.sh')}' 2>/dev/null || { echo "NO_LIB"; exit 0; }
        for t in ${ladder.join(' ')}; do printf '%s=%s\\n' "$t" "$(effort_rank "$t")"; done
      `;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      const out = r.stdout || '';
      expect(out, 'lib/effort-order.sh does not exist — effort order has no single home').not.toMatch(/NO_LIB/);

      const ranks = ladder.map((t) => {
        const m = out.match(new RegExp(`^${t}=(-?\\d+)$`, 'm'));
        return m ? Number(m[1]) : NaN;
      });
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i],
          `declared effort "${ladder[i]}" does not rank above "${ladder[i - 1]}" ` +
          `(${ranks[i]} vs ${ranks[i - 1]}) — the declaration is not being honoured`)
          .toBeGreaterThan(ranks[i - 1]);
      }
    }
  });
});

describe('CPA CANNOT OVERRIDE AN AGENT THAT DECLARES ITS OWN EFFORT', () => {
  it('the writer path consults the archetype before adopting a CPA proposal', () => {
    // The protection must be keyed off the archetype's own declaration, so the protected set is
    // derived. A list of agent names in the engine would be the same defect in a new place.
    const cpaBlock = src.slice(src.indexOf('EffortTier[CPA]') - 2000, src.indexOf('EffortTier[CPA]') + 500);
    expect(/archetype|declared_effort|profile.*effort|_agent_declared/i.test(cpaBlock),
      'the CPA effort upgrade adopts a proposal without consulting what the agent declares — ' +
      'an agent with settled effort can still be moved by a proposal')
      .toBe(true);
  });

  it('no agent name is used as a policy value or lookup key', () => {
    // Derived, never listed — with one exception that is not a loophole.
    //
    // A seam has to be able to say WHICH SEAM IT IS: `_ANALYST_SEAM="impl-failure-analyst"`,
    // `_profile_key="prd-change-reviewer"`, `seam_ladder_export "story-writer"`. That single
    // self-declaration is the anchor everything else derives from, and it belongs in exactly one
    // place per seam — the defect it prevents is two copies drifting apart, which happened the
    // same day this was written when one call site said "failure-analyst", a name the registry
    // does not contain, and the analyst silently stopped escalating.
    //
    // What is forbidden is a name used as a VALUE: a fallback default, a lookup key, or a
    // hardcoded branch. Those decide policy for a named role from inside shared code.
    const names = Object.keys(
      JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles || {},
    );
    const SELF_DECLARATION = (n: string) => new RegExp(
      `(_SEAM[A-Z_]*=|_profile_key=|_ANALYST_SEAM=|seam_ladder_export\\s+)["'\`]${n}["'\`]`,
    );
    const leaked: string[] = [];
    for (const n of names) {
      const all = [...src.matchAll(new RegExp(`["'\`]${n}["'\`]`, 'g'))];
      if (!all.length) continue;
      // Count occurrences that are NOT a self-declaration.
      const declarations = [...src.matchAll(new RegExp(SELF_DECLARATION(n).source, 'g'))].length;
      if (all.length > declarations) leaked.push(n);
    }
    expect(leaked,
      `the engine uses agent name(s) ${leaked.join(', ')} as a value or lookup key — policy for a ` +
      `named role must come from that role's declaration, not from shared code`)
      .toHaveLength(0);
  });
});
