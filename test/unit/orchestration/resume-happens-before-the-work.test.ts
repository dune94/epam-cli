/**
 * A RESUME THAT RUNS AFTER THE WORK IS NOT A RESUME.
 *
 * EPAM_RESUME_RUN restores what a previous run persisted and skips what that checkpoint
 * already paid for. The block that does it used to sit past the entry-point dispatch — and a
 * Jira run calls _run_jira_pipeline and EXITS there, so on that shape it was never reached.
 *
 * Live 2026-08-07: the operator reviewed a roster at the pause, resumed, and the run
 * re-ingested and re-minted from scratch. The reviewed roster was discarded and a different
 * one ran. The pause was ceremonial and nothing said so — ingest simply started again, which
 * looks like a resume beginning its work.
 *
 * Ordering is the whole fix, so ordering is what this asserts: the resume decision must
 * precede every dispatch that can terminate the run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('the resume decision precedes the work', () => {
  it('the resume block comes BEFORE the jira dispatch that exits', () => {
    const resume = ORCH.indexOf('EPAM_RESUME_RUN:-}" ]; then');
    const dispatch = ORCH.indexOf('_run_jira_pipeline; exit $?');
    expect(resume, 'the resume block is gone').toBeGreaterThan(-1);
    expect(dispatch, 'the jira dispatch is gone').toBeGreaterThan(-1);
    expect(
      resume,
      'resume is evaluated after a dispatch that exits — on a Jira run it never happens',
    ).toBeLessThan(dispatch);
  });

  // Window widened 2026-08-10: resume_spec_output_present() (the guard that refuses a resume
  // whose spec output has been overwritten) is defined between this comment and the resume
  // block, so a 2200-char slice no longer reached restore_run_checkpoint.
  it('it restores the checkpoint and derives what to skip', () => {
    const start = ORCH.indexOf('# RESUME IS DECIDED BEFORE ANY WORK');
    const block = ORCH.slice(start, start + 6000);
    expect(block).toMatch(/restore_run_checkpoint/);
    expect(block).toMatch(/resume_skip_env/);
  });

  it('the resumed run adopts the run id its roster was stored against', () => {
    const start = ORCH.indexOf('# RESUME IS DECIDED BEFORE ANY WORK');
    const block = ORCH.slice(start, start + 6000);
    expect(
      block,
      'the roster store is keyed by run id — without adopting it, the reviewed roster is not re-applied',
    ).toMatch(/export ORCH_RUN_ID="\$EPAM_RESUME_RUN"/);
  });

  it('a resume that cannot be honoured HALTS rather than running on stale state', () => {
    const start = ORCH.indexOf('# RESUME IS DECIDED BEFORE ANY WORK');
    const block = ORCH.slice(start, start + 6000);
    expect(block).toMatch(/refusing to continue against un-restored state/);
    expect(block).toMatch(/refusing to guess/);
  });

  it('lanes do not resume — the parent decides and they inherit', () => {
    const start = ORCH.indexOf('# RESUME IS DECIDED BEFORE ANY WORK');
    const block = ORCH.slice(start, start + 6000);
    expect(
      block,
      'each lane would restore the checkpoint over its own state',
    // The role is now derived once, at the top of the script, so the guard reads through the
    // named helper instead of testing the raw variable here.
    ).toMatch(/if is_parent && \[ -n "\$\{EPAM_RESUME_RUN/);
  });
});

describe('the mint step honours the skip the checkpoint asks for', () => {
  const STEP = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');

  it('EPAM_SKIP_AGENT_MINT suppresses re-proposing', () => {
    expect(STEP).toMatch(/EPAM_SKIP_AGENT_MINT === '1'/);
    expect(STEP).toMatch(/mint skipped/i);
  });

  it('assignment still runs, so the restored roster is validated rather than trusted', () => {
    const skipIdx = STEP.indexOf("EPAM_SKIP_AGENT_MINT === '1'");
    const assignIdx = STEP.indexOf('assignAgentRoles');
    expect(assignIdx, 'assignment does not run after a skipped mint').toBeGreaterThan(skipIdx);
  });
});
