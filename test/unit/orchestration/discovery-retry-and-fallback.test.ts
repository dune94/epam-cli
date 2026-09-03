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
const SEAM = readFileSync(join(__dirname, '../../../orchestrations/scripts/llm-handler.sh'), 'utf8');

// The lift harness and its two-repo fixture went with the fallback they drove: there is no
// selectBestCandidate to lift, and a fixture for a chooser that must not exist is a standing
// invitation to reintroduce one.

describe('retry is inherited from the seam, not hand-rolled here', () => {
  it('the seam retries every model call', () => {
    expect(SEAM, 'discovery would need its own retry — the pattern that created 7 unprotected sites')
      .toMatch(/EPAM_CALL_MAX_ATTEMPTS/);
  });

  it('discovery routes through the seam so it inherits', () => {
    expect(SRC, 'discovery bypasses the seam and inherits nothing').toMatch(/ai-run\.sh/);
  });
});

describe('there is no deterministic fallback left to answer with', () => {
  /*
   * THE FALLBACK WAS REMOVED ON PURPOSE, AND THAT IS A STRONGER GUARANTEE.
   *
   * These six tests drove selectBestCandidate, a deterministic chooser that picked the
   * highest-scored repository when the discovery call failed. It was deleted: "a discovery that
   * never happened was indistinguishable from one that did, and the run proceeded against a
   * repository nothing had reasoned about" (lib/codeline-discovery.js). The function is gone, so
   * the lift produced `selectBestCandidate is not defined` — and TWO of the six then PASSED,
   * because they only asserted `.toThrow()` and a ReferenceError throws. A vacuous pass on a
   * money-spending path is worse than a failure.
   *
   * The requirement they encoded — one repo is not an answer to a multi-area ticket, and the
   * engine must never quietly choose — is now met by there being nothing to choose WITH. These
   * assert that, so the contract stays written and a reintroduced fallback fails here.
   */
  it('the module exposes no deterministic selector', () => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const mod = require('../../../orchestrations/scripts/lib/codeline-discovery.js');
    for (const name of Object.keys(mod)) {
      expect(name, `${name} looks like a chooser — the engine must not select a codeline itself`)
        .not.toMatch(/select|pick|choose|fallback|best/i);
    }
  });

  it('no code path substitutes the highest-scored repository', () => {
    expect(SRC, 'a deterministic chooser is back in the discovery module')
      .not.toMatch(/function\s+selectBestCandidate/);
    // The scorer still exists and is still used for RANKING — what must not return is a code
    // path that turns a ranking into a selection without the agent.
    expect(SRC, 'discovery no longer explains why it refuses to choose')
      .toMatch(/NO FALLBACK|nothing here invents a selection/);
  });

  it('an unusable answer is corrected by the agent, never replaced by the engine', () => {
    // retryUntilParsed re-asks with the broken contract named, and THROWS when corrections are
    // exhausted. That is the replacement for the fallback: self-correction, then a stop.
    expect(SRC).toMatch(/retryUntilParsed/);
    expect(SRC, 'an empty selection is accepted').toMatch(/you selected no codeline/);
    expect(SRC, 'a selected path is no longer verified to be a real git repository')
      .toMatch(/that path is not a git repository/);
  });

  it('an empty estate stops the run rather than proceeding with no scope', () => {
    expect(SRC).toMatch(/No git repositories found in JIRA_CODELINE_ROOT/);
    const idx = SRC.indexOf('No git repositories found in JIRA_CODELINE_ROOT');
    expect(SRC.slice(idx, idx + 200), 'discovery reports an empty estate and carries on')
      .toMatch(/process\.exit\(1\)/);
  });
});
