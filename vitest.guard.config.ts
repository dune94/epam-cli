import { defineConfig } from 'vitest/config';

/**
 * THE GUARD SET — the regression net that is actually run.
 *
 * The full suite is 998 files and 216 of them are red. A suite that takes minutes and fails a
 * fifth of the time cannot tell anyone whether a change broke something: every run needs a human
 * to decide which failures were already there, so in practice nobody runs it and nothing is
 * guarded. Ten pipeline defects reached live runs on 2026-08-17 with that suite green-ish in the
 * background.
 *
 * This is the opposite trade: a small set that must be GREEN, must be FAST, and covers the seams
 * where the pipeline has actually broken. If it goes red, something broke just now.
 *
 * ADMISSION IS DELIBERATE. A file joins this list when it guards a seam a live run has failed at,
 * it passes, and it runs in well under a second — not because it exists. Adding a slow or flaky
 * test here destroys the property that makes the list worth running.
 *
 * Run: npm run test:guard
 */
export default defineConfig({
  test: {
    include: [
      // Lanes and phases — a lane that looped zero times and reported success.
      'test/unit/orchestration/a-lane-with-no-phases-did-nothing-and-said-success.test.ts',
      // Reset completeness — stale PRD assignments, prompts and artefacts crossing runs.
      'test/unit/orchestration/prd-kept-the-previous-runs-assignments.test.ts',
      'test/unit/orchestration/reset-leaves-last-runs-generated-artefacts.test.ts',
      // Roster and seams — agents that resolve to nothing, or cannot do the work.
      'test/unit/orchestration/seam-resolution-guesses-from-the-name.test.ts',
      'test/unit/orchestration/a-roster-with-no-implementer-was-called-sound.test.ts',
      'test/unit/orchestration/the-mint-tally-left-a-proposal-unaccounted.test.ts',
      'test/unit/orchestration/readiness-audited-a-file-not-the-run.test.ts',
      'test/unit/orchestration/the-readiness-audit-asked-the-environment-not-the-run.test.ts',
      // Survey — claims about codelines that were never opened.
      'test/unit/orchestration/the-survey-claimed-files-that-are-not-there.test.ts',
      'test/unit/orchestration/the-survey-only-ever-staffs-for-looking.test.ts',
      // Prompt/tool contracts — prompts that instruct calls the tool refuses.
      'test/unit/orchestration/prompts-advertise-tool-calls-the-tool-rejects.test.ts',
      'test/unit/orchestration/prompts-name-tools-that-do-not-exist.test.ts',
      'test/unit/orchestration/bootstrap-duplicates-the-seam-registry.test.ts',
      // Self-heal — an agent whose answer does not parse must retry, not end the run.
      'test/unit/orchestration/agents-parse-once-and-die.test.ts',
      // Tool scoping — a query answered from whichever repo the process was standing in.
      'test/unit/orchestration/codegraph-answers-from-whatever-repo-it-is-standing-in.test.ts',
      // Timeouts — 36 seams declared one and nothing read it.
      'test/unit/orchestration/every-seam-declares-a-timeout-nothing-reads.test.ts',
      // Provisioning — one slow call must not destroy the whole mint step.
      'test/unit/orchestration/one-slow-prompt-destroyed-thirty-minutes-of-work.test.ts',
      // Cost — the measurement the operator calls priority #1.
      'test/unit/orchestration/the-run-recorded-no-cost.test.ts',
      'test/unit/orchestration/cost-rows-cannot-be-joined-to-the-roster.test.ts',
      'test/unit/billing/a-provider-zero-is-not-a-billed-cost.test.ts',
    ],
    testTimeout: 30000,
  },
});
