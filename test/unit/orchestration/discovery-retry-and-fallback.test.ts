/**
 * A transient must not silently shrink a multi-codeline ticket.
 *
 * Live AMSD-2041 run 9, after six consecutive runs returning three codelines:
 *
 *   WARN: LLM call failed: Empty response from ai-run.sh (no stderr captured).
 *         Using highest-scored candidate as fallback.
 *   → codeline 'gotransit' ([scored-fallback] Highest candidate (score: 152))
 *   Discovery complete. 1 codeline(s) identified.
 *
 * Nothing failed. The run proceeded on ONE lane of a ticket tagged [GO, UP, MX]
 * and would have reported success for a third of the work.
 *
 * TWO SEPARATE DEFECTS, and only one is fixed by retrying.
 *
 * The retry belongs at the SEAM, not here: ai-run.sh now retries every model
 * call with ladder escalation, so discovery inherits it like every other agent
 * (see every-agent-inherits-resilience.test.ts). A per-site retry would have
 * left the same hole open for the next call site — which is how discovery,
 * ac-gate, cpa-inference and four others ended up unprotected.
 *
 * The SECOND defect survives any amount of retrying: when the call ultimately
 * fails, the fallback returns exactly one repository —
 *
 *     return { codelines: [{ name, path: repo.path, ... }] };
 *
 * — so it cannot express a spanning ticket and silently answers a different
 * question from the one asked. That is what this file tests.
 *
 * NOTE ON AN EARLIER VERSION OF THIS FILE: its fallback assertions passed
 * against the unfixed code, because `/throw new Error/` matched an unrelated
 * empty-repo guard inside the same function. A test that matches incidental
 * code is not a test — the exact failure recorded in
 * feedback_tests_must_execute_not_describe. These now EXECUTE the function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DISCOVERY = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');
const SRC = readFileSync(DISCOVERY, 'utf8');
const SEAM = readFileSync(join(__dirname, '../../../orchestrations/scripts/ai-run.sh'), 'utf8');

/** Run selectBestCandidate in isolation, with the module's own source. */
function runFallback(scored: Array<Record<string, unknown>>, issues: unknown[]) {
  // Bounded by the FUNCTION's own closing brace, not by the next `function `
  // keyword: the text between them includes a `const { deriveCodelineName } =
  // require(...)` that collides with the helper passed in.
  const i = SRC.indexOf('function selectBestCandidate');
  const j = SRC.indexOf('\n}', i);
  const body = SRC.slice(i, j + 2);

  // The real helper, passed in — injecting a copy collides with the one the
  // sliced body already declares.
  const { deriveCodelineName } = require('../../../orchestrations/scripts/lib/codeline-name.js');
  // eslint-disable-next-line no-new-func
  const fn = new Function('scored', 'issues', 'deriveCodelineName', `
    ${body}
    return selectBestCandidate(scored, issues);
  `);
  return fn(scored, issues, deriveCodelineName);
}

const TWO_REPOS = [
  { name: 'site-a', path: '/estate/site-a', score: 152 },
  { name: 'site-b', path: '/estate/site-b', score: 143 },
];

describe('retry is inherited from the seam, not hand-rolled here', () => {
  it('the seam retries every model call', () => {
    expect(SEAM, 'discovery would need its own retry — the pattern that created 7 unprotected sites')
      .toMatch(/EPAM_CALL_MAX_ATTEMPTS/);
  });

  it('discovery routes through the seam so it inherits', () => {
    expect(SRC, 'discovery bypasses the seam and inherits nothing').toMatch(/ai-run\.sh/);
  });
});

describe('the fallback refuses to answer a spanning ticket with one repo', () => {
  it('returns one codeline for a single-area ticket', () => {
    // The common case must still work: a transient should not kill a run whose
    // ticket genuinely concerns one product area.
    const out = runFallback(TWO_REPOS, [{ key: 'X-1', components: ['GO'] }]);
    expect(out.codelines).toHaveLength(1);
    expect(out.codelines[0].path).toBe('/estate/site-a');
  });

  it('THROWS when the ticket names several product areas', () => {
    // The live case: [GO, UP, MX]. One repo is not an answer to that question.
    expect(() => runFallback(TWO_REPOS, [{ key: 'AMSD-2041', components: ['GO', 'UP', 'MX'] }]),
      'a three-component ticket still collapses silently to the top-scored repo')
      .toThrow();
  });

  it('names the areas it could not place', () => {
    let msg = '';
    try { runFallback(TWO_REPOS, [{ key: 'AMSD-2041', components: ['GO', 'UP', 'MX'] }]); }
    catch (e) { msg = String((e as Error).message); }
    expect(msg, 'the refusal gives the operator nothing to act on').toMatch(/GO|UP|MX|component/i);
  });

  it('still refuses when components arrive as objects', () => {
    // Jira returns [{name: 'GO'}, ...]; a shape assumption here would silently
    // disable the check.
    expect(() => runFallback(TWO_REPOS, [{ key: 'A-1', components: [{ name: 'GO' }, { name: 'UP' }] }]))
      .toThrow();
  });

  it('does not refuse when the ticket declares no components at all', () => {
    // Absence of components is not evidence of spanning.
    const out = runFallback(TWO_REPOS, [{ key: 'A-1' }]);
    expect(out.codelines).toHaveLength(1);
  });

  it('still throws when there are no repositories to choose from', () => {
    expect(() => runFallback([], [{ key: 'A-1', components: ['GO'] }])).toThrow(/No git repositories/);
  });
});
