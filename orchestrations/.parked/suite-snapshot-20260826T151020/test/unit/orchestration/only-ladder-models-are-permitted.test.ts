/**
 * ONLY LADDER MODELS ARE PERMITTED. NO EXCEPTIONS. (Operator rule, 2026-08-10.)
 *
 * The model fallback chain ended at a hardcoded default:
 *
 *     STORY_MODEL="${story_model:-${runtime_model:-gpt-5-codex}}"
 *
 * `gpt-5-codex` appears in NO configured ladder. A story that landed on it could not escalate at
 * all, because escalation walks a chain and that model is not a link in any chain — every rung
 * would find no next step and hold it there for all eight attempts.
 *
 * Observed live, run 20260810T115915: `PRD model is 'gpt-5-codex'` while the PRD plainly declared
 * `model: MiniMax-M3`. It went unnoticed for the entire run because the persisted-model resume
 * happened to restore the right one — the defect was masked by an unrelated fix.
 *
 * The rule is enforced by REFUSAL, not substitution. Silently swapping in a "reasonable" model is
 * exactly how the wrong one ran for a full run with nobody seeing it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, and every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const CFG = stackSettings(defaultStack());
const TIERS = Object.keys(CFG.ladders);

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

/** Every model named in the project's configured ladders. */
const PERMITTED: string[] = [...new Set(
  TIERS.flatMap((t) => (CFG.ladders[t].modelLadder as Array<{ from: string; to: string }>)
    .flatMap((e) => [e.from, e.to])))];

const PRELUDE = [
  `export EPAM_LADDER_TIERS=${JSON.stringify(TIERS.join('|'))}`,
  ...TIERS.map((t) =>
    `export EPAM_MODEL_LADDER_${t.toUpperCase()}=${JSON.stringify(
      (CFG.ladders[t].modelLadder as Array<{ from: string; to: string }>)
        .map((e) => `${e.from}=${e.to}`).join('|'))}`),
  'error() { echo "ERR:$*"; }',
  lift('ladder_models'),
  lift('assert_ladder_model'),
].join('\n');

/** Runs the real guard. Returns exit status and what it printed. */
function assertModel(model: string): { ok: boolean; out: string } {
  const res = execFileSync('bash', ['-c',
    `${PRELUDE}\nif assert_ladder_model ${JSON.stringify(model)} "test"; then echo "RC=0"; else echo "RC=1"; fi`],
    { encoding: 'utf8' });
  return { ok: /RC=0/.test(res), out: res };
}

describe('the permitted set is the ladder, derived from config', () => {
  it('lists every model named in every configured tier', () => {
    const listed = execFileSync('bash', ['-c', `${PRELUDE}\nladder_models`], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    expect(listed.sort()).toEqual([...PERMITTED].sort());
  });

  it('the set is non-trivial — otherwise every assertion below is vacuous', () => {
    expect(PERMITTED.length).toBeGreaterThan(2);
  });
});

describe('THE RULE: a model in the ladder is permitted', () => {
  for (const m of PERMITTED) {
    it(`${m} is allowed`, () => {
      expect(assertModel(m).ok, `${m} is in the ladder but was refused`).toBe(true);
    });
  }
});

describe('THE RULE: anything else is REFUSED, not substituted', () => {
  it('THE LIVE DEFECT: gpt-5-codex is refused', () => {
    const r = assertModel('gpt-5-codex');
    expect(
      r.ok,
      'the hardcoded fallback ran for a whole run — a model in no chain, so no rung could escalate',
    ).toBe(false);
  });

  it('an empty model is refused rather than treated as "use the default"', () => {
    expect(assertModel('').ok).toBe(false);
  });

  it('a plausible-but-unconfigured model is refused', () => {
    expect(assertModel('claude-sonnet-4-6').ok).toBe(false);
  });

  it('a near-miss on a real ladder name is refused', () => {
    // Substring/prefix matching would let this through; membership must be exact.
    expect(assertModel(`${PERMITTED[0]}-turbo`).ok).toBe(false);
    expect(assertModel(PERMITTED[0].slice(0, -1)).ok).toBe(false);
  });

  it('the refusal names the model AND the permitted set, so the fix is obvious', () => {
    const r = assertModel('gpt-5-codex');
    expect(r.out).toContain('gpt-5-codex');
    expect(r.out).toContain(PERMITTED[0]);
  });

  it('it REFUSES rather than silently swapping in a ladder model', () => {
    // Substitution is how the wrong model ran unnoticed. The guard must not "helpfully" fix it.
    const fn = lift('assert_ladder_model');
    expect(fn).not.toMatch(/STORY_MODEL=/);
  });
});

describe('the resolution path enforces it', () => {
  it('the hardcoded gpt-5-codex fallback is gone from model resolution', () => {
    const i = SRC.indexOf('STORY_MODEL="${story_model:-${runtime_model:-');
    expect(i, 'the resolution line moved').toBeGreaterThan(-1);
    expect(
      SRC.slice(i, i + 120),
      'the fallback still ends at a model that is in no ladder',
    ).not.toContain('gpt-5-codex');
  });

  it('resolution calls the guard and refuses on failure', () => {
    const i = SRC.indexOf('STORY_MODEL="${story_model:-${runtime_model:-');
    const block = SRC.slice(i, i + 700);
    expect(block).toContain('assert_ladder_model');
    expect(block, 'it warns but proceeds — the rule has no exceptions').toMatch(/return 1/);
  });
});

describe('THE PARSE BUG: a pipe-delimited tier list is split on the pipe', () => {
  it('multiple tiers each contribute their own models', () => {
    // The outer loop lacked IFS='|', so "high|medium|highest" stayed ONE token, the variable
    // name became EPAM_MODEL_LADDER_HIGH|MEDIUM|HIGHEST, and the permitted set came back EMPTY.
    // Written first, this fails immediately; written after, it took a live run to notice.
    const listed = execFileSync('bash', ['-c', `${PRELUDE}\nladder_models`], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    expect(listed.length, 'the tier list did not split — permitted set is empty').toBeGreaterThan(2);
    // A model unique to a NON-first tier must be present, or only one tier was read.
    const firstTierModels = new Set((CFG.ladders[TIERS[0]].modelLadder as Array<{from:string;to:string}>)
      .flatMap((e) => [e.from, e.to]));
    const fromOtherTier = PERMITTED.find((m) => !firstTierModels.has(m));
    if (fromOtherTier) {
      expect(listed, `only the first tier was read — ${fromOtherTier} is missing`).toContain(fromOtherTier);
    }
  });

  it('a single configured tier still parses', () => {
    const one = execFileSync('bash', ['-c',
      `export EPAM_LADDER_TIERS="high"\n` +
      `export EPAM_MODEL_LADDER_HIGH="A=B|B=C"\nerror() { :; }\n` +
      `${lift('ladder_models')}\nladder_models`], { encoding: 'utf8' }).trim().split('\n');
    expect(one.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('THE FAIL-OPEN BUG: a parse failure must not permit everything', () => {
  it('tiers configured but unparseable REFUSES rather than allowing all', () => {
    // This is what made the IFS bug invisible: empty permitted set hit the "nothing to enforce"
    // branch, so the guard reported success while enforcing nothing.
    const res = execFileSync('bash', ['-c',
      `export EPAM_LADDER_TIERS="high|medium"\n` +
      `error() { echo "ERR:$*"; }\n${lift('ladder_models')}\n${lift('assert_ladder_model')}\n` +
      `if assert_ladder_model "gpt-5-codex" "test"; then echo "RC=0"; else echo "RC=1"; fi`],
      { encoding: 'utf8' });
    expect(/RC=1/.test(res), 'an unparseable ladder permitted a non-ladder model').toBe(true);
    expect(res).toMatch(/failed to parse|no models could be read/i);
  });
});

describe('no ladder configured means nothing to enforce', () => {
  it('the guard is inert rather than blocking when no ladder exists', () => {
    // A project with no ladder must not be bricked by this rule.
    const res = execFileSync('bash', ['-c',
      `error() { :; }\n${lift('ladder_models')}\n${lift('assert_ladder_model')}\n` +
      `if assert_ladder_model "anything" "test"; then echo "RC=0"; else echo "RC=1"; fi`],
      { encoding: 'utf8' });
    expect(/RC=0/.test(res)).toBe(true);
  });
});
