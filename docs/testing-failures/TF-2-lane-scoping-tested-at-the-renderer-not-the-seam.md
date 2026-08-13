## TF-2 — every lane's writer would have received every other lane's plan

**Date** 2026-08-13 · **Found by** reading the rendered prompt during a pre-launch readiness check
· **Cost** none — caught before the run, but it would have corrupted the first metrolinx run

**Agreed** — a lane's writer works from its own codeline's plan. The pipeline had held this since
run-agent-orchestration.sh:3216, which replaces the flat `fixSiteAnalysis` with
`fixSiteAnalysisPerCodeline[thisLane]`, for a reason recorded in its own comment: four killed runs
once turned gotransit's 13 fix sites into 22.

**Shipped** — moving the plan onto the published-inputs framework broke it twice over. Publication
ran in the PARENT, from the canonical PRD, whose `fixSiteAnalysis` is the UNION of every codeline;
and `AGENT_IO_DIR` was exported by the parent, so every lane read the parent's store instead of its
own, defeating the per-lane `LOG_DIR` that exists precisely because shared lane state has already
produced a false pass on unreviewed code.

Measured on the live AMSD-2041 PRD: gotransit's writer would have received 11,665 characters
covering 13 sites instead of 4,001 covering 4 — including three different prescriptions for
`src/services/contentstack.ts` naming five different env vars, two of them mutually exclusive
designs (`management_token` versus `preview_token`). A writer handed three conflicting instructions
for one file picks one, and nothing makes it pick its own lane's.

**The test** — `the-detective-publishes-its-plan-once.test.ts`, ten tests written the same day:
the plan reaches the store, the published text equals the producer's own rendering, every story is
published, one story never receives another story's plan, a re-run clears a withdrawn plan.

**Why it passed** — every test was single-lane. "One story does not see another story" was
asserted; "one CODELINE does not see another codeline" was not, because the fixtures had no
codeline at all. The tests modelled the producer and the store faithfully and never modelled the
topology the pipeline actually runs — three lanes, three PRDs, three stores, one canonical union.

The lane scoping existed in a DIFFERENT file (`run-agent-orchestration.sh`), so it never occurred
to me to reproduce it in a test about the producer. That is the shape: a fact enforced upstream is
invisible to a test written downstream, and moving the work downstream silently drops it.

**Testing rule** — *reproduce the topology, not just the unit.* If production runs N of something
— lanes, processes, stores — a test with one of them cannot see the failure mode that only exists
at two. Ask what the pipeline actually runs, and build the smallest fixture that has more than one
of it. And when a behaviour is enforced in another file, the migration's test must assert the
behaviour, not trust that the other file still does.

**Status** — fixed (`4228f12`). `publishFixPlans` prefers `fixSiteAnalysisPerCodeline[story.codeline]`
so publication is correct from either PRD; every lane invocation sets its own `AGENT_IO_DIR`;
publication moved out of the spec pass so a resume publishes at all. Verified per lane on the real
PRD: 4 / 4 / 5 sites, each with an internally consistent env-var set.
