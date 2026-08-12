/**
 * THE SAME CONSTANT CANNOT BOUND ONE ATTEMPT AND EIGHT OF THEM.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * EPAM_STORY_TIMEOUT_SECS (1800) is used at two different scopes:
 *
 *   claude.sh:9265                     timeout 1800   <- ONE LLM invocation
 *   run-agent-orchestration.sh:2012    timeout 1800   <- the WHOLE story, i.e. up to
 *                                                        MAX_RETRIES+1 = 8 attempts
 *
 * So a single attempt is permitted exactly as much wall clock as all eight together. The
 * outer wall cannot accommodate what the inner loop is authorised to do, at any value of
 * secondsPerIteration.
 *
 * MEASURED on the 2026-08-12 00:52 run. Wall 1 ran 00:54:28 -> 01:24:20 (1800s):
 *
 *     planning              62s
 *     writer attempt 1     829s
 *     analyst              120s
 *     writer attempt 2     631s
 *     gates                111s
 *     verification          27s
 *                        ------
 *                        ~1780s   -> SIGKILL at 1800s
 *
 * The iteration budget was ACCURATE: 120 iterations x 12s = 1440s against 1460s of real
 * writer time. secondsPerIteration is a good estimator OF ONE ATTEMPT. What it cannot
 * express is that a second attempt — plus planning, gates, verification and the analyst —
 * runs inside the same window.
 *
 * So the two walls get separate jobs:
 *   PER-ATTEMPT  iterations x secondsPerIteration + perAttemptOverhead. Polices productive
 *                work. Floored and capped as before.
 *   PER-STORY    perAttemptWall x maxAttempts, capped by its own ceiling. Its job is
 *                catching a HUNG process, not rationing work.
 *
 * Both derived from declared config. No seconds in the engine.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));

/** Run a helper from run-agent-orchestration.sh in isolation. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  expect(start, `${name} does not exist yet — that is what this test is for`).toBeGreaterThan(-1);
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end).replace(/^ {4}/gm, '').replace(/\blocal /g, '');
}

/** Both helpers are loaded: the story-scope one CALLS the attempt-scope one. */
function callHelper(name: string, args: string, env: Record<string, string>): string {
  const src = readFileSync(ORCH, 'utf8');
  // BOTH, always. _derive_story_wall_total calls _derive_attempt_wall, and loading only the
  // named one left that call undefined — awk then received an empty budget and printed 0,
  // which looks exactly like a wrong implementation rather than a broken harness.
  const fns = [extractFn(src, '_derive_attempt_wall'), extractFn(src, '_derive_story_wall_total')].join('\n');
  const assigns = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join('\n');
  const out = execFileSync('bash', ['-c', `set -u\nlog() { :; }\nwarning() { :; }\n${assigns}\n${fns}\n${name} ${args}`],
    { encoding: 'utf8' });
  return out.trim();
}

const SPI = String(CFG.timeouts.secondsPerIteration);
const FLOOR = String(CFG.timeouts.storyTimeoutSecs);
const CAP = String(CFG.timeouts.storyTimeoutMaxSecs);

describe('THE CONFIG DECLARES BOTH SCOPES', () => {
  it('declares the per-attempt overhead the iteration budget cannot express', () => {
    // Planning, gates, verification and the analyst all run inside the wall and are not
    // iterations. Measured ~320s across two attempts on the live run.
    expect(typeof CFG.timeouts.perAttemptOverheadSecs,
      'no declared overhead — the wall would again be sized as if only iterations existed')
      .toBe('number');
  });

  it('declares a ceiling for the WHOLE story, distinct from the per-attempt cap', () => {
    expect(typeof CFG.timeouts.storyWallMaxSecs, 'no whole-story ceiling declared').toBe('number');
    expect(CFG.timeouts.storyWallMaxSecs,
      'the story ceiling must exceed the per-attempt cap, or one attempt could exhaust the story')
      .toBeGreaterThan(CFG.timeouts.storyTimeoutMaxSecs);
  });

  it('declares how many attempts run inside one story wall', () => {
    expect(typeof CFG.retries.maxRetries).toBe('number');
  });
});

describe('THE PER-ATTEMPT WALL COVERS ITERATIONS PLUS OVERHEAD', () => {
  const env = () => ({
    _spi: SPI, _tmax: CAP,
    EPAM_PER_ATTEMPT_OVERHEAD_SECS: String(CFG.timeouts.perAttemptOverheadSecs),
  });

  it('adds the overhead to the iteration budget', () => {
    // The live attempt: 120 iterations x 12s = 1440s of writer work, and the attempt also
    // paid planning + gates + verification + analyst. 1440 alone is not the attempt.
    //
    // Measured against a LOW floor on purpose. Passing storyTimeoutSecs (1800) as the base
    // hides the overhead entirely — 1440+180 = 1620 is below it, so the floor wins and the
    // assertion would pass or fail for the wrong reason.
    const raw = Number(callHelper('_derive_attempt_wall', `1 120`, env()));
    expect(raw).toBe(120 * CFG.timeouts.secondsPerIteration + CFG.timeouts.perAttemptOverheadSecs);
  });

  it('the floor still wins when it exceeds the derived attempt wall', () => {
    // 120 iterations + overhead is 1620, below the 1800 floor — so 1800 stands.
    expect(Number(callHelper('_derive_attempt_wall', `${FLOOR} 120`, env()))).toBe(Number(FLOOR));
  });

  it('never drops below the configured floor', () => {
    expect(Number(callHelper('_derive_attempt_wall', `${FLOOR} 1`, env()))).toBe(Number(FLOOR));
  });

  it('never exceeds the per-attempt cap', () => {
    expect(Number(callHelper('_derive_attempt_wall', `${FLOOR} 100000`, env()))).toBe(Number(CAP));
  });

  it('an unknown budget yields the floor, not a guess', () => {
    expect(Number(callHelper('_derive_attempt_wall', `${FLOOR} 0`, env()))).toBe(Number(FLOOR));
  });
});

describe('THE STORY WALL ACCOMMODATES EVERY ATTEMPT THE INNER LOOP MAY RUN', () => {
  const env = () => ({
    _spi: SPI, _tmax: CAP,
    EPAM_PER_ATTEMPT_OVERHEAD_SECS: String(CFG.timeouts.perAttemptOverheadSecs),
    EPAM_STORY_WALL_MAX_SECS: String(CFG.timeouts.storyWallMaxSecs),
    EPAM_MAX_RETRIES: String(CFG.retries.maxRetries),
  });

  it('THE DEFECT: the story wall is no longer equal to a single attempt', () => {
    // This is the whole bug in one assertion. 1800 bounded one attempt AND all eight.
    const attempt = Number(callHelper('_derive_attempt_wall', `${FLOOR} 120`, env()));
    const story = Number(callHelper('_derive_story_wall_total', `${FLOOR} 120`, env()));
    expect(story, 'the story wall still cannot fit more than one attempt').toBeGreaterThan(attempt);
  });

  it('scales with the number of attempts the inner loop may run', () => {
    const attempt = Number(callHelper('_derive_attempt_wall', `${FLOOR} 120`, env()));
    const story = Number(callHelper('_derive_story_wall_total', `${FLOOR} 120`, env()));
    const attempts = CFG.retries.maxRetries + 1;
    expect(story).toBe(Math.min(attempt * attempts, CFG.timeouts.storyWallMaxSecs));
  });

  it('is bounded by its own declared ceiling', () => {
    const story = Number(callHelper('_derive_story_wall_total', `${FLOOR} 100000`, env()));
    expect(story).toBe(CFG.timeouts.storyWallMaxSecs);
  });

  it('the live case would no longer have been killed mid-story', () => {
    // Wall 1 needed ~1780s for TWO attempts and got 1800. Eight attempts of that shape
    // needs far more; the story wall must at minimum clear two.
    const story = Number(callHelper('_derive_story_wall_total', `${FLOOR} 120`, env()));
    expect(story, 'two attempts of the measured shape still would not fit').toBeGreaterThan(1780 * 2);
  });
});

describe('NO SECONDS IN THE ENGINE', () => {
  it('neither helper hardcodes a duration', () => {
    const src = readFileSync(ORCH, 'utf8');
    for (const name of ['_derive_attempt_wall', '_derive_story_wall_total']) {
      const start = src.indexOf(`${name}() {`);
      expect(start, `${name} missing`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n    }\n', start));
      const code = body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      expect(/\b(1800|2700|5400|10800|12|160)\b/.test(code), `${name} hardcodes a duration`).toBe(false);
    }
  });
});
