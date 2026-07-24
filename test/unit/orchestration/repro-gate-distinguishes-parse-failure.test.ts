/**
 * repro-test-gate must distinguish "the test could not RUN" from "the test RAN and failed".
 *
 * ESCAPED DEFECT (live, AMSD-1820 2026-07-24): the gate ran the new test, saw a
 * non-zero exit, and reported:
 *
 *   ⛔ BLOCK: the new test(s) FAIL with the fix in place — the fix is incomplete
 *             or the test is wrong.
 *
 * The real cause was an esbuild parse error — the test never executed, so it proved
 * NOTHING about the fix. That message actively misdirected the investigation toward
 * "the fix is incomplete / needs a multi-site change" when the fix had never been
 * exercised at all. The two causes demand opposite responses:
 *
 *   parse/transform failure -> the TEST is malformed; rewrite the test.
 *   assertion failure       -> the test ran; the FIX is suspect.
 *
 * The gate discards runner output (`>/dev/null 2>&1`) and looks only at the exit
 * code, so it structurally cannot tell these apart. These tests force the
 * distinction into the block message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATE = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-gate.sh'), 'utf8');

describe('repro-gate — parse failure vs assertion failure', () => {
  it('captures runner output instead of discarding it (cannot classify what it never sees)', () => {
    // The original ran every check as `... >/dev/null 2>&1`, throwing away the only
    // evidence that could distinguish the two causes.
    const runFn = GATE.slice(GATE.indexOf('run_new_tests'), GATE.indexOf('run_new_tests') + 700);
    expect(runFn).toMatch(/2>&1\s*\)|_out=|\$\(.*2>&1.*\)/);
    expect(runFn).not.toMatch(/>\/dev\/null 2>&1/);
  });

  it('detects transform/parse errors explicitly', () => {
    expect(GATE).toMatch(/Transform failed|Failed to parse|SyntaxError|Unexpected token|ERROR: Expected/);
  });

  it('reports a malformed test as a TEST defect, never as an incomplete fix', () => {
    // The message for a non-running test must not blame the fix.
    const idx = GATE.search(/Transform failed|Failed to parse/);
    expect(idx).toBeGreaterThan(-1);
    const near = GATE.slice(Math.max(0, idx - 400), idx + 900);
    expect(near).toMatch(/did not run|never ran|could not (be )?(parsed|run|compile)|does not parse|malformed/i);
  });

  it('still blocks on a malformed test — a test that cannot run must not pass the gate', () => {
    const idx = GATE.search(/Transform failed|Failed to parse/);
    const near = GATE.slice(Math.max(0, idx - 400), idx + 900);
    expect(near).toMatch(/block\b/i);
  });

  it('keeps the fix-is-suspect wording only for a test that actually executed', () => {
    // The original message must survive, but now be reachable only after the
    // parse-failure branch has been ruled out.
    const fixMsgIdx = GATE.indexOf('the fix is incomplete or the test is wrong');
    const parseIdx = GATE.search(/Transform failed|Failed to parse/);
    expect(fixMsgIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeLessThan(fixMsgIdx);
  });
});
