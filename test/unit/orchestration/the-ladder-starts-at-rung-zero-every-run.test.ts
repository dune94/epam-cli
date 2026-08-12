/**
 * A LADDER THAT DOES NOT RESET IS NOT A LADDER — IT IS A CEILING.
 *
 * lib/story-retry-state.sh persists three files per story so the rung survives across
 * claude.sh SUBPROCESSES within one run ("retries MUST proceed up the rungs, nothing is
 * allowed to intercede"):
 *
 *     <story>.count      the rung counter
 *     <story>.model      the ESCALATED MODEL
 *     <story>.iterbump   the iteration bump
 *
 * None of it may survive a RUN. pre-run-reset.sh cleared '*.count' and announced "every
 * story starts this run at rung 0" — true of the counter, false of the run.
 *
 * LIVE 2026-08-11. AMSD-2041.model held 'moonshotai/kimi-k3' from a FAILED 15:57 run. A
 * fresh 23:34 launch cleared the counter, printed rung 0, and then invoked the writer with
 *
 *     [InferenceLadder] AMSD-2041 resuming on 'moonshotai/kimi-k3'
 *                       (escalated in an earlier invocation)
 *
 * — the TOP rung of four. Every attempt ran on the most expensive model, and the recovery
 * mechanisms (HealingBroken, FailureDiversity) had nowhere left to climb. Worse, that
 * escalation encoded a verdict about MODEL CAPABILITY which was really a verdict about a
 * TRUNCATED PROMPT — a defect fixed hours earlier. The stale conclusion outlived its cause.
 *
 * This is the SECOND time an extension whitelist here has gone stale: the 2026-08-07 repair
 * added '*.count' when that was the only file, then .model and .iterbump were introduced and
 * nobody updated the sweep. So the fix is to clear the DIRECTORY, which covers a file type
 * added tomorrow by someone who never reads this test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const STATE_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Extract the retry-state block and run it against a real directory. */
function runClearBlock(files: string[]): { status: number | null; out: string; left: string[] } {
  const d = mkdtempSync(join(tmpdir(), 'ladderstate-')); dirs.push(d);
  const stateDir = join(d, 'story-retry-state');
  mkdirSync(stateDir, { recursive: true });
  for (const f of files) writeFileSync(join(stateDir, f), 'x');

  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_RETRY_STATE_DIR="$LOG_DIR/story-retry-state"');
  expect(start, 'retry-state block not found — the test is stale, not the code').toBeGreaterThan(-1);
  const end = src.indexOf('\nfi\n', start) + 4;
  const block = src.slice(start, end);

  const script = [
    "RED=''; GREEN=''; YELLOW=''; NC=''",
    'info()    { echo "[info] $*"; }',
    'success() { echo "[ok] $*"; }',
    'fail()    { echo "[FAIL] $*" >&2; exit 1; }',
    `LOG_DIR="${d}"`,
    block,
  ].join('\n');

  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    left: existsSync(stateDir) ? readdirSync(stateDir) : [],
  };
}

describe('the state library really does persist more than a counter', () => {
  it('it writes .count, .model AND .iterbump', () => {
    // If this ever stops being true the test below is over-broad, not wrong — but the
    // whitelist bug came from exactly this set drifting unnoticed.
    const lib = readFileSync(STATE_LIB, 'utf8');
    for (const ext of ['.count', '.model', '.iterbump']) {
      expect(lib, `${ext} is no longer persisted — re-check the reset`).toContain(ext);
    }
  });
});

describe('EVERY STORY STARTS AT RUNG ZERO, ON ITS PRD MODEL', () => {
  it('clears the rung counter', () => {
    const { left } = runClearBlock(['AMSD-2041.count']);
    expect(left).toEqual([]);
  });

  it('clears the ESCALATED MODEL — the file that caused the live defect', () => {
    const { left } = runClearBlock(['AMSD-2041.model']);
    expect(left, 'a story would resume on a model nobody chose').toEqual([]);
  });

  it('clears the iteration bump', () => {
    const { left } = runClearBlock(['AMSD-2041.iterbump']);
    expect(left).toEqual([]);
  });

  it('clears ALL of them together — the live state, exactly', () => {
    const { left, status } = runClearBlock([
      'AMSD-2041.count', 'AMSD-2041.model', 'AMSD-2041.iterbump',
      'AMSD-1820.count', 'AMSD-1820.model',
    ]);
    expect(left).toEqual([]);
    expect(status).toBe(0);
  });

  it('clears a state file type that does not exist yet', () => {
    // The whole point of clearing the DIRECTORY. This is the assertion an extension
    // whitelist cannot satisfy, and it has now gone stale twice.
    const { left } = runClearBlock(['AMSD-2041.somethingaddedlater']);
    expect(left, 'a new state file type would survive the reset').toEqual([]);
  });

  it('says how many it cleared, and does not claim rung 0 falsely', () => {
    const { out } = runClearBlock(['AMSD-2041.count', 'AMSD-2041.model']);
    expect(out).toMatch(/Cleared 2 inference-ladder state file/);
    expect(out).toMatch(/rung 0/);
  });

  it('an empty directory is not an error and says nothing', () => {
    const { status, out } = runClearBlock([]);
    expect(status).toBe(0);
    expect(out).not.toMatch(/Cleared/);
  });
});

describe('THE RESET DOES NOT LIE', () => {
  it('a directory it cannot clear ABORTS rather than announcing a clean slate', () => {
    // Proceeding here means starting mid-ladder on a model nobody chose. This script's
    // entire job is the clean slate, so it must not report one it did not deliver.
    const src = readFileSync(RESET, 'utf8');
    const start = src.indexOf('_RETRY_STATE_DIR="$LOG_DIR/story-retry-state"');
    const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);
    expect(block).toMatch(/_RETRY_LEFT/);
    expect(block, 'a leftover file must not fall through to the success message').toMatch(/fail /);
  });

  it('the sweep is by DIRECTORY, not by a list of extensions', () => {
    const src = readFileSync(RESET, 'utf8');
    const start = src.indexOf('_RETRY_STATE_DIR="$LOG_DIR/story-retry-state"');
    const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);
    expect(block, "an extension whitelist here has gone stale twice").not.toMatch(/-name '\*\./);
  });
});
