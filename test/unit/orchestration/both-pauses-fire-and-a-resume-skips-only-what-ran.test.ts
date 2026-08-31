/**
 * THE TWO PAUSES, AND WHAT A RESUME IS ALLOWED TO SKIP.
 *
 * Every metrolinx run is launched with both pauses on: after the roster is minted, and before the
 * writer touches anything. They are the operator's review points, and a run that reaches the writer
 * unattended on a client repository is the thing they exist to prevent.
 *
 * The resume logic beside them has a documented live failure: checkpoint_dir resolves PER LANE, so
 * `save_run_checkpoint pre-writer` writes inside a lane while the parent's post-roster save goes to
 * the run root. resume_skip_env ran in the PARENT and read only the parent's file, so a
 * multi-codeline run resumed at post-roster and replayed the whole spec pass — ~50 minutes, and it
 * REGENERATED the specs the operator had just approved at pause 2. The writer would have built
 * against artefacts nobody reviewed.
 *
 * A run is therefore as far along as its LEAST advanced lane. That is what makes skipping safe.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');

/** Ask the real shell function, under a chosen environment. */
function ask(fn: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)} >/dev/null 2>&1; ${fn}; echo "rc=$?"`], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0',
      EPAM_PAUSE_BEFORE_WRITER: '', EPAM_PAUSE_AFTER_AGENT_MINT: '',
      EPAM_RESUMED_FROM_STAGE: '', ...env },
  });
  return (r.stdout || '').trim().split('\n').pop() === 'rc=0';
}

describe('both pauses fire when the operator asks for them', () => {
  it('pause 2 fires with EPAM_PAUSE_BEFORE_WRITER set', () => {
    // The review point before anything is written to a client repository.
    expect(ask('should_pause_before_writer', { EPAM_PAUSE_BEFORE_WRITER: '1' }),
      'the writer pause did not fire when it was asked for').toBe(true);
  }, 90_000);

  it('pause 1 fires with EPAM_PAUSE_AFTER_AGENT_MINT set', () => {
    expect(ask('should_pause_after_agent_mint', { EPAM_PAUSE_AFTER_AGENT_MINT: '1' }),
      'the roster pause did not fire when it was asked for').toBe(true);
  }, 90_000);

  it('and NEITHER fires when it was not asked for', () => {
    // The negative half: a pause that always fires would stop every unattended run.
    expect(ask('should_pause_before_writer'), 'the writer pause fired unasked').toBe(false);
    expect(ask('should_pause_after_agent_mint'), 'the roster pause fired unasked').toBe(false);
  }, 90_000);

  it.each(['1', 'true', 'yes', 'TRUE'])('is asked for by %s, not just by "1"', (v) => {
    // An operator writing EPAM_PAUSE_BEFORE_WRITER=true and getting no pause would reach the writer
    // unattended believing they had a review point.
    expect(ask('should_pause_before_writer', { EPAM_PAUSE_BEFORE_WRITER: v }),
      `"${v}" did not turn the pause on`).toBe(true);
  }, 90_000);

  it.each(['', '0', 'false', 'no'])('is NOT asked for by %s', (v) => {
    expect(ask('should_pause_before_writer', { EPAM_PAUSE_BEFORE_WRITER: v }),
      `"${v}" turned the pause on`).toBe(false);
  }, 90_000);
});

describe('a resume does not re-ask a pause the run already passed', () => {
  it('a resume PAST the writer pause does not stop there again', () => {
    // Otherwise a resumed run pauses at a review point the operator already gave.
    expect(ask('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', EPAM_RESUMED_FROM_STAGE: 'pre-writer' }),
    'a resume stopped again at a pause it had already passed').toBe(false);
  }, 90_000);

  it('but a resume BEFORE it still pauses — the review has not happened yet', () => {
    expect(ask('should_pause_before_writer',
      { EPAM_PAUSE_BEFORE_WRITER: '1', EPAM_RESUMED_FROM_STAGE: 'post-roster' }),
    'a resume skipped a review point that had not been given').toBe(true);
  }, 90_000);

  it('the roster pause is passed by any later stage', () => {
    for (const reached of ['post-roster', 'post-spec', 'pre-writer']) {
      expect(ask('should_pause_after_agent_mint',
        { EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_RESUMED_FROM_STAGE: reached }),
      `a resume from ${reached} asked for the roster pause again`).toBe(false);
    }
  }, 90_000);

  it('an UNKNOWN resumed stage skips nothing — it ranks below every real stage', () => {
    // Skipping too much silently drops work that was never done. An unrecognised stage must not be
    // read as "further along than everything".
    expect(ask('should_pause_after_agent_mint',
      { EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_RESUMED_FROM_STAGE: 'not-a-stage' }),
    'an unknown stage was treated as past the roster pause').toBe(true);
  }, 90_000);

  it('a FRESH run skips nothing, because nothing published a resumed stage', () => {
    // EPAM_RESUMED_FROM_STAGE is published by resume_skip_env at startup; a fresh run never sets it.
    expect(ask('should_pause_before_writer', { EPAM_PAUSE_BEFORE_WRITER: '1' }),
      'a fresh run skipped a pause').toBe(true);
  }, 90_000);
});
