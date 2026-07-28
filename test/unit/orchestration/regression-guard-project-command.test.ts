/**
 * Run the project's OWN test command, not a hardcoded runner grammar.
 *
 * Live AMSD-2041 run 5, 2026-07-28, against next.gotransit.com:
 *
 *   ✗ Step 5: Regression guard
 *   [ERROR] Regression guard FAILED — tests broken before phase 'core' starts
 *
 * The client's suite was fine. Its own log says so:
 *
 *   No tests found, exiting with code 1
 *     3103 files checked.
 *     testMatch: ... - 874 matches
 *     Pattern: run - 0 matches
 *
 * The guard invokes `<node> <runner> run`. For vitest, `run` is the subcommand
 * meaning "run once, do not watch". For jest, `run` is a TEST PATH PATTERN — so
 * jest searched 874 test files for ones whose path matched the string "run",
 * found none, and exited 1.
 *
 * We invoked jest with vitest's grammar and then reported the client's baseline
 * as broken. A false red on a gate whose whole purpose is telling us whether the
 * baseline is trustworthy — and it would have blocked every lane in turn.
 *
 * The runner name and its argument were both hardcoded, which is the recurring
 * defect: the engine assuming a stack. Every project already states how to run
 * its own tests. Read it.
 *
 * DETERMINABLE, not assumed: `scripts.test` in the project's manifest, executed
 * through the package manager its lockfile names. Nothing here may contain a
 * runner name or a runner-specific flag.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

/** The Step 5 region. */
function step5(): string {
  const i = src.indexOf('Step 5: Cross-phase regression guard');
  expect(i, 'Step 5 execution block not found').toBeGreaterThan(-1);
  const start = src.lastIndexOf('\n', Math.max(0, i - 3000));
  const end = src.indexOf('SKIP_REGRESSION_GUARD=true)', i);
  return src.slice(start, end > i ? end + 200 : i + 5000);
}

describe('the guard runs what the project says to run', () => {
  it('does not pass a runner-specific subcommand', () => {
    // `run` is vitest grammar and a path filter in jest. Passing it to an
    // unknown runner is a coin flip.
    expect(step5(), 'a hardcoded `run` argument is still passed to the test binary')
      .not.toMatch(/"\$_rg_bin"\s+run\b/);
  });

  it('uses the project\'s declared test script', () => {
    expect(step5(), 'the project\'s own test command is never consulted')
      .toMatch(/scripts\.test|_rg_test_cmd|npm_test/i);
  });

  it('names no test runner in executable code', () => {
    // The next client may use none of the runners this code once knew about.
    //
    // Comments are excluded deliberately: the comment explaining WHY this broke
    // has to say that `run` means different things to two specific runners, and
    // stripping those names would leave an unintelligible warning. The rule is
    // that behaviour must not depend on a runner's name — prose may explain it.
    const code = step5().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const named = ['vitest', 'jest', 'mocha', 'ava', 'jasmine'].filter((r) => code.includes(r));
    expect(named,
      `the guard still names specific runners in code, so an unknown stack breaks: ${named.join(', ')}`)
      .toEqual([]);
  });
});

describe('it still distinguishes a broken baseline from an absent one', () => {
  it('keeps failing loudly when the tests genuinely fail', () => {
    expect(step5(), 'a red baseline no longer stops the run')
      .toMatch(/step_emit "5" "fail"/);
  });

  it('keeps the not-applicable path for a project with no tests', () => {
    expect(step5(), 'a project that declares no tests now fails instead of skipping')
      .toMatch(/step_emit "5" "skip"/);
  });

  it('keeps the explicit bypass', () => {
    expect(step5()).toMatch(/SKIP_REGRESSION_GUARD/);
  });
});
