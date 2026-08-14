## TF-5 — every lane kept a previous run's review findings, for a week

**Date** 2026-08-13 · **Found by** auditing the metrolinx writer prompt before a launch ·
**Cost** unknown but non-zero: the gotransit run of the same day began with seven stale blockers
in its writer's prompt

**Agreed** — the operator's standing rule, given twice: "I never granted permission to persist ANY
such file across runs", and "there can be no lingering anything to skew runs. That is strictly
forbidden."

**Shipped** — `pre-run-reset.sh` cleared run-scoped review artefacts with `-maxdepth 1`, so it
swept only the parent `LOG_DIR`. A lane runs with `LOG_DIR=$LOG_DIR/lanes/<codeline>` and the
writer reads `$LOG_DIR/review-feedback-<story>.json`. Every lane's findings therefore survived
every reset, indefinitely.

Found on disk that day: all three lanes still held files written on **2026-08-05** — gotransit 7
issues, metrolinx 9 (four of them blockers), upexpress 5 — describing an implementation discarded
a week earlier (`setLivePreviewContent`, `useLivePreviewContent`: symbols that no longer exist).

A metrolinx run would have opened its writer's prompt with *"A prior code review requested changes.
This is the highest priority"* followed by four blockers about code that was never there. The
operator has described this exact failure before: *"a review written on 2026-08-09 was still being
handed to the writer on 2026-08-12 ... The writer obeyed all of it, and was blamed for
over-reaching."*

**The test** — none for this file. The reset has tests for what it clears at the top level, and its
own comments record being caught twice before enumerating names while a sibling artefact survived.

**Why it passed** — the tests, and the fix that preceded them, treated the defect as *"which
FILENAMES do we clear"* and never as *"WHERE can a consumer read one from"*. The reset had already
been corrected twice on the first axis — `*.count` while `.model` survived, the PRD while review
feedback survived — and both corrections left the second axis untouched. So a rule stated as
"clear review artefacts" was implemented as "clear review artefacts **here**", and no test asked
where "here" was, because every fixture was a flat directory.

The same day, and hours earlier, the published agent-input store failed identically: cleared in the
parent, surviving in `lanes/*/agent-io/`. Two independent instances of one defect in one file, both
found by hand.

**Testing rule** — *when a consumer's directory is configurable, the fixture must include the
configured case.* A reset test whose LOG_DIR is flat can only prove behaviour for a flat LOG_DIR,
and this pipeline's lanes make it never flat. More generally: for any "we clear X" claim, the test
must construct X in EVERY location a reader resolves it from — depth is a dimension of the rule,
not an implementation detail beneath it.

**Status** — fixed. The sweep no longer bounds depth, so it clears the parent and every lane, and
still aborts with status 9 rather than announcing a clean slate it did not deliver. Mutation-
verified: restoring `-maxdepth 1` fails four of the six tests. The three stale files were removed
by hand before the fix landed, and backed up first.
