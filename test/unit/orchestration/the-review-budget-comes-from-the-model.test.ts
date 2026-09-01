/**
 * THE REVIEW BUDGET IS THE MODEL'S CAPACITY, NOT A NUMBER ANYONE PICKED.
 *
 * How much canonical+derived roster text one review call may carry went through three wrong shapes
 * before this one:
 *
 *   1. a literal 60000 in spec-mode-runner.js, measured against nothing
 *   2. a floor of 4000 beside it, also invented — replacing one guess with another
 *   3. reviewBatchChars declared on the SEAM, which is wrong the moment the seam escalates: a
 *      ladder moves it from haiku to sonnet to opus, and one figure cannot describe all three
 *
 * The constraint was never a property of the seam. It is the model's input capacity, and the ladder
 * already declares it per model — autoCompressAt, the guard below the context window — alongside
 * charsPerToken for callers that measure payloads in characters.
 *
 * budget = autoCompressAt x charsPerToken, for the model actually resolved. No safety factor:
 * autoCompressAt IS the guard (150000 against a 200000 window).
 *
 * WHY IT MATTERS: at 60000 the ~276KB roster split into six model calls, and the aggregation failed
 * the whole review whenever any one of them answered off-schema. Live 2026-09-01 that halted the
 * metrolinx mint after eighteen calls. Read from the model, every rung — including haiku — carries
 * the roster in ONE call, so the failure has nowhere to occur.
 *
 * NO DEFAULT ANYWHERE: an undeclared model, autoCompressAt or charsPerToken is refused by name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CONFIG = join(REPO, 'orchestrations/config');
const RUNNER = readFileSync(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const PROFILES = join(REPO, 'orchestrations/agents/profiles.json');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');

const sets = readdirSync(CONFIG).filter((f) => /^llm-defaults\..*\.json$/.test(f));
const rosterChars = JSON.stringify(
  (() => { const j = JSON.parse(readFileSync(PROFILES, 'utf8')); return j.agents || j.profiles || j; })(),
).length * 2;

describe('the review budget comes from the model', () => {
  it('the ladder declares an input capacity for every model that has a compress guard', () => {
    let checked = 0;
    for (const f of sets) {
      const j = JSON.parse(readFileSync(join(CONFIG, f), 'utf8'));
      for (const [name, ov] of Object.entries<any>(j.modelOverrides || {})) {
        if (name.startsWith('$') || !ov || typeof ov !== 'object') continue;
        if (ov.autoCompressAt === undefined) continue;
        expect(typeof ov.charsPerToken, `${f}:${name} declares autoCompressAt but no charsPerToken`)
          .toBe('number');
        expect(ov.charsPerToken).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked, 'no models declare a capacity at all — this proves nothing').toBeGreaterThan(3);
  });

  it('and says why the ratio lives with the model', () => {
    const j = JSON.parse(readFileSync(join(CONFIG, 'llm-defaults.claude.json'), 'utf8'));
    expect(j.modelOverrides.$whyCharsPerToken, 'the declaration carries no reason').toBeTruthy();
  });

  it('THE LITERALS ARE GONE from the runner', () => {
    expect(RUNNER, 'the 60000 literal is still there')
      .not.toMatch(/EPAM_ROSTER_REVIEW_BATCH_CHARS\s*\|\|\s*['"]60000['"]/);
    expect(RUNNER, 'the invented 4000 floor is still there').not.toMatch(/_declaredBudget\s*<\s*4000/);
    expect(RUNNER, 'the budget is not derived from the model').toMatch(/autoCompressAt/);
    expect(RUNNER, 'the character ratio is not read from config').toMatch(/charsPerToken/);
  });

  it('THE SEAM NO LONGER CARRIES IT — capacity is not a property of a seam that escalates', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const seam = (reg.profiles || reg)['project-roster-review'];
    expect(seam, 'the seam is missing from the registry').toBeTruthy();
    expect(seam.reviewBatchChars, 'the seam still declares a batch budget').toBeUndefined();
  });

  it('an undeclared capacity is REFUSED by name, never defaulted', () => {
    const at = RUNNER.indexOf('_budgetFromModel');
    expect(at, 'the model-derived budget is missing').toBeGreaterThan(-1);
    const block = RUNNER.slice(at, at + 2400);
    for (const needed of ['autoCompressAt', 'charsPerToken', 'review_failed']) {
      expect(block, `an undeclared ${needed} does not produce a refusal`).toContain(needed);
    }
  });

  it('EVERY RUNG carries the whole roster in one call', () => {
    // Six batches was six chances of a flaky answer. One batch removes the failure mode; if a rung
    // could not carry it, the review would split again and the risk would return.
    expect(rosterChars, 'the roster is unexpectedly tiny; this proves nothing').toBeGreaterThan(100000);
    const j = JSON.parse(readFileSync(join(CONFIG, 'llm-defaults.claude.json'), 'utf8'));
    let rungs = 0;
    for (const [name, ov] of Object.entries<any>(j.modelOverrides || {})) {
      if (name.startsWith('$') || !ov?.autoCompressAt) continue;
      const capacity = ov.autoCompressAt * ov.charsPerToken;
      expect(Math.ceil(rosterChars / capacity), `${name} would still split the roster`).toBe(1);
      rungs += 1;
    }
    expect(rungs, 'no rungs were checked').toBeGreaterThan(1);
  });
});
