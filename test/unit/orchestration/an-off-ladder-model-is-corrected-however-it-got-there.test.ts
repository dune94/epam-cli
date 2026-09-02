/**
 * A MODEL ON NO DECLARED LADDER IS CORRECTED — WHETHER OR NOT ANYTHING WAS MISSING.
 *
 * The pipeline already knows how to fix this. run-agent-orchestration.sh reads the project's own
 * declared ladder, finds any story whose model is not in it, says so, and rewrites it to that
 * ladder's opening model: "a model off the ladder has no successor and cannot escalate".
 *
 * That corrector sits inside the WRONG BRANCH:
 *
 *     if [ "$_mc_missing_count" -eq 0 ]; then
 *         info "All pending stories already have model/aiProvider/reasoningEffort"   <- taken
 *     else
 *         ...coordinate...
 *         ...off-ladder corrector...                                                 <- never runs
 *     fi
 *
 * So COMPLETE-BUT-WRONG is invisible; only INCOMPLETE is ever checked. A story carrying
 * model="MiniMax-M3" with a provider and an effort has all three fields, takes the first branch,
 * and the guard that exists to catch exactly that value is skipped.
 *
 * LIVE COST, 2026-09-02: AMSD-1919 carried model=MiniMax-M3 / aiProvider=minimax on the claude
 * set. Pre-flight refused two launches — "a story is assigned a model that is on no declared
 * ladder ... it could never escalate" — and the only way past it was hand-editing the PRD, which is
 * forbidden. The corrector that would have fixed it silently never ran, and the log line the
 * operator saw was the reassuring one: "All pending stories already have model/aiProvider/
 * reasoningEffort".
 *
 * The value's ORIGIN is a separate, still-open question — the coordinator never made a model call
 * (zero cost snapshots), ORCH_UPGRADE_MODEL is commented out in config.env:171, and the hot-swap
 * path never fired. What is established is why it PERSISTS: nothing re-checks a field that is
 * present.
 *
 * A CHECK THAT ONLY RUNS WHEN SOMETHING IS ABSENT CANNOT CATCH SOMETHING WRONG.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');
const lines = src.split('\n');

/** Line index (0-based) of the first line matching, or -1. */
const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

describe('an off-ladder model is corrected however it got there', () => {
  const guardIdx = at(/_mc_missing_count:-0.*-eq 0/);
  const skipMsgIdx = at(/All pending stories already have model/);
  const correctorIdx = at(/assigned a model on no declared ladder/);

  it('all three landmarks are present — otherwise this test proves nothing', () => {
    expect(guardIdx, 'the missing-count branch was not found').toBeGreaterThan(-1);
    expect(skipMsgIdx, 'the "already have" message was not found').toBeGreaterThan(-1);
    expect(correctorIdx, 'the off-ladder corrector was not found').toBeGreaterThan(-1);
  });

  it('THE CORRECTOR IS NOT TRAPPED IN THE else BRANCH', () => {
    // The else branch begins after the skip message. A corrector below that point runs only when a
    // field was missing — which is precisely the case that does NOT need correcting.
    const elseIdx = lines.findIndex((l, i) => i > skipMsgIdx && /^\s*else\s*$/.test(l));
    expect(elseIdx, 'the else of the missing-count branch was not found').toBeGreaterThan(-1);
    expect(correctorIdx,
      'the off-ladder corrector sits inside the "fields were missing" branch, so a story whose '
      + 'model is present but invalid is never checked — the exact state that blocked two launches '
      + `on 2026-09-02 (corrector at line ${correctorIdx + 1}, else at ${elseIdx + 1})`)
      .toBeLessThan(elseIdx);
  });

  it('AND IT STILL READS THE LADDER RATHER THAN A LIST', () => {
    // The correction must stay derived: the permitted set comes from the project's declared ladder
    // via ladder-models.js, never a literal here. Moving code is where a literal creeps in.
    // Comments explain the incident and legitimately name the model that caused it; only
    // executable lines may not carry a literal.
    const window = lines.slice(Math.max(0, correctorIdx - 25), correctorIdx + 15)
      .filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(window, 'the corrector no longer reads the declared ladder')
      .toMatch(/ladder-models\.js/);
    expect(window, 'a model literal appeared in the corrector — the ladder declares the set')
      .not.toMatch(/claude-[a-z0-9]|MiniMax|gpt-|glm-/);
  });

  it('the skip message still exists — the fix must not delete the fast path', () => {
    // Correcting an invalid model is cheap and deterministic; it must not turn into a reason to
    // re-run the coordinator agent when nothing is missing.
    expect(skipMsgIdx, 'the "already have" fast path was removed rather than kept')
      .toBeGreaterThan(-1);
  });
});
