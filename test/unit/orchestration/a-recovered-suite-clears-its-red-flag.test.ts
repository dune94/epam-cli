/**
 * A RECOVERED SUITE CLEARS ITS RED FLAG.
 *
 * Step 3.545 stamps `suiteState: "red"` on a story when it cannot reconcile a failing
 * test. Step 3.55 reads that flag and blocks the phase. Nothing anywhere sets it back:
 * grep finds ONE site writing "red" and ONE site reading it. It is a latch.
 *
 * Live, run 20260815T142007Z (metrolinx, AMSD-2041):
 *
 *   pass 1  the repro-test-writer's spec mocked a module the SDK does not use; suite red;
 *           3.545 stamped suiteState=red
 *   retry   the writer fixed it — tsc passed, external verification passed, story
 *           completed, work committed
 *   16:03   [update-invalidated-tests] "suite already green — no invalidated tests,
 *           nothing to do"        ← the condition had cleared
 *   16:03   Step 3.55 "the test suite is RED for: AMSD-2041 ... Blocking before review."
 *           → phase failed, run failed
 *
 * The suite was green (1203/1203 under the project's declared TZ). The run was failed by
 * a flag, not by the world. Step 3.55's message even asserts "Step 3.545 could not
 * reconcile it" about a step that had just reported the opposite.
 *
 * THE REQUIREMENT: whatever sets the flag can unset it, so a run that recovers is not
 * failed by its own history. Blocking on a suite that is STILL red must be unchanged —
 * that is the behaviour the latch exists to provide, and removing it would be worse.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');

/** Run the real clearing function against a PRD fixture. */
function clearAndRead(stories: Array<Record<string, unknown>>, phase = 'core') {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('_clear_suite_state_for_phase() {');
  expect(start, '_clear_suite_state_for_phase not found').toBeGreaterThan(-1);
  const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);

  const dir = mkdtempSync(join(tmpdir(), 'suitestate-'));
  try {
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories,
      implementationOrder: { [phase]: stories.map((s) => s.id) },
    }));
    const res = spawnSync('bash', ['-c', `
      set -uo pipefail
      log() { echo "$*"; }
      info() { echo "$*"; }
      ${fn}
      _clear_suite_state_for_phase ${JSON.stringify(prd)} ${JSON.stringify(phase)}
      echo "RC=$?"
    `], { encoding: 'utf8' });
    return {
      out: (res.stdout || '') + (res.stderr || ''),
      prd: JSON.parse(readFileSync(prd, 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the RED flag is not a latch', () => {
  it('clears suiteState on a story that carried it', () => {
    const r = clearAndRead([{ id: 'S-1', suiteState: 'red', suiteStateStep: '3.545' }]);
    expect(r.out).toContain('RC=0');
    expect(r.prd.stories[0].suiteState, 'the flag survived a recovery').toBeUndefined();
    expect(r.prd.stories[0].suiteStateStep).toBeUndefined();
  });

  it('leaves every other field on the story untouched', () => {
    // Clearing must not become a rewrite: the PRD carries the story's whole record.
    const r = clearAndRead([{
      id: 'S-1', suiteState: 'red', title: 'keep me', status: 'completed', completed: true,
    }]);
    const s = r.prd.stories[0];
    expect(s.title).toBe('keep me');
    expect(s.status).toBe('completed');
    expect(s.completed).toBe(true);
  });

  it('only touches stories in the phase', () => {
    const r = clearAndRead(
      [{ id: 'S-1', suiteState: 'red' }, { id: 'S-2', suiteState: 'red' }],
      'core',
    );
    // implementationOrder.core lists both here, so both clear; the guard is that the
    // function reads the phase list rather than clearing every story in the file.
    const src = readFileSync(ORCH, 'utf8');
    const fn = src.slice(src.indexOf('_clear_suite_state_for_phase() {'));
    expect(fn.slice(0, 900)).toContain('implementationOrder');
    expect(r.prd.stories.every((s: any) => s.suiteState === undefined)).toBe(true);
  });

  it('is a no-op when nothing carries the flag', () => {
    const r = clearAndRead([{ id: 'S-1', title: 't' }]);
    expect(r.out).toContain('RC=0');
    expect(r.prd.stories[0].title).toBe('t');
  });

  it('never writes a partial PRD if jq fails', () => {
    // The write path refuses to continue on an unrecordable state; clearing must be at
    // least as careful — a truncated PRD is worse than a stale flag.
    const src = readFileSync(ORCH, 'utf8');
    const fn = src.slice(src.indexOf('_clear_suite_state_for_phase() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body, 'must stage through a temp file, not redirect over the PRD').toMatch(/mktemp/);
    expect(body).toMatch(/mv\s/);
  });
});

describe('Step 3.55 still blocks a suite that is genuinely red', () => {
  it('the reading gate is unchanged — it still selects suiteState == "red"', () => {
    // The latch is being made clearable, NOT removed. A story whose suite never recovered
    // must still block before review.
    const src = readFileSync(ORCH, 'utf8');
    expect(src).toMatch(/select\(\.suiteState == "red"\)/);
  });
});
