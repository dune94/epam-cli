# Testing Failures

Defects that reached a live run **because the tests that covered them were wrong**, not absent.

A defect belongs here when a test existed, passed, and the feature still did not work. Those are
the expensive ones: absent tests are visible in a coverage sweep, but a green test that proves the
wrong thing actively conceals the gap and makes everyone downstream confident.

Each entry answers one question above all others: **why did the test pass?** The fix to the code is
secondary — the fix to the *testing* is the point.

## Format

```
## TF-<n> — <one line: what did not work>
**Date** · **Found by** · **Cost**
**Agreed**      what the requirement actually was, in the words it was given
**Shipped**     what the code did instead
**The test**    the test that existed, and what it asserted
**Why it passed**  the reason a green test did not catch it  ← the point of this log
**Testing rule** the general rule that prevents the whole class
**Status**      open / fixed (commit)
```

---

## TF-1 — the writer was not told what its last attempt did, on the path where it mattered most

**Date** 2026-08-13 · **Found by** the operator, mid-run, by asking · **Cost** one review cycle
re-implemented without the input; ~2h of live run before the question was asked

**Agreed** — the operator's instruction, verbatim:

> "make sure the 'what you did on the last try' input is provided to the writer"

**Shipped** — `_attempt_change_summary()` in `claude.sh`, rendered under `## What Your Last Attempt
Did`, gated on:

```bash
if [ "$_total_attempts" -gt 1 ]; then
```

`_total_attempts` is `local`, initialised to `0` inside `implement_story` and incremented once per
in-process retry. Nothing restores it across invocations.

So the summary reaches the writer **only when the retry happens inside one `claude.sh` process**:

| path | new process | summary |
|---|---|---|
| ladder retry within one invocation | no | yes |
| **review-cycle re-implementation** (`run-agent-orchestration.sh:8269`) | yes | **no** |
| sibling-story escalation fix (`:8071`) | yes | **no** |

The review cycle is precisely the case the requirement was about: the writer is being asked to fix
its own work, and is not told what its own work was. The same gate also suppresses
`## Coordinator Guidance`, so the failure-analyst's diagnosis is missing on those paths too.

**The test** — `test/unit/orchestration/the-next-attempt-knows-what-the-last-one-did.test.ts`.
It builds a git fixture, runs the real `_attempt_change_summary`, and asserts the output names a
modified file and a new file and does not name an untouched one. All true. All still true today.

**Why it passed** — it tested the SUMMARY, never the DELIVERY. Every assertion was about the string
`_attempt_change_summary` returns; not one asked the question the requirement asked, which is
*"does the writer receive it on a retry?"* The gate that decides delivery was never executed, and
the review-cycle path — a second process — was never constructed at all.

Worse, the one place delivery was considered, it was framed around the implementation's own
condition (`_total_attempts > 1`) rather than the requirement (*each retry*). A test written from
the gate can only ever confirm the gate agrees with itself.

**Testing rule** — *test the requirement's actor, in the situation the requirement names.*

- The requirement names the WRITER and a RETRY. So the test must render a writer prompt, on a
  retry, and assert the section is in it — not call the helper and inspect its return value.
- When a feature crosses a process boundary, the test must cross it too. Process-local state is
  invisible to a single-process test, and re-invocation is how this pipeline retries.
- A gate expressed in implementation terms (`_total_attempts > 1`) is not the requirement
  (*each retry*). Assert the requirement; let the gate fail the test if it disagrees.

The capture harness added the same day (`test/helpers/writer-prompt.ts`) can render a prompt for
exactly this assertion — it existed, and was not used here.

**Status** — open. The fix is to stop gating a cross-process fact on process-local state: the
engine publishes the diffstat as `attempt-evidence`, already declared in the writer's and the
reviewer's `consumes` lists, so it travels like every other input and no counter is involved.
