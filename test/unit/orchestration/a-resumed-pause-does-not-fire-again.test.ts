/**
 * A PAUSE THE RUN HAS ALREADY BEEN THROUGH MUST NOT FIRE AGAIN.
 *
 * The two pause predicates read their env var and nothing else. The env var lives in the project's
 * config.env, so it is set for EVERY run of that project — including the resume whose entire purpose
 * is to continue PAST the pause the operator has just reviewed.
 *
 * That made pause 1 a trap with no exit: resume, re-pause, resume, re-pause. It went unnoticed only
 * because the pause used `return` instead of `exit`, so the resume "continued" by accident. Fixing
 * the halt (2026-08-28) turned an accident that behaved correctly into a stall that could not.
 *
 * Skipping too little wastes the pause; skipping too much silently drops work that was never done.
 * So the rule is stage-based, using the ranking the checkpoint machinery already carries: a pause is
 * skipped only when the run being resumed is recorded as having reached the stage that pause guards.
 * An unknown or unreadable stage ranks 0 and therefore skips NOTHING — a failed lookup must never be
 * the reason a human review point is bypassed.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project config dir holding one run recorded at `stage`. */
function projectWithRun(runId: string, stage: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'resume-pause-')); dirs.push(d);
  if (stage !== null) {
    const ck = join(d, 'runs', runId, 'checkpoint');
    mkdirSync(ck, { recursive: true });
    writeFileSync(join(ck, 'checkpoint.json'), JSON.stringify({ stage, phase: 'core', stories: [] }));
  }
  return d;
}

/** Run any snippet against the real library. */
function inLib(snippet: string, env: Record<string, string>, projectDir: string) {
  return spawnSync('bash', ['-c',
    `is_truthy(){ case "$(printf '%s' "\${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0;; *) return 1;; esac; }
     info(){ :; }; warning(){ :; }; log(){ :; }; is_parent(){ return 0; }
     source ${JSON.stringify(LIB)}
     ${snippet}`,
  ], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: projectDir, EPAM_RESUME_RUN: '', ...env },
  });
}

/** Ask the real predicate, in the real file, under the given environment. */
function asks(fn: string, env: Record<string, string>, projectDir: string): boolean {
  const r = spawnSync('bash', ['-c',
    `is_truthy(){ case "$(printf '%s' "\${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0;; *) return 1;; esac; }
     info(){ :; }; warning(){ :; }; log(){ :; }
     source ${JSON.stringify(LIB)}
     if ${fn}; then echo PAUSE; else echo GO; fi`,
  ], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: projectDir, EPAM_RESUME_RUN: '', ...env },
  });
  const out = (r.stdout || '').trim().split('\n').pop() || '';
  expect(['PAUSE', 'GO'], `predicate did not answer: ${r.stdout}${r.stderr}`).toContain(out);
  return out === 'PAUSE';
}

const RUN = '20260828T150058Z';

/**
 * The env a real resume runs under: whatever resume_skip_env publishes at startup, exported exactly
 * as run-agent-orchestration.sh exports it. Hand-setting these would test my assumption about what
 * startup emits rather than what it emits.
 */
function resumeEnv(projectDir: string, runId = RUN): Record<string, string> {
  const r = inLib(`resume_skip_env ${runId}`, {}, projectDir);
  const env: Record<string, string> = { EPAM_RESUME_RUN: runId };
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

describe('PAUSE 1 — after the roster', () => {
  it('fires on a fresh run', () => {
    const p = projectWithRun(RUN, 'post-roster');
    expect(asks('should_pause_after_agent_mint', { EPAM_PAUSE_AFTER_AGENT_MINT: '1' }, p)).toBe(true);
  });

  it('does NOT fire again when resuming the run that already reached it', () => {
    const p = projectWithRun(RUN, 'post-roster');
    expect(asks('should_pause_after_agent_mint',
      { EPAM_PAUSE_AFTER_AGENT_MINT: '1', ...resumeEnv(p) }, p),
      'the resume re-pauses at the point it was resumed from — the run can never move forward')
      .toBe(false);
  });

  it('still fires when resuming a run that never got that far', () => {
    const p = projectWithRun(RUN, null);   // no checkpoint: stage unknown
    expect(asks('should_pause_after_agent_mint',
      { EPAM_PAUSE_AFTER_AGENT_MINT: '1', ...resumeEnv(p) }, p),
      'an unreadable stage skipped a human review point')
      .toBe(true);
  });

  it('is off when the project did not ask for it', () => {
    const p = projectWithRun(RUN, 'post-roster');
    expect(asks('should_pause_after_agent_mint', { EPAM_PAUSE_AFTER_AGENT_MINT: '' }, p)).toBe(false);
  });
});

describe('PAUSE 2 — before the writer', () => {
  it('SURVIVES a resume from pause 1', () => {
    // The point of the design: resume from pause 1, run the spec phase, stop at pause 2. If the
    // resume skipped both pauses it would run to the writer unattended.
    const p = projectWithRun(RUN, 'post-roster');
    expect(asks('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', ...resumeEnv(p) }, p),
      'resuming from pause 1 skipped pause 2 as well — the writer runs unreviewed')
      .toBe(true);
  });

  it('does NOT fire again when resuming a run already at the writer', () => {
    const p = projectWithRun(RUN, 'pre-writer');
    expect(asks('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', ...resumeEnv(p) }, p)).toBe(false);
  });

  it('fires on a fresh run', () => {
    const p = projectWithRun(RUN, 'pre-writer');
    expect(asks('should_pause_before_writer', { EPAM_PAUSE_BEFORE_WRITER: '1' }, p)).toBe(true);
  });
});

describe('THE STAGE A RESUME STARTED FROM IS A SNAPSHOT, NOT LIVE STATE', () => {
  /**
   * Found on a free rehearsal, 2026-08-28, and it would have been a PAID lesson otherwise.
   *
   * Pause 2 saves the pre-writer checkpoint and THEN asks whether the run has already passed
   * pre-writer — reading the file it wrote three lines earlier. Answer: yes, always. It skipped its
   * own pause and went into the writer unattended, which is the one thing pause 2 exists to prevent.
   *
   * So the comparison must be against the stage the resume STARTED from, captured once in the
   * parent before any lane exists, and never re-derived from a tree the run is actively writing to.
   */

  it('the real producer publishes the stage the resume started from', () => {
    // Driven by resume_skip_env rather than a hand-set variable: a fabricated snapshot would only
    // confirm my own assumption about what startup emits.
    const p = projectWithRun(RUN, 'post-roster');
    const r = inLib(`resume_skip_env ${RUN}`, {}, p);
    expect(r.stdout, `resume_skip_env failed: ${r.stderr}`)
      .toMatch(/^EPAM_RESUMED_FROM_STAGE=post-roster$/m);
  });

  it('pause 2 STILL fires after the run writes its own pre-writer checkpoint', () => {
    const p = projectWithRun(RUN, 'post-roster');
    // exactly what the live run does moments before asking: record pre-writer for THIS run
    const lane = join(p, 'runs', RUN, 'lanes', 'mocka', 'checkpoint');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'checkpoint.json'), JSON.stringify({ stage: 'pre-writer' }));

    expect(asks('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', EPAM_RESUME_RUN: RUN, EPAM_RESUMED_FROM_STAGE: 'post-roster' }, p),
      'the run wrote pre-writer, then read it back as proof it had already been reviewed, and '
      + 'walked into the writer with nobody looking')
      .toBe(true);
  });

  it('and a resume that genuinely started at the writer still skips it', () => {
    const p = projectWithRun(RUN, 'pre-writer');
    expect(asks('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', EPAM_RESUME_RUN: RUN, EPAM_RESUMED_FROM_STAGE: 'pre-writer' }, p))
      .toBe(false);
  });
});

describe('_pause_already_passed — the predicate both pauses defer to', () => {
  // Exercised by name, not only through its callers: a blocking function that no test has ever
  // heard of is how three guards reached production inert while the suite was green.

  const ask = (env: Record<string, string>, stage: string) => {
    const p = projectWithRun(RUN, 'post-roster');
    const r = inLib(`if _pause_already_passed ${stage}; then echo PASSED; else echo AHEAD; fi`, env, p);
    return (r.stdout || '').trim().split('\n').pop();
  };

  it('says a pause is still AHEAD when this is not a resume', () => {
    expect(ask({}, 'post-roster')).toBe('AHEAD');
  });

  it('says PASSED only once the resumed stage reaches the guarded one', () => {
    expect(ask({ EPAM_RESUMED_FROM_STAGE: 'post-roster' }, 'post-roster')).toBe('PASSED');
    expect(ask({ EPAM_RESUMED_FROM_STAGE: 'post-roster' }, 'pre-writer')).toBe('AHEAD');
    expect(ask({ EPAM_RESUMED_FROM_STAGE: 'pre-writer' }, 'post-roster')).toBe('PASSED');
  });

  it('treats an unrecognised stage as no progress at all', () => {
    expect(ask({ EPAM_RESUMED_FROM_STAGE: 'something-else' }, 'post-roster'),
      'an unknown stage was read as progress, skipping a review point').toBe('AHEAD');
  });
});
