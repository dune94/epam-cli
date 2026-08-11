/**
 * A RETRY MUST ALWAYS RAISE EFFORT WHEN THE MODEL IS NOT ESCALATING. IT NEVER DID.
 *
 * Operator rule, 2026-08-10. Two independent defects prevented it:
 *
 * 1. THE MODEL OVERRIDE OVERWROTE THE RUNG. claude.sh set EPAM_REASONING_EFFORT per rung
 *    (low/medium/high/high), then at invocation time ran:
 *        [ -n "$_ov_effort" ] && export EPAM_REASONING_EFFORT="$_ov_effort"
 *    unconditionally, last. Every model in every live chain carries a modelOverrides entry, so
 *    the rung's escalation was discarded every time. Measured on run 20260810T024709Z: effort
 *    was 'high' on attempt 1 and on attempt 8 alike — rungs[].reasoningEffort was dead config.
 *
 * 2. A RUNG SPANS TWO ATTEMPTS. Effort was set once per rung, so the second attempt of a rung
 *    re-ran the identical model at the identical effort — the same input, expecting a different
 *    answer. That is precisely the case the rule exists for: when the model cannot move (mid-rung,
 *    or at the top of the chain where get_model_ladder_step returns nothing), effort is the only
 *    lever left.
 *
 * The fix treats a model override as a FLOOR (max_effort) rather than a final value, and bumps
 * effort one notch whenever an attempt runs the same model as the attempt before it.
 *
 * Every case below EXECUTES the real shell functions lifted from claude.sh.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

const HELPERS = ['effort_rank', 'max_effort', 'next_effort'].map(lift).join('\n');

const CFG = JSON.parse(readFileSync(
  join(__dirname, '../../../orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
/** The ladder is CONFIG — level names live in llm-settings.json, not in this test. */
const LADDER: string[] = CFG.effortLadder;
const TOP = LADDER[LADDER.length - 1];

function sh(body: string): string {
  return execFileSync('bash', ['-c',
    `set -u\nlog() { :; }\nexport EPAM_EFFORT_LADDER=${JSON.stringify(LADDER.join('|'))}\n${HELPERS}\n${body}`],
    { encoding: 'utf8' }).trim();
}

describe('the effort ladder has a defined order', () => {
  it('rank follows the configured ladder order', () => {
    const ranks = LADDER.map((_, i) => String(i)).join(' ');
    expect(sh(`echo "${LADDER.map((l) => `$(effort_rank ${l})`).join(' ')}"`)).toBe(ranks);
  });

  it('a level absent from the configured ladder has no rank', () => {
    expect(Number(sh('effort_rank not-a-level'))).toBeLessThan(0);
  });

  it('an unknown value ranks below everything, so it can never win a max()', () => {
    expect(Number(sh('effort_rank garbage'))).toBeLessThan(0);
    expect(sh('max_effort garbage low')).toBe('low');
  });
});

describe('DEFECT 1: a model override is a floor, not an overwrite', () => {
  it('an override RAISES a lower rung effort', () => {
    expect(sh('max_effort medium high')).toBe('high');
  });

  it('an override can no longer LOWER what the rung asked for', () => {
    // kimi-k2.5's override is 'medium'. At rung 3 (high) it used to drag effort back down.
    expect(
      sh('max_effort high medium'),
      'the rung escalated and the model override silently undid it',
    ).toBe('high');
  });

  it('the invocation site applies it as a floor, not an assignment', () => {
    const i = SRC.indexOf('_ov_effort=$(jq -r');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 900);
    expect(block).toContain('max_effort');
    expect(
      /\[ -n "\$_ov_effort" \] && export EPAM_REASONING_EFFORT="\$_ov_effort"/.test(block),
      'the unconditional overwrite is back — every rung escalation is dead again',
    ).toBe(false);
  });
});

describe('DEFECT 2: effort steps one notch per retry on the same model', () => {
  it('each level steps to the next one configured', () => {
    for (let i = 0; i < LADDER.length - 1; i++) {
      expect(sh(`next_effort ${LADDER[i]}`)).toBe(LADDER[i + 1]);
    }
  });

  it('the top of the ladder saturates rather than wrapping', () => {
    // Wrapping would silently DE-escalate a struggling story on its most expensive attempt.
    expect(sh(`next_effort ${TOP}`)).toBe(TOP);
  });

  it('the ladder is CONFIG — reconfiguring it changes the behaviour', () => {
    const out = execFileSync('bash', ['-c',
      `set -u\nlog() { :; }\nexport EPAM_EFFORT_LADDER="medium|high"\n${HELPERS}\nnext_effort medium`],
      { encoding: 'utf8' }).trim();
    expect(out, 'level names are baked into the code instead of read from config').toBe('high');
  });

  /** Runs the real escalation block for one attempt and reports the resulting effort. */
  function attempt(prevModel: string, model: string, effort: string, totalAttempts: number): string {
    const i = SRC.indexOf('# OPERATOR RULE (2026-08-10)');
    expect(i, 'the escalation block moved — re-anchor this test').toBeGreaterThan(-1);
    // LAST occurrence, not the first: the effort branch exports it before `continue`, so
    // anchoring to the first cuts the region mid-`if` and bash reports a syntax error.
    const region = SRC.slice(i, i + 9000);
    const end = i + region.lastIndexOf('export LAST_ATTEMPT_MODEL') + 'export LAST_ATTEMPT_MODEL'.length;
    // The lifted region now runs through the settings invariant, which uses `continue` and
    // reads _ov_temp_locked / LAST_ATTEMPT_SETTINGS — so the harness must supply the same
    // loop context and variables the real retry loop does, or bash aborts under `set -u`.
    return sh(
      `warning() { :; }; error() { :; }\n` +
      `_total_attempts=${totalAttempts}\nSTORY_MODEL=${JSON.stringify(model)}\n` +
      `LAST_ATTEMPT_MODEL=${JSON.stringify(prevModel)}\nEPAM_REASONING_EFFORT=${JSON.stringify(effort)}\n` +
      `EPAM_TEMPERATURE=0\nLAST_ATTEMPT_SETTINGS=""\n_ov_temp_locked=false\n` +
      `while true; do\n${SRC.slice(i, end)}\nbreak\ndone\n` +
      `printf '%s' "$EPAM_REASONING_EFFORT"`);
  }

  it('THE RULE: same model on a retry → effort goes up', () => {
    expect(
      attempt('MiniMax-M3', 'MiniMax-M3', 'medium', 2),
      'the second attempt of a rung re-ran the identical model at the identical effort',
    ).toBe('high');
  });

  it('a DIFFERENT model on a retry does NOT bump effort — the model is the escalation', () => {
    expect(attempt('MiniMax-M3', 'z-ai/glm-5.2', 'medium', 2)).toBe('medium');
  });

  it('the first attempt of a story never bumps', () => {
    expect(attempt('', 'MiniMax-M3', 'medium', 1)).toBe('medium');
  });

  it('at the top of the chain, where the model cannot move, effort still rises', () => {
    // get_model_ladder_step returns nothing at the ceiling; without this the story re-ran the
    // same model at the same effort until its retries were gone.
    expect(attempt('moonshotai/kimi-k3', 'moonshotai/kimi-k3', 'medium', 6)).toBe('high');
  });

  it('high steps to the level above it, which the top models support', () => {
    expect(attempt('moonshotai/kimi-k3', 'moonshotai/kimi-k3', 'high', 8)).toBe(LADDER[LADDER.indexOf('high') + 1]);
  });

  it('at the very top it saturates instead of resetting', () => {
    expect(attempt('moonshotai/kimi-k3', 'moonshotai/kimi-k3', TOP, 10)).toBe(TOP);
  });
});

describe('rung 0 is never "low"', () => {
  it('the code fallback for rung 0 is medium', () => {
    expect(
      SRC,
      'a story with no rung-0 config starts at the weakest effort setting there is',
    ).toContain('EPAM_RUNG0_REASONING_EFFORT:-medium');
  });

  it('no rung falls back to low', () => {
    expect(SRC).not.toMatch(/EPAM_RUNG[0-3]_REASONING_EFFORT:-low/);
  });

  it('the project config agrees', () => {
    const cfg = JSON.parse(readFileSync(
      join(__dirname, '../../../orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
    const efforts = cfg.rungs.map((r: { reasoningEffort: string }) => r.reasoningEffort);
    expect(efforts, `rung efforts were ${efforts.join(', ')}`).not.toContain('low');
  });

  it('effort never decreases as rungs climb', () => {
    const cfg = JSON.parse(readFileSync(
      join(__dirname, '../../../orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const seq = cfg.rungs
      .sort((a: { rung: number }, b: { rung: number }) => a.rung - b.rung)
      .map((r: { reasoningEffort: string }) => rank[r.reasoningEffort]);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i], `rung ${i} is lower effort than rung ${i - 1}`).toBeGreaterThanOrEqual(seq[i - 1]);
    }
  });
});

/**
 * THE HARD INVARIANT: no two back-to-back invocations may share a settings tuple.
 *
 * Operator rule, 2026-08-10: "We cannot have two back to back invocations with the same settings
 * after retry — that is a pure violation and a waste."
 *
 * Effort escalation covers most retries, but at effort=high with the model at the top of its
 * chain there is nothing left to raise, and the attempt becomes a byte-for-byte repeat of the
 * one that just failed. Temperature is the remaining lever; when even that is exhausted the
 * story is abandoned rather than burning budget on a guaranteed repeat.
 */
describe('no two consecutive attempts share a settings tuple', () => {
  /**
   * Runs the real invariant. Effort escalates FIRST because it is the only lever every model in
   * the ladder honours; temperature is model-specific and Kimi K3 fixes it at 1.0 on Moonshot's
   * platform, where a temperature bump changes nothing and the identical attempt runs anyway.
   */
  function invariant(prev: string, model: string, effort: string, temp: string,
                     attempts: number, tempLocked = false): string {
    const i = SRC.indexOf('# HARD INVARIANT (operator rule, 2026-08-10)');
    expect(i, 'the invariant block moved — re-anchor this test').toBeGreaterThan(-1);
    const region = SRC.slice(i, i + 9000);
    const end = i + region.lastIndexOf('export LAST_ATTEMPT_MODEL') + 'export LAST_ATTEMPT_MODEL'.length;
    return sh(
      `warning() { :; }\n` +
      `_total_attempts=${attempts}\nSTORY_MODEL=${JSON.stringify(model)}\n` +
      `EPAM_REASONING_EFFORT=${JSON.stringify(effort)}\nEPAM_TEMPERATURE=${JSON.stringify(temp)}\n` +
      `LAST_ATTEMPT_SETTINGS=${JSON.stringify(prev)}\nLAST_ATTEMPT_MODEL=""\n` +
      // ONE pass. `continue` in the real code returns to the agent invocation, not to this
      // block — looping here would escalate twice and report a state the pipeline never reaches.
      // The abandon path is detected via the error() it emits immediately before `break`.
      `_ov_temp_locked=${tempLocked}\n_abandon=0\nerror() { _abandon=1; }\n` +
      `for _once in 1; do\n${SRC.slice(i, end)}\ndone\n` +
      `if [ "$_abandon" = 1 ]; then printf 'ABANDONED'; else printf '%s' "$EPAM_REASONING_EFFORT|$EPAM_TEMPERATURE"; fi`);
  }

  const tuple = (m: string, e: string, t: string) => `${m}|${e}|${t}`;

  it('effort escalates first — the lever every model honours', () => {
    const prev = tuple('moonshotai/kimi-k3', 'high', '0.5');
    expect(
      invariant(prev, 'moonshotai/kimi-k3', 'high', '0.5', 6),
      'temperature was bumped on a model that may ignore it, leaving the attempt identical',
    ).toBe(`${LADDER[LADDER.indexOf('high') + 1]}|0.5`);
  });

  it('temperature moves only once effort is at the top AND the model allows it', () => {
    const prev = tuple('z-ai/glm-5.2', TOP, '0.5');
    expect(invariant(prev, 'z-ai/glm-5.2', TOP, '0.5', 6)).toBe(`${TOP}|0.70`);
  });

  it('a temperature-locked model at the effort ceiling is ABANDONED, not repeated', () => {
    // Kimi K3 on Moonshot: temperature is fixed, so bumping it changes nothing and the next
    // attempt would be byte-for-byte identical to the one that just failed.
    const prev = tuple('moonshotai/kimi-k3', TOP, '1.0');
    expect(invariant(prev, 'moonshotai/kimi-k3', TOP, '1.0', 8, true)).toContain('ABANDON');
  });

  it('settings that already differ are left alone', () => {
    const prev = tuple('MiniMax-M3', 'medium', '0');
    expect(invariant(prev, 'z-ai/glm-5.2', 'medium', '0', 4)).toBe('medium|0');
  });

  it('the first attempt is never touched', () => {
    expect(invariant('', 'MiniMax-M3', 'medium', '0', 1)).toBe('medium|0');
  });
});
