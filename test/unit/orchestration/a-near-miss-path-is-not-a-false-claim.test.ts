/**
 * A PROMPT THAT IS RIGHT ABOUT THE PROJECT AND IMPRECISE ABOUT A PATH IS NOT A FALSE PROMPT.
 *
 * Live 2026-09-04, pipeline-tests-18: the mint died with
 *
 *     [prompt-builder] could not generate a valid 'runtime-boundary-review' in 3 attempt(s)
 *     [mint] Agent mint/assignment failed — refusing to run stories with no assigned agent
 *     Phase 'core' failed (exit 1) — aborting pipeline
 *
 * ~75 minutes and ~$9 spent, no story work done, ~34 good prompts discarded because ONE failed.
 *
 * The rejected claims were TRUE. The reviewer called them false because a path was abbreviated:
 *
 *   generated: src/pages/api/checkouts/[checkoutId].ts   (and src/routes/… on another attempt)
 *   actual:    src/pages/api/v1/ecommerce/checkouts/[checkoutId].ts   — it exists
 *              react-hook-form IS imported in src/components/pages/CheckoutPage/CheckoutForm.tsx
 *              joi IS used across the TypeScript sources
 *
 * So the reviewer reported "claims about the project that are false", the generator rewrote the
 * whole prompt to escape a finding that was not real, and in rewriting it dropped required
 * placeholders — which the contract check then refused. Three attempts, alternating between the
 * two failure modes, and the run died.
 *
 * NOTHING IN THIS PATH CHANGED SINCE v1.6 — the builder, the contract, the templates and the
 * ladder are byte-identical. v1.6 was not more stable; it was luckier. Three attempts against a
 * gate that rejects near-misses is a coin flip, repeated once per prompt, ~35 times a run.
 *
 * Three fixes, because all three contribute:
 *   1. the REVIEWER must search before declaring a path absent, and must not treat an imprecise
 *      path that resolves to a real file as a false claim
 *   2. the GENERATOR must not invent specific paths it was not given — imprecision is what the
 *      reviewer then trips on
 *   3. the ATTEMPT BUDGET must be raisable without editing code, so one unlucky prompt cannot
 *      abort a run that is otherwise complete
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const tpl = (id: string) =>
  JSON.parse(readFileSync(join(REPO, 'orchestrations/prompts/templates', `${id}.json`), 'utf8'));

describe('1. the reviewer verifies before it falsifies', () => {
  const body: string = tpl('prompt-review').body;

  it('tells the reviewer to SEARCH for a path before calling it absent', () => {
    // It already says "Open the codelines and check it" — which it did, at the literal path, found
    // nothing, and stopped. Absence at one path is not absence from the repository.
    expect(body.toLowerCase(),
      'the reviewer declares a file missing without searching for it — an abbreviated path reads as a lie')
      .toMatch(/search|glob|find the file|elsewhere in the (repo|tree)/);
  });

  it('states plainly that an imprecise path which RESOLVES is not a false claim', () => {
    expect(body.toLowerCase(),
      'nothing tells the reviewer that a near-miss path is a near miss rather than a falsehood')
      .toMatch(/imprecise|abbreviat|near[- ]miss|shortened|partial path/);
  });

  it('still catches a genuinely absent file — the tolerance is not a loophole', () => {
    expect(body, 'the reviewer must still report something that truly does not exist')
      .toMatch(/does not exist|no such|not present|cannot find/i);
  });
});

describe('2. the generator does not invent specifics it was not given', () => {
  const body: string = tpl('project-prompt-generation').body;

  it('forbids inventing a path, and says to use the facts it was handed instead', () => {
    expect(body.toLowerCase(),
      'the generator invents plausible paths — which is what the reviewer then rejects it for')
      .toMatch(/do not invent|never invent|only.*(facts|evidence) you were given|must not guess a path/);
  });
});

describe('3. one unlucky prompt cannot abort an otherwise complete run', () => {
  const builder = readFileSync(
    join(REPO, 'orchestrations/scripts/lib/project-prompt-builder.js'), 'utf8');
  const mint = readFileSync(join(REPO, 'orchestrations/scripts/mint-agents-step.js'), 'utf8');

  it('the attempt budget is raisable without editing code', () => {
    // The roster mint already reads EPAM_ROSTER_ATTEMPTS. Prompt generation had no equivalent, so
    // the only way to survive an unlucky prompt was to change a literal in a shipped file.
    expect(`${builder}\n${mint}`,
      'the prompt attempt budget is a hardcoded 3 — an operator cannot raise it when a run dies on one prompt')
      .toMatch(/EPAM_PROMPT_ATTEMPTS/);
  });

  it('and its default is more than the 3 that proved too few', () => {
    const m = `${builder}\n${mint}`.match(/EPAM_PROMPT_ATTEMPTS[^)]*\|\|\s*(\d+)/);
    expect(m, 'no default declared alongside EPAM_PROMPT_ATTEMPTS').toBeTruthy();
    expect(Number(m![1]),
      '3 attempts is what the live failure exhausted — a default that low reproduces it')
      .toBeGreaterThan(3);
  });
});
