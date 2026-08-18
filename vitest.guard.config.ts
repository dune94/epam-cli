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
      // Shell hygiene — a stripped `local` ran as a command and returned 127 at Step 7.
      'test/unit/orchestration/a-stripped-declaration-runs-as-a-command.test.ts',
      // Launchers — the generic launcher loaded the project config and reset nothing.
      'test/unit/orchestration/a-launcher-that-never-reset-anything.test.ts',
      'test/unit/orchestration/the-resume-guard-read-its-own-source.test.ts',
      // Resume — a run that never paused saved only checkpoints its own resume could not see.
      'test/unit/orchestration/a-run-that-never-paused-was-never-resumable.test.ts',
      // Reset completeness — stale PRD assignments, prompts and artefacts crossing runs.
      'test/unit/orchestration/prd-kept-the-previous-runs-assignments.test.ts',
      'test/unit/orchestration/reset-leaves-last-runs-generated-artefacts.test.ts',
      // Roster and seams — agents that resolve to nothing, or cannot do the work.
      'test/unit/orchestration/seam-resolution-guesses-from-the-name.test.ts',
      'test/unit/orchestration/the-mint-tally-left-a-proposal-unaccounted.test.ts',
      // Reviewers — a member-by-member review cannot see an absence; the survey had no reviewer.
      'test/unit/orchestration/reviewers-judge-members-never-the-set.test.ts',
      'test/unit/orchestration/an-empty-roster-was-called-sound.test.ts',
      // Survey — claims about codelines that were never opened.
      'test/unit/orchestration/the-survey-only-ever-staffs-for-looking.test.ts',
      // Prompt provenance — a generated copy must serve the seam its template declares.
      'test/unit/orchestration/the-prompt-seam-link-is-stored-twice.test.ts',
      'test/unit/orchestration/an-unroutable-name-killed-the-mint.test.ts',
      // Mint vocabulary — the prompt offered a name shape the registry routes nowhere.
      'test/unit/orchestration/the-mint-was-offered-a-suffix-nothing-routes.test.ts',
      'test/unit/orchestration/the-mint-prompt-lives-in-the-template-zone.test.ts',
      // Reviewers — a full seam invoked behind a parameter nobody passed.
      'test/unit/orchestration/a-reviewer-nobody-invoked.test.ts',
      // Prompt/tool contracts — prompts that instruct calls the tool refuses.
      'test/unit/orchestration/prompts-advertise-tool-calls-the-tool-rejects.test.ts',
      'test/unit/orchestration/prompts-name-tools-that-do-not-exist.test.ts',
      'test/unit/orchestration/bootstrap-duplicates-the-seam-registry.test.ts',
      // Self-heal — an agent whose answer does not parse must retry, not end the run.
      'test/unit/orchestration/agents-parse-once-and-die.test.ts',
      // Agent invocation — an agent handed a null exec never ran, and the log said "fallback".
      'test/unit/orchestration/the-search-vocabulary-agent-never-ran.test.ts',
      // Story branch — a repo with no remote never got one, so the write window never opened.
      'test/unit/orchestration/a-repo-with-no-remote-never-got-a-story-branch.test.ts',
      // Write perimeter — sealing was in one launcher of eight; a spec agent rewrote the source.
      'test/unit/orchestration/only-one-launcher-locked-the-repos.test.ts',
      // Tool scoping — a query answered from whichever repo the process was standing in.
      'test/unit/orchestration/codegraph-answers-from-whatever-repo-it-is-standing-in.test.ts',
      // Timeouts — 36 seams declared one and nothing read it.
      'test/unit/orchestration/every-seam-declares-a-timeout-nothing-reads.test.ts',
      // Provisioning — one slow call must not destroy the whole mint step.
      'test/unit/orchestration/one-slow-prompt-destroyed-thirty-minutes-of-work.test.ts',
      // Writer loop — a provider that did not follow its model, and a failure path that
      // destroyed its own evidence: correct work discarded as an environment crash.
      'test/unit/orchestration/the-ladder-escalated-the-model-and-left-the-provider.test.ts',
      'test/unit/orchestration/a-missing-raw-file-was-called-an-environment-crash.test.ts',
      'test/unit/orchestration/a-failed-attempt-billed-the-previous-ones-tokens.test.ts',
      'test/unit/orchestration/the-failure-analyst-could-not-build-its-own-prompt.test.ts',
      'test/unit/orchestration/an-unparseable-review-was-reported-as-clean.test.ts',
      // Ledger — duration was always 0, and an unexplained $0 destroyed its own evidence.
      'test/unit/orchestration/the-ledger-cannot-say-how-long-anything-took.test.ts',
      // Upstream congestion — a pinned provider that 429s must not end the run.
      'test/unit/providers/a-rate-limited-pin-had-nowhere-to-fall-back.test.ts',
      // Commit — a symlinked dependency dir made every commit fatal at the last step.
      'test/unit/orchestration/a-symlinked-node-modules-blocked-every-commit.test.ts',
      // Gates — an undeclared check reported as type errors the writer could not find.
      'test/unit/orchestration/an-undeclared-check-was-reported-as-type-errors.test.ts',
      // Cost — the measurement the operator calls priority #1.
      'test/unit/orchestration/the-run-recorded-no-cost.test.ts',
      'test/unit/orchestration/cost-rows-cannot-be-joined-to-the-roster.test.ts',
      'test/unit/billing/a-provider-zero-is-not-a-billed-cost.test.ts',
    ],
    testTimeout: 30000,
  },
});
