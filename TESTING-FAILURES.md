# Testing Failures

Defects that reached a live run **because the test covering them was wrong**, not absent.

An absent test shows up in a coverage sweep. A green test that proves the wrong thing conceals the
gap and makes everyone downstream confident — those are the expensive ones, and they are what this
log is for.

Every entry answers one question above all others: **why did the test pass?** The fix to the code
is secondary; the fix to the TESTING is the point, because that is what generalises.

**One file per entry, under `docs/testing-failures/`.** This index carries one line each. Entries
are never edited into this file: a log that grows to hundreds of entries in a single document gets
truncated by whoever reads it next, and a severed entry reads as a complete one.

| ID | Date | Defect | Testing rule it produced | Status |
|---|---|---|---|---|
| [TF-1](docs/testing-failures/TF-1-attempt-summary-not-delivered-across-processes.md) | 2026-08-13 | the writer was not told what its last attempt did, on the review-cycle path where it mattered most | test the requirement's ACTOR in the situation the requirement names; cross the process boundary the feature crosses | fixed (6e56c9e) |
| [TF-2](docs/testing-failures/TF-2-lane-scoping-tested-at-the-renderer-not-the-seam.md) | 2026-08-13 | every lane's writer would have received every other lane's plan, with conflicting prescriptions for the same file | reproduce the TOPOLOGY, not just the unit — one of something cannot show a failure that only exists at two | fixed (4228f12) |
| [TF-3](docs/testing-failures/TF-3-a-named-mode-shipped-half-applied.md) | 2026-08-13 | "writer-only" ran the regression guard anyway — a named intent, silently half-applied | test the SEQUENCE, not only the function; when a rule distinguishes two sources, construct both and show they diverge | fixed |
| [TF-4](docs/testing-failures/TF-4-a-run-spent-7-dollars-and-recorded-nothing.md) | 2026-08-13 | a run spent $7.47 and every report said $0.00 | assert the OUTPUT of a run, not only the shape of its records; never let absent mean zero | guard fixed, cause open |
| [TF-5](docs/testing-failures/TF-5-the-reset-swept-one-directory-deep.md) | 2026-08-13 | every lane kept a previous run's review findings for a week — a writer would act on blockers about code that no longer existed | when a consumer's directory is configurable, the fixture must include the configured case; depth is part of the rule | fixed |

## Adding an entry

Copy the shape of an existing file. It must carry: **Agreed** (the requirement, in the words it was
given), **Shipped** (what the code did instead), **The test** (what existed and what it asserted),
**Why it passed** (the reason a green test missed it), **Testing rule** (the general rule that
prevents the class), **Status**.

An entry with no "why it passed" is a bug report, not a testing failure, and belongs elsewhere.
