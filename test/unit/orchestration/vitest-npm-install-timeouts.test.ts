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

  it('_run_vitest_check() (shared helper, Step 4.5 family) is wrapped with timeout', () => {
    const idx = orchSrc.indexOf('_run_vitest_check() {');
    const block = orchSrc.slice(idx, idx + 500);
    expect(block).toMatch(/timeout "\$\{EPAM_TEST_TIMEOUT_SECS:-300\}" "\$_node_bin" \.\/node_modules\/\.bin\/vitest run/);
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
