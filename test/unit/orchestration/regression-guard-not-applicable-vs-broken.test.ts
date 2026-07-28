/**
 * "This repo has no tests" and "we could not run this repo's tests" are
 * opposite situations. The regression guard treated them the same.
 *
 * Live, metrolinx AMSD-2041, 2026-07-28:
 *
 *   [--] 5  Step 5: Regression guard — node/vitest not found
 *
 * The gate that catches "the previous phase broke existing tests" did not run
 * against a real client repository, and the run carried on. It is emitted as
 * `skip` at info level, so nothing about it reads as a problem.
 *
 * The branch is a single `else`: if node, package.json or a test binary is
 * missing, skip. That is correct for a codeline that genuinely has no test
 * setup — some repos in an estate are content or config, and failing them would
 * block legitimate work. It is WRONG for a repo that declares tests and whose
 * environment we simply failed to prepare: there, "skipped" means an unverified
 * baseline was accepted silently, which is the fail-open class this pipeline
 * keeps producing (see the lint gate that exited 2 and examined zero files).
 *
 * The distinction is available from the project's own package.json — a `test`
 * script, or vitest/jest in its dependencies — so it needs no stack knowledge
 * baked into the engine and no per-project configuration.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

/** The Step 5 region. */
function step5(): string {
  const i = src.indexOf('Step 5: Regression guard');
  expect(i, 'Step 5 not found').toBeGreaterThan(-1);
  const start = src.lastIndexOf('\n', Math.max(0, i - 2000));
  const end = src.indexOf('SKIP_REGRESSION_GUARD=true)', i);
  return src.slice(start, end > i ? end + 200 : i + 4000);
}

describe('a testable repo whose tests could not run is a failure, not a skip', () => {
  it('inspects the project\'s own package.json to decide applicability', () => {
    // No hardcoded stack knowledge: the repo declares whether it has tests.
    expect(step5(),
      'the guard cannot tell "no tests here" from "we failed to run the tests"')
      .toMatch(/_rg_declares_tests|declares_tests/);
  });

  it('fails when the repo declares tests but no runner could be resolved', () => {
    const s = step5();
    const i = s.search(/_rg_declares_tests|declares_tests/);
    expect(i, 'no applicability check exists').toBeGreaterThan(-1);
    expect(s.slice(i),
      'a repo that declares tests still merely skips — an unverified baseline ' +
      'is accepted with no signal')
      .toMatch(/step_emit "5" "fail"|error /);
  });

  it('still skips a repo that genuinely has no test setup', () => {
    // Content and config repos exist in a real estate; failing them would block
    // legitimate work and the gate would get bypassed wholesale.
    expect(step5(), 'the not-applicable path was removed, so testless repos now fail')
      .toMatch(/step_emit "5" "skip"/);
  });

  it('says WHICH of the two happened', () => {
    // "node/vitest not found" describes the symptom for both cases and tells the
    // operator nothing about whether it mattered.
    expect(step5(), 'the skip reason does not distinguish the two cases')
      .toMatch(/no test setup|declares no tests|not applicable/i);
  });

  it('keeps the explicit bypass working', () => {
    expect(step5()).toMatch(/SKIP_REGRESSION_GUARD/);
  });
});
