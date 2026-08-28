/**
 * run-agent-orchestration.sh — bounded timeouts on every npm install / vitest
 * run invocation.
 *
 * Root cause this fixes (found live, 2026-07-06, tier3-full-run-16): a
 * user question ("is there some other error that did not surface?") prompted
 * a systematic re-check rather than accepting a "model latency" explanation
 * for a watchdog timeout. Tracing the actual per-story result.json timestamp
 * proved the agent call itself had finished in 11 seconds — the real hang was
 * `npm install --silent` in claude.sh's run_external_verification(), which had
 * no timeout at all (the third unbounded external command found this session,
 * after the test-command and git-operation hangs fixed earlier). A systematic
 * grep across BOTH orchestration scripts then found FOUR MORE unguarded
 * npm/vitest invocations in run-agent-orchestration.sh's various gates (pre-
 * review gate, the shared _run_vitest_check helper, the unit-test-gate's own
 * npm install + initial vitest run, and the post-bug-fix re-run vitest) — all
 * fixed the same way, with the same EPAM_TEST_TIMEOUT_SECS/
 * EPAM_INSTALL_TIMEOUT_SECS convention already established in claude.sh.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('run-agent-orchestration.sh — every vitest/npm install call is now bounded by a timeout', () => {
  it('Pre-Review Gate vitest run (Step 3.7) is wrapped with timeout', () => {
    const idx = orchSrc.indexOf('Pre-Review Gate: $PHASE');
    const block = orchSrc.slice(idx, idx + 900);
    expect(block).toMatch(/timeout "\$\{EPAM_TEST_TIMEOUT_SECS:-300\}" "\$_node_bin" \.\/node_modules\/\.bin\/vitest run/);
  });

  /**
   * THE TYPE CHECK MOVED, THE INVARIANT DID NOT.
   *
   * This asserted that run_unit_tests_gate's own `./node_modules/.bin/tsc` invocation was
   * wrapped in `timeout`. That invocation no longer exists: the gate stopped naming a compiler
   * when verification became a project declaration (.epam/verification.json, run through
   * orchestrations/plugins/verification-plugin.js). Asserting on the old literal would now fail
   * for the RIGHT reason, which makes it a test of the wrong thing.
   *
   * The requirement is unchanged and must still hold somewhere: a type check that never returns
   * hangs the phase with no watchdog above it. It is now bounded inside the plugin, for every
   * stack rather than for one.
   */
  it("the project's declared verification is bounded by a timeout", () => {
    const plugin = readFileSync(
      join(REPO_ROOT, 'orchestrations/plugins/verification-plugin.js'), 'utf8');
    const fn = plugin.slice(plugin.indexOf('function runVerification('));
    const call = fn.slice(0, fn.indexOf('\n}'));
    expect(call, 'an unbounded type check hangs the phase indefinitely').toMatch(/timeout:/);
  });

  it("the engine no longer names a compiler in the unit-test gate", () => {
    const idx = orchSrc.indexOf('run_unit_tests_gate() {');
    const body = orchSrc.slice(idx, orchSrc.indexOf('\n}\n', idx))
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(
      body,
      'which checker runs is the project\'s declaration, not the engine\'s knowledge',
    ).not.toContain('.bin/tsc');
  });

  it("the unit-test gate's own vitest run is wrapped with timeout", () => {
    // Was asserted against _run_vitest_check, a 25-line helper with ZERO call sites that was
    // deleted on 2026-08-09 as a superseded duplicate. The requirement is unchanged and now
    // points at the gate that actually runs: an unbounded vitest hangs the phase forever.
    const idx = orchSrc.indexOf('run_unit_tests_gate() {');
    expect(idx, 'run_unit_tests_gate not found').toBeGreaterThan(-1);
    const body = orchSrc.slice(idx, orchSrc.indexOf('\n}\n', idx));
    const vitestCall = body.split('\n').find((l) => l.includes('.bin/vitest run'));
    expect(vitestCall, 'the gate no longer runs vitest at all').toBeTruthy();
    expect(vitestCall, 'the vitest run is unbounded — a hang stalls the phase indefinitely')
      .toMatch(/timeout /);
  });

  it('Unit Test Gate (Step 4.5) npm install is wrapped with timeout and distinguishes a timeout (124) from a generic failure', () => {
    const idx = orchSrc.indexOf('Unit Test Gate: $phase_id');
    const block = orchSrc.slice(idx, idx + 1200);
    expect(block).toMatch(/timeout "\$\{EPAM_INSTALL_TIMEOUT_SECS:-180\}" npm install/);
    expect(block).toMatch(/"\$install_exit" -eq 124/);
    expect(block).toMatch(/npm install TIMED OUT/);
  });

  it('Unit Test Gate (Step 4.5) initial vitest run is wrapped with timeout', () => {
    const idx = orchSrc.indexOf('Initial vitest run');
    const block = orchSrc.slice(idx, idx + 400);
    expect(block).toMatch(/timeout "\$\{EPAM_TEST_TIMEOUT_SECS:-300\}" "\$_node_bin" \.\/node_modules\/\.bin\/vitest run/);
  });

  it('post-bug-fix re-run vitest is wrapped with timeout', () => {
    const idx = orchSrc.indexOf('Re-run vitest after bug fix phase completes');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/timeout "\$\{EPAM_TEST_TIMEOUT_SECS:-300\}" "\$_node_bin" \.\/node_modules\/\.bin\/vitest run/);
  });

  it('no bare (unwrapped) npm-install or vitest-run COMMAND invocation remains anywhere in the file', () => {
    const lines = orchSrc.split('\n');
    const offenders = lines.filter((line) => {
      // Only match actual invocations (assignment/subshell/command position),
      // not log/error strings that merely mention "npm install" in text.
      const isInvocation =
        /=\s*\(?cd .*&&\s*(timeout\s+\S+\s+)?npm install\b/.test(line) ||
        /^\s*(timeout\s+\S+\s+)?"?\$_node_bin"? \.\/node_modules\/\.bin\/vitest run/.test(line) ||
        /if (timeout\s+\S+\s+)?"\$_node_bin" \.\/node_modules\/\.bin\/vitest run/.test(line);
      if (!isInvocation) return false;
      return !line.includes('timeout ');
    });
    expect(offenders).toEqual([]);
  });
});
