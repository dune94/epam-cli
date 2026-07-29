/**
 * Every model attempt gets its own clock.
 *
 * Live metrolinx 2026-07-29. Codeline discovery wraps the seam in a single
 * `spawnSync` timeout, and the seam retries up to EPAM_CALL_MAX_ATTEMPTS times
 * with ladder escalation INSIDE that one window. So one slow attempt consumed
 * the whole budget, attempts 2..N never ran, and the retry ladder added in
 * 54d6c09 was unreachable from that call site:
 *
 *   WARN: LLM call failed: spawnSync /bin/sh ETIMEDOUT. Using highest-scored
 *         candidate as fallback.
 *
 * Widening the caller's window helps a SLOW attempt but does nothing for a HUNG
 * one — it just moves the cliff. The fix is a bound per attempt, so attempt 1
 * dying releases the budget for attempt 2 on the next ladder rung.
 *
 * TWO WRONG IMPLEMENTATIONS, both caught here rather than in production, and
 * both worth recording because the constructs look obviously correct:
 *
 *   `timeout N bash -c '"$@"' _ run_provider_once` — run_provider_once is a
 *   shell FUNCTION depending on this script's other functions and variables. A
 *   fresh `bash -c` has none of them.
 *
 *   A watchdog subshell, measured: the FAST call took the full timeout (3s
 *   instead of instant) and the HUNG call was never actually stopped (30s).
 *   Two distinct bugs — command substitution waits for every process holding
 *   the captured stdout open, including the watchdog; and killing the job does
 *   not kill the `sleep` child that outlives it.
 *
 * So the assertions below measure ELAPSED TIME and process survival, not the
 * presence of a `timeout` call in the source. A construct that reads correctly
 * and behaves wrongly is exactly what this file exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AI_RUN = join(__dirname, '../../../orchestrations/scripts/ai-run.sh');
const SRC = readFileSync(AI_RUN, 'utf8');

/** The helper, bounded by its own definition. */
function helperSrc(): string {
  const start = SRC.indexOf('_ai_attempt_timeout() {');
  if (start === -1) throw new Error('_ai_attempt_timeout is not defined in ai-run.sh');
  const end = SRC.indexOf('\n}', start);
  if (end === -1) throw new Error('_ai_attempt_timeout has no closing brace');
  return SRC.slice(start, end + 2);
}

/**
 * Execute the real helper against a stub workload.
 *  - `body`  : the shell body of the function being bounded
 *  - `secs`  : the per-attempt budget
 */
function runHelper(body: string, secs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'attempt-timeout-'));
  const script = join(dir, 'probe.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
${helperSrc()}

work() {
${body}
}

export EPAM_CALL_ATTEMPT_TIMEOUT_SECS=${secs}
_start=\$SECONDS
out="\$(_ai_attempt_timeout work 2>/tmp/attempt-err-\$\$)"
rc=\$?
_elapsed=\$(( SECONDS - _start ))
echo "RC=\$rc"
echo "ELAPSED=\$_elapsed"
echo "OUT=\$out"
echo "ERR=\$(cat /tmp/attempt-err-\$\$ 2>/dev/null)"
rm -f /tmp/attempt-err-\$\$
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 120000 });
  rmSync(dir, { recursive: true, force: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const grab = (k: string) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [, ''])[1];
  return {
    rc: Number(grab('RC')),
    elapsed: Number(grab('ELAPSED')),
    out: grab('OUT'),
    err: grab('ERR'),
    raw: out,
  };
}

describe('a fast attempt is not delayed by its own watchdog', () => {
  it('returns immediately, not after the timeout', () => {
    // The bug in the first watchdog: command substitution waits for every
    // process holding the captured stdout open — including the sleeping
    // watchdog — so a 20ms call took the full budget.
    const r = runHelper('  echo fast-ok', 5);
    expect(r.out, `output lost:\n${r.raw}`).toBe('fast-ok');
    expect(r.rc).toBe(0);
    expect(r.elapsed, `a fast call waited ${r.elapsed}s for a 5s budget`).toBeLessThan(3);
  });

  it('propagates a real non-zero exit rather than masking it', () => {
    const r = runHelper('  echo partial; return 7', 5);
    expect(r.rc, 'a failing attempt reported success').toBe(7);
  });

  it('keeps stderr separate from stdout', () => {
    // The caller does `out="$(... 2>"$err_file")"` and parses both. Merging them
    // would put diagnostics into the parsed payload.
    const r = runHelper('  echo to-out; echo to-err >&2', 5);
    expect(r.out).toBe('to-out');
    expect(r.err).toContain('to-err');
  });
});

describe('a hung attempt is actually stopped', () => {
  it('gives up at the budget instead of running to completion', () => {
    // 30s of work, 3s budget. The second wrong implementation returned rc=143
    // while still taking the full 30s — the kill did not reach the `sleep`
    // child, so elapsed time is the assertion that matters, not exit status.
    const r = runHelper('  sleep 30; echo SHOULD-NOT-APPEAR', 3);
    expect(r.elapsed, `hung attempt ran ${r.elapsed}s against a 3s budget`).toBeLessThan(12);
    expect(r.rc, 'a timed-out attempt must not look like success').not.toBe(0);
    expect(r.out, 'work continued past the timeout').not.toContain('SHOULD-NOT-APPEAR');
  });

  it('kills the child process, not just the job wrapper', () => {
    // The specific failure: `kill` hit the subshell while `sleep` survived and
    // kept the captured stdout open, so the caller waited anyway.
    const r = runHelper('  sleep 25 & wait', 3);
    expect(r.elapsed, `child outlived its bound: ${r.elapsed}s`).toBeLessThan(12);
  });
});
