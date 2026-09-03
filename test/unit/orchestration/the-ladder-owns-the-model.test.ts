/**
 * THE LADDER OWNS THE MODEL. THE PRD CANNOT OVERRIDE IT.
 *
 * Operator rule, stated many times: a story is assigned to a LADDER, and the ladder decides which
 * model it starts on. The PRD does not get a vote.
 *
 * resolve_model_from_story (claude.sh) does the opposite: it reads story.model out of the PRD and
 * assigns it to STORY_MODEL, announcing "Model[prd.json] -> X (overrides effort default)". So
 * whatever the prd-model-coordinator wrote outranks the ladder the seam declares.
 *
 * THE COST, twice on 2026-09-02: the coordinator wrote model="MiniMax-M3", provider="minimax" into
 * AMSD-1919 while the run was on the claude set, where no ladder contains that model. Pre-flight
 * refused to launch — "a story is assigned a model that is on no declared ladder ... it could never
 * escalate" — and the writer resume was blocked until the field was hand-edited, which is itself
 * forbidden. The value is not config drift: ladder-models.js correctly returns claude-only models,
 * and the coordinator was handed that list. It wrote a vendor from nowhere and nothing checked.
 *
 * Fixing the coordinator's output is worth doing, but it is the second defect. The first is that a
 * PRD field can override the ladder at all: while it can, any wrong value is fatal rather than
 * ignored, and the same class of block returns with a different string.
 *
 * SAME RULE, ALREADY SETTLED FOR EFFORT AND ITERATIONS. A seam does not carry its own
 * maxIterations, and as of commit fb16b266 it does not carry its own reasoningEffort either — the
 * rung owns both. The model is the third member of that tuple and the only one still overridable.
 *
 * WHAT THE LADDER ALREADY PROVIDES, so nothing new is needed: classify_ladder_tier(story) resolves
 * the tier, and model-ladders.sh exports EPAM_MODEL_LADDER_<TIER>_START from the project's declared
 * startModel (model-ladders.sh:154-156). The start model is available without consulting the PRD.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

/** The body of a shell function, located by name so line drift does not break the test. */
function fn(name: string): string {
  const at = src.indexOf(`${name}() {`);
  if (at < 0) throw new Error(`${name} not found in claude.sh`);
  const from = src.slice(at);
  let depth = 0;
  for (let i = from.indexOf('{'); i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}') { depth--; if (depth === 0) return from.slice(0, i + 1); }
  }
  return from.slice(0, 4000);
}

describe('the ladder owns the model', () => {
  const body = fn('resolve_model_from_story');

  it('the function exists and is readable — otherwise nothing below is a fact', () => {
    expect(body.length, 'resolve_model_from_story body not located').toBeGreaterThan(200);
  });

  it('THE PRD MODEL DOES NOT BECOME THE STORY MODEL', () => {
    // The defect in one line: `STORY_MODEL="$story_model"` where $story_model came from
    // `jq '.stories[] | select(.id==$id) | .model'`.
    expect(body,
      'resolve_model_from_story assigns the PRD\'s model to STORY_MODEL, so a value the '
      + 'prd-model-coordinator invented outranks the ladder the seam declares — this is what put '
      + 'MiniMax-M3 on a claude run and blocked two launches')
      .not.toMatch(/STORY_MODEL="\$story_model"/);
  });

  it('AND THE START MODEL COMES FROM THE LADDER', () => {
    // The replacement must READ the ladder, not merely stop reading the PRD: dropping the override
    // without a source would leave STORY_MODEL at whatever the effort-tier default happened to be,
    // which is a different way of not consulting the ladder.
    expect(body,
      'the function does not resolve the start model from the ladder tier '
      + '(classify_ladder_tier + EPAM_MODEL_LADDER_<TIER>_START)')
      .toMatch(/EPAM_MODEL_LADDER_.*_START|classify_ladder_tier/);
  });

  it('THE LADDER EXPORTS A START MODEL TO READ — the derivation has a real source', () => {
    // A rule that reads a variable nothing exports is as dead as a literal.
    const ladders = readFileSync(join(REPO, 'orchestrations/scripts/lib/model-ladders.sh'), 'utf8');
    expect(ladders, 'model-ladders.sh no longer exports a per-tier start model')
      .toMatch(/_START=/);
    expect(ladders, 'the start model is not read from the project\'s declared startModel')
      .toMatch(/startModel/);
  });

  it('A RESUMED RUNG STILL OUTRANKS THE START — climbing must not be undone', () => {
    // The existing guard: a story that has already climbed keeps its position. Removing the PRD
    // override must not remove this, or every retry would restart at the bottom of the ladder.
    expect(body, 'the resumed-ladder-position guard was lost')
      .toMatch(/STORY_MODEL_LADDER_RESUMED/);
  });
});
