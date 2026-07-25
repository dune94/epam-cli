/**
 * constraint-sanity.js — semantic admission checks, distinct from schema validation.
 *
 * kb_schema.py proves a constraint has a MECHANISM. It cannot prove the mechanism
 * points the right way: `{kind: param, name: EPAM_MAX_ITERATIONS, value: 14}` and
 * `... value: 40}` are structurally identical, and Pydantic accepts both.
 *
 * Live metrolinx 2026-07-25 — the repro-test-writer exhausted its 15 iterations,
 * and self-heal synthesised, admitted and applied:
 *
 *   value: "14", reason: "Prevents exceeding the 15-iteration limit by setting a
 *                         hard cap at 14 iterations."
 *
 * The model reasoned backwards: told the agent hit a limit, it made the limit
 * smaller. All three attempts then died at 14 iterations, no test was written, and
 * the repro-gate blocked — while the previous run, with no self-heal at all, had
 * succeeded on attempt 2. Self-heal caused the regression, and every pillar passed
 * it: the schema validated the shape, arbitration found nothing to contradict, and
 * the state digest faithfully confirmed the harmful value was applied.
 *
 * That is the over-correction failure mode the memory-drift design warns about.
 * The enforcement vocabulary can express a harmful rule as easily as a helpful one,
 * so admission needs a check that reasons about MEANING.
 *
 * Deliberately narrow: a small table of budget parameters that may only ever grow.
 * Anything not listed passes untouched — this is a guard against a specific,
 * observed class of nonsense, not an attempt to referee every possible rule.
 */
'use strict';

/**
 * Parameters that exist to give an agent MORE room. A rule that fires because one
 * was exhausted must never shrink it. Values are compared against what is actually
 * in force, so this is a real comparison rather than a guess about defaults.
 */
const INCREASE_ONLY = new Set([
  'EPAM_MAX_ITERATIONS',
  'EPAM_MAX_OUTPUT_TOKENS',
  'EPAM_STORY_TIMEOUT_SECS',
  'EPAM_GATE_TIMEOUT_SECS',
  'STORY_MAX_ITERATIONS',
  'STORY_MAX_OUTPUT_TOKENS',
]);

/**
 * Throw if the candidate is schema-valid but semantically self-defeating.
 * @param {object} candidate a constraint that has ALREADY passed schema validation
 * @param {object} env       the environment to compare against (default process.env)
 */
function assertSane(candidate, env) {
  const e = (candidate && candidate.enforcement) || {};
  if (e.kind !== 'param' || !INCREASE_ONLY.has(e.name)) return;

  const proposed = Number(e.value);
  if (!Number.isFinite(proposed)) {
    throw new Error(
      `constraint-sanity: ${e.name} is numeric but the rule proposes ${JSON.stringify(e.value)} ` +
      `(constraint '${candidate.id}')`);
  }
  if (proposed <= 0) {
    throw new Error(`constraint-sanity: ${e.name} must be positive, got ${proposed}`);
  }

  const source = env || process.env;
  const current = Number(source[e.name]);
  // No value in force — nothing to compare against. Skip rather than guess at a
  // default, which would differ per agent and could reject a legitimate rule.
  if (!Number.isFinite(current)) return;

  if (proposed <= current) {
    throw new Error(
      `constraint-sanity: ${e.name} may only INCREASE — it is a budget, and this ` +
      `rule exists because the budget was exhausted. Currently ${current}, rule ` +
      `proposes ${proposed} (constraint '${candidate.id}'). Lowering it makes the ` +
      `failure it is meant to fix strictly more likely.`);
  }
}

module.exports = { assertSane, INCREASE_ONLY };
