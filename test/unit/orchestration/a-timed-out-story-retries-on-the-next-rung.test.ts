/**
 * A TIMED-OUT STORY RETRIES ON THE NEXT RUNG — THE ONE LADDER, NOT A SECOND ONE.
 *
 * regintel 140717Z (2026-09-21): REGI-003b, REGI-010-A, REGI-002 and REGI-004-A each hit the story
 * wall. The watchdog announced "attempt 2/6 on the next ladder rung" and re-launched — and the log
 * of every retry read `Attempt[1] provider=minimax model=MiniMax-M3`: the same rung, the counter
 * back at 1. The watchdog's climb was a PRD hot-swap keyed on ladder variables the orchestrator's
 * shell does not hold, so it swapped nothing and said it had; the writer's own ladder (the persisted
 * retry rung claude.sh climbs on re-entry) was never touched. Two ladders, one of them decorative.
 *
 * The watchdog now advances the story's persisted rung — the same call the review loop makes — so
 * the retry climbs where the writer looks, and it says so only when it did. Driven through the REAL
 * run_story_with_watchdog with a stub CLAUDE_SH that times out once and records what it was handed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run() {
  const d = mkdtempSync(join(tmpdir(), 'wd-rung-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', effort: 'medium', model: 'MiniMax-M3', ladderTier: 'medium' }] }));
  // The stub writer: first call sleeps past the wall (exit 124 via timeout), second call records the
  // rung it finds on disk and exits 0.
  const stub = join(d, 'claude.sh'); const seen = join(d, 'seen.txt');
  writeFileSync(stub, `#!/usr/bin/env bash
n=$(cat "${d}/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${d}/calls"
if [ "$n" -eq 1 ]; then sleep 30; exit 0; fi
printf 'call=%s count=%s\\n' "$n" "$(cat "${logDir}/story-retry-state/S-1.count" 2>/dev/null || echo none)" >> "${seen}"
exit 0
`);
  chmodSync(stub, 0o755);
  const script = `
    set -uo pipefail
    SCRIPT_DIR="${SCRIPTS}"; LOG_DIR="${logDir}"; PRD_FILE="${prd}"; MAIN_PRD_FILE="${prd}"; CLAUDE_SH="${stub}"
    EPAM_STORY_TIMEOUT_SECS=1; EPAM_WATCHDOG_RETRY_MULTIPLIER=2; EPAM_MAX_RETRIES=7
    log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; info(){ :; }; success(){ :; }
    . "$SCRIPT_DIR/lib/story-retry-state.sh"
    . "$SCRIPT_DIR/lib/story-watchdog.sh"
    write_story_retry_count "$LOG_DIR" S-1 0
    run_story_with_watchdog S-1 "${logDir}/main-S-1.log"; echo "RC=$?"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 120_000 });
  let seenTxt = ''; try { seenTxt = readFileSync(seen, 'utf8'); } catch { /* not called twice */ }
  return { out: (r.stdout || '') + (r.stderr || ''), seen: seenTxt };
}

describe('a timed-out story retries on the next rung', () => {
  const r = run();

  it('the retry actually happened — otherwise nothing below is tested', () => {
    expect(r.seen, r.out.slice(-1500)).toMatch(/call=2/);
  });

  it("the writer's persisted rung had advanced before the retry was launched", () => {
    // Rung 0 spans counts 0-1; the next rung starts at count 2. The stub read the count on disk.
    const count = Number(/count=(\S+)/.exec(r.seen)?.[1]);
    expect(count, `the retry found count=${count} — the same rung it timed out on:\n${r.out.slice(-1200)}`).toBeGreaterThanOrEqual(2);
  });

  it('the watchdog reports the climb it made, not one it did not', () => {
    expect(r.out).toMatch(/rung/i);
    expect(r.out).not.toMatch(/on the next ladder rung/);   // the old, unconditional claim
  });
});
