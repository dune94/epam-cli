/**
 * A BUDGET THE CLOCK CANNOT HONOUR IS NOT A BUDGET. IT IS A SCHEDULED KILL THAT STILL BILLS.
 *
 * run_story_with_watchdog sizes each story's wall from iterations x secondsPerIteration,
 * capped at storyTimeoutMaxSecs, floored at storyTimeoutSecs. It read EPAM_MAX_ITERATIONS —
 * which is UNSET in the parent process. claude.sh computes _effective_max_iterations per
 * model, per attempt, MINUTES AFTER the parent has already fixed the wall, and the value
 * flows downward to the LLM invocation and never upward to the watchdog policing it.
 *
 * So the derivation branch NEVER EXECUTED. Its log line — "[orch] story timeout Xs -> Ys
 * (derived from N iterations...)" — has never appeared in any run log, and the wall silently
 * stayed at the configured FLOOR. The `if` had no `else`, so absent input did not fail and
 * did not default: it skipped, and the floor then read as a deliberate choice.
 *
 * MEASURED LIVE 2026-08-11: MiniMax-M3 granted 185 iterations at 12s = 2,220s of AUTHORISED
 * work, policed by an 1,800s wall, with a 5,400s cap never approached. 37 minutes of work
 * under a 30-minute clock, 90 minutes of headroom unused. The same 1800s timeout fired again
 * on the 23:34 run — twice in one day.
 *
 * And escalation made it worse: rungs RAISE the budget (28 -> 185 -> 345) while the wall
 * stayed at the floor, so the recovery mechanism increased the probability of the timeout it
 * was recovering from.
 *
 * The 2026-08-10 fix for this EXISTS IN THE CODE AND HAD NEVER EXECUTED ONCE — written and
 * wired to a variable not in scope at that call site. Present, plausible, inert.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const STATE_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wall-')); dirs.push(d);
  return d;
}

/** Run the REAL persistence helpers from the REAL library. */
function roundTrip(iters: string): { written: string; read: string } {
  const d = tmp();
  const script = `
    . '${STATE_LIB}'
    write_story_effective_iterations '${d}' 'AMSD-2041' '${iters}'
    read_story_effective_iterations  '${d}' 'AMSD-2041'
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return { written: iters, read: r.stdout.trim() };
}

/** Run the REAL _derive_story_wall from run-agent-orchestration.sh. */
function derive(base: number, iters: number, spi: string, cap: string): string {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('    _derive_story_wall() {');
  expect(start, 'the derivation helper is gone — the test is stale, not the code').toBeGreaterThan(-1);
  const end = src.indexOf('\n    }\n', start) + 6;
  const fn = src.slice(start, end).replace(/^ {4}/gm, '');
  const script = [`_spi='${spi}'`, `_tmax='${cap}'`, fn, `_derive_story_wall ${base} ${iters}`].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe('the value travels UPWARD — the child persists what it granted', () => {
  it('a granted iteration budget round-trips through the state file', () => {
    const { read } = roundTrip('185');
    expect(read).toBe('185');
  });

  it('absent state reads 0 — never a fabricated number', () => {
    const d = tmp();
    const r = spawnSync('bash', ['-c', `. '${STATE_LIB}'; read_story_effective_iterations '${d}' 'NOPE'`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('0');
  });

  it('a non-numeric budget is refused, not written', () => {
    const d = tmp();
    spawnSync('bash', ['-c', `. '${STATE_LIB}'; write_story_effective_iterations '${d}' 'S' 'lots'`], { encoding: 'utf8' });
    const dir = join(d, 'story-retry-state');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('claude.sh actually CALLS the writer — a helper nobody invokes is inert', () => {
    // The 2026-08-10 fix failed exactly this way: correct code, never executed.
    const src = readFileSync(CLAUDE_SH, 'utf8');
    expect(src).toMatch(/write_story_effective_iterations "\$LOG_DIR" "\$story_id" "\$_effective_max_iterations"/);
  });

  it('the parent READS it rather than the unset env var', () => {
    const src = readFileSync(ORCH, 'utf8');
    expect(src).toContain('read_story_effective_iterations');
    const fn = src.slice(src.indexOf('run_story_with_watchdog() {'), src.indexOf('\n    set +e'));
    expect(fn, 'still gated on an env var the parent never has').not.toMatch(/\$\{EPAM_MAX_ITERATIONS:-\}/);
  });
});

describe('THE WALL HONOURS THE BUDGET', () => {
  it('the live case: 185 iterations x 12s beats the 1800s floor', () => {
    // The exact numbers that killed AMSD-2041, twice.
    expect(derive(1800, 185, '12', '5400')).toBe('2220');
  });

  it('the cap still bounds it', () => {
    expect(derive(1800, 1000, '12', '5400')).toBe('5400');
  });

  it('the floor still wins when the derived wall is smaller', () => {
    expect(derive(1800, 28, '12', '5400')).toBe('1800');
  });

  it('an escalated budget raises the wall — recovery must not shrink its own clock', () => {
    const rung0 = Number(derive(1800, 28, '12', '5400'));
    const rung3 = Number(derive(1800, 345, '12', '5400'));
    expect(rung3, 'escalation widened the gap between work authorised and time permitted')
      .toBeGreaterThan(rung0);
  });

  it('no persisted budget yet -> the floor, unchanged', () => {
    expect(derive(1800, 0, '12', '5400')).toBe('1800');
  });

  it('no secondsPerIteration -> the base, unchanged (and the caller warns)', () => {
    expect(derive(1800, 185, '', '5400')).toBe('1800');
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'an undeclared secondsPerIteration must be reported, not silently skipped')
      .toMatch(/secondsPerIteration is not configured/);
  });
});

describe('IT IS RE-DERIVED PER ATTEMPT, NOT ONCE PER STORY', () => {
  it('the retry path re-derives after the escalation', () => {
    // Scaling the OLD wall by a fixed multiplier polices the NEW budget with the previous
    // rung's arithmetic — which is how escalation kept making the timeout more likely.
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('while [ "$_rc" -eq 124 ]');
    expect(start, 'the ladder retry loop is gone — the test is stale, not the code').toBeGreaterThan(-1);
    // Search for the loop terminator FROM the loop start. Searching from 0 finds an earlier
    // `done` and silently yields an EMPTY slice, against which every toContain fails and no
    // amount of correct code would pass.
    const loop = src.slice(start, src.indexOf('\n        done', start));
    expect(loop.length, 'empty slice — the assertions below would be meaningless').toBeGreaterThan(200);
    expect(loop).toContain('read_story_effective_iterations');
    expect(loop).toContain('_derive_story_wall');
  });

  it('the derivation is announced when it changes the wall', () => {
    // Its absence from every run log to date is the only reason this went unnoticed.
    const src = readFileSync(ORCH, 'utf8');
    expect(src).toMatch(/story timeout \$\{timeout_secs\}s -> \$\{_derived\}s \(derived from/);
    expect(src).toMatch(/retry wall .*re-derived from/);
  });
});
