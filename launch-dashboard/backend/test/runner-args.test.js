/**
 * THE RUNNER'S ARGUMENT BUILDER — where a spooled request becomes a launch.
 *
 * This is the seam that has cost the most on this project, so it is tested in isolation from the
 * launching itself. Live 2026-09-02: the launch was issued with `EPAM_RESUME_RUN=...` as POSITIONAL
 * ARGUMENTS. tier3-metrolinx-run.sh reads those from the ENVIRONMENT and ignores argv, so the run
 * started FRESH, reset the codeline to develop, and destroyed a committed fix.
 *
 * The lesson: the environment a launch receives is not something to assemble by hand at the call
 * site. It is built here, in one place, and asserted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchEnv, buildLaunchArgv } from '../src/runner-args.js';

describe('the launch environment', () => {
  test('a plain run sets the provider set and DECLINES both pauses explicitly', () => {
    // THIS ASSERTION WAS `undefined`, AND THAT WAS THE DEFECT — it ratified the reasoning in
    // runner-args.js that "absent means absent". Absent is not absent to the pipeline: the
    // launcher goes on to source the project's config.env, which set both pauses to 1
    // unconditionally, so an unticked box was silently overwritten. Live 2026-09-04, the operator
    // ticked neither box and the run paused anyway.
    //
    // The requirement was always "the operator's answer reaches the pipeline". The old assertion
    // described the implementation instead, and a descriptive test ratifies the bug. `no` is an
    // answer, so it travels as one.
    const env = buildLaunchEnv({ ticket: 'AMSD-1919' }, { providerSet: 'claude' });
    assert.equal(env.EPAM_PROVIDER_SET, 'claude');
    assert.equal(env.EPAM_PAUSE_AFTER_AGENT_MINT, '0');
    assert.equal(env.EPAM_PAUSE_BEFORE_WRITER, '0');
    assert.equal(env.EPAM_RESUME_RUN, undefined);
  });

  test('pause 1 and pause 2 map to the variables the pipeline actually reads', () => {
    const env = buildLaunchEnv(
      { ticket: 'A-1', pauseAfterMint: true, pauseBeforeWriter: true }, { providerSet: 'claude' },
    );
    assert.equal(env.EPAM_PAUSE_AFTER_AGENT_MINT, '1');
    assert.equal(env.EPAM_PAUSE_BEFORE_WRITER, '1');
  });

  test('a resume sets EPAM_RESUME_RUN — the variable whose absence destroys work', () => {
    const env = buildLaunchEnv(
      { ticket: 'A-1', resumeRunId: '20260903T010438Z' }, { providerSet: 'claude' },
    );
    assert.equal(env.EPAM_RESUME_RUN, '20260903T010438Z');
  });

  test('a replay is NOT a resume: it must never carry EPAM_RESUME_RUN', () => {
    // A replay reproduces from the start; a resume continues a checkpoint. Carrying the resume id
    // into a replay would silently continue the original run instead of reproducing it.
    const env = buildLaunchEnv({ ticket: 'A-1', replayOf: 'abc', resumeRunId: null },
      { providerSet: 'claude' });
    assert.equal(env.EPAM_RESUME_RUN, undefined);
  });

  test('EVERY launch value is in the ENVIRONMENT, never in argv', () => {
    // The exact defect of 2026-09-02. argv carries only the launcher's own flags.
    const request = { ticket: 'A-1', pauseAfterMint: true, resumeRunId: 'R1' };
    const argv = buildLaunchArgv(request, { providerSet: 'claude' });
    const joined = argv.join(' ');
    for (const name of ['EPAM_RESUME_RUN', 'EPAM_PROVIDER_SET',
                        'EPAM_PAUSE_AFTER_AGENT_MINT', 'EPAM_PAUSE_BEFORE_WRITER']) {
      assert.ok(!joined.includes(name),
        `${name} was passed as an argument; the launcher reads it from the environment and would ignore it`);
    }
  });

  test('the launcher runs non-interactively, or it waits forever for a prompt', () => {
    // tier3-metrolinx-run.sh asks "Confirm: spend credits? [yes/N]" unless --yes. Under a runner
    // there is no TTY, `read` gets EOF, and the run aborts. Observed live.
    const argv = buildLaunchArgv({ ticket: 'A-1' }, { providerSet: 'claude' });
    assert.ok(argv.includes('--yes'), 'without --yes the launch blocks on a prompt and aborts');
  });

  test('retry extension is on, per the standing operator rule', () => {
    const env = buildLaunchEnv({ ticket: 'A-1' }, { providerSet: 'claude' });
    assert.equal(env.EPAM_RETRY_EXTENSION_ENABLED, '1');
  });

  test('refuses to build a launch with no provider set rather than letting one be guessed', () => {
    // A guessed vendor is how MiniMax reached a claude run. If nothing declares it, FAIL LOUDLY.
    assert.throws(() => buildLaunchEnv({ ticket: 'A-1' }, {}), /provider set/i);
  });

  test('refuses a request with no ticket', () => {
    assert.throws(() => buildLaunchEnv({}, { providerSet: 'claude' }), /ticket/i);
  });
});
