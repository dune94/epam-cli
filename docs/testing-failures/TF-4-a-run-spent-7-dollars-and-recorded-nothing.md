## TF-4 — a run spent $7.47 and every report said $0.00

**Date** 2026-08-13 · **Found by** the operator asking what a completed run cost · **Cost** the
run's own accounting, and a cost gate that escalated on a number derived from no data

**Agreed** — cost tracking is the operator's stated priority #1: "billed cost per call/run
reportable". Every run records what it spent.

**Shipped** — the gotransit run of 2026-08-13 cost **$7.47** by OpenRouter's own counter
($495.607 → $503.080) and wrote **zero** records to `phase-cost.jsonl`. The dashboard, the run
report and the cost-variance gate all read that ledger. The gate then reported a 597% variance
against a stale CPA estimate and escalated — a confident number computed from an empty file.

The measurements were never missing: every attempt's `*_result.json` carries `total_cost_usd` and
a usage block (the last one: `total_cost_usd: 0.3247`), and `usage-progress-<story>.json` carried
the running total the whole time. `append_cost_record` itself works — executed against that run's
own result file it produces a correct record. This is a reporting failure, not a measurement one.

Three different notions of where the ledger lives contributed: `PHASE_COST_FILE` is exported once
by the parent, so a lane setting its own `LOG_DIR` still resolves the parent's path; `claude.sh`
reassigns `LOG_DIR` from its own location, giving a third; and the lane→parent fold-back exists
only in the parallel path. The lane invocation also passes `--reset`, so the pre-run reset — which
archives and truncates `phase-cost.jsonl` — ran again at 18:32:25, one minute INTO the run.

**The test** — none. `phase-cost.jsonl` has consumers and record-shape tests, and nothing asserted
that a run which called a model produces any record at all.

**Why it passed** — there was nothing to pass. But the reason it stayed invisible for months is the
part worth recording: **every consumer treated an empty ledger as $0.00 rather than as absent.**
A missing measurement and a measurement of zero are different facts, and every reader collapsed
them into the cheaper one. The cost gate then did arithmetic on it and produced 597%, which reads
as a finding rather than as a symptom. Absent must never default to zero — the same rule this
pipeline already learned at other seams and did not apply to money.

**Testing rule** — *assert the OUTPUT of a run, not only the shape of its records.* A test that
validates record structure cannot notice that no records exist. For anything a run is required to
produce — cost, coverage, artefacts — there must be one assertion of the form "this run did X,
therefore Y exists", executed at the end of the run against what is actually on disk.

And: *never let absent mean zero.* Where a consumer reads a measurement, it must distinguish "no
data" from "the value is 0", because only one of those is safe to act on.

**Status** — guard fixed, cause not yet fully proven. `lib/cost-ledger.sh` adds
`assert_cost_ledger_not_silently_empty`, wired at the end of the pipeline: if model-call artefacts
exist and the ledger holds no records, the run says so, naming the evidence. Verified against the
2026-08-13 run's own logs — it reports 965 result artefacts against 0 ledger records. It does NOT
reconstruct cost from the result files: a second way of computing money is a second source of truth
about money, and the first one being broken is when a plausible substitute does the most damage.

Still open: the single resolved ledger path shared by parent, lane and claude.sh; the fold-back on
the sequential path; and why the reset runs mid-run via the lane's `--reset`.
