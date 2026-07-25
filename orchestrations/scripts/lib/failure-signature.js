/**
 * failure-signature.js — derive a STABLE key from tool output, never from prose.
 *
 * The store's lookup key is (agent_role, signature). Replaying 118 real healing
 * episodes showed the key cannot come from the analyst's diagnosis: only FOUR
 * carried a compiler error code, the rest being free text. A regex classifier over
 * that prose scored 50.8% where careful human reading scored 94.1% — a 43-point gap
 * that is inherent to classifying prose, not a tuning problem.
 *
 * tsc and vitest already emit exact identifiers. This reads those. The model's
 * diagnosis is still recorded on the episode because it is genuinely useful to a
 * human reading the log — it is simply never used as a key.
 *
 * Returns null rather than guessing. An episode with no derivable signature is
 * evidence we cannot yet key on, and saying so is more useful than a fabricated
 * bucket that quietly mis-routes constraints.
 */
'use strict';

// Order matters: the most specific, least ambiguous signal first.
const MATCHERS = [
  // tsc: `path(line,col): error TS####:` — anchored to the real error line so a
  // code merely mentioned in prose is not picked up.
  { source: 'tsc', test: t => (t.match(/^.*\(\d+,\d+\):\s*error\s+(TS\d{4})\b/m) || [])[1] },

  // A module that cannot be resolved — distinct from a syntax problem, and fixed
  // by a different mechanism (dependency preflight, not the compiler).
  { source: 'vitest', test: t => /Cannot find (module|package)/i.test(t) ? 'missing-module' : null },

  // vitest transform/parse: the test NEVER RAN. Must not be confused with an
  // assertion failure — they demand opposite responses, and conflating them is
  // exactly the live bug where `ERROR: Expected` matched `AssertionError: expected`
  // case-insensitively and every good test was deleted as "never ran".
  {
    source: 'vitest',
    test: t => /Transform failed|Failed to parse|SyntaxError|No test files found|Tests +no tests/i.test(t)
      ? 'parse-error' : null,
  },

  // A test that ran and failed its assertions.
  {
    source: 'vitest',
    test: t => /AssertionError|\bTests?\s+\d+\s+failed|✗|×\s/i.test(t) ? 'test-failure' : null,
  },
];

/**
 * @param {string} toolOutput raw stdout/stderr from tsc or the test runner
 * @returns {{signature: string, source: string}|null}
 */
function fromToolOutput(toolOutput) {
  const t = String(toolOutput || '');
  if (!t.trim()) return null;
  for (const m of MATCHERS) {
    const hit = m.test(t);
    if (hit) return { signature: hit, source: m.source };
  }
  return null;
}

/**
 * Build an episodic record. `diagnosis` is carried for humans; the key comes only
 * from tool output, and `signature_source` records which — so a later audit can
 * tell a trustworthy key from an absent one.
 */
function buildEpisode({ id, toolOutput, diagnosis, ...rest }) {
  const derived = fromToolOutput(toolOutput);
  return {
    id,
    ...rest,
    diagnosis: diagnosis ?? null,
    signature: derived ? derived.signature : null,
    signature_source: derived ? derived.source : null,
  };
}

module.exports = { fromToolOutput, buildEpisode };
