# TF-6 — a ladder on an agent nobody calls

**Date** 2026-08-14

**Agreed**

"All agents have to have ladder access / self heal / retries." Stated repeatedly, and stated again
on 2026-08-13 as a defect I had ignored: the impl-failure-analyst runs at a fixed gate model and
cannot escalate. `lib/agent-ladder.sh` was built to close that, and its own header records the
incident that motivated it — self-heal declaring HealingBroken while "the only actor that could
diagnose WHY runs at a fixed model that never escalates."

**Shipped**

`agent_ladder_record_failure "failure-analyst"` sits at `claude.sh:7297`, inside the analyst's
retry path. But `claude.sh:10221` routes a `DETERMINISTIC_CHECK_FAILURE` straight past
`run_failure_analyst` — correctly on the first occurrence, because the check's own message already
names the violation precisely and paying a gate-model call to restate it is waste.

The skip never re-evaluates. By the time the loop sets `HEALING_BROKEN` it has established
something the skip's premise does not cover: the remedy has been injected repeatedly and has NOT
worked. The violation is still known; *why the known remedy keeps failing* is not. That is the
analyst's only job, and it is skipped by a condition that was true once and was never revisited.

Measured live on AMSD-2041 (metrolinx) and reproduced offline: the story climbs rung 0 → 1 → 2,
declares HealingBroken three times, aborts at max rung, and the analyst is invoked **zero** times.
The ladder built for it is unreachable code on this entire failure class.

**The test**

Sixty-eight tests cover this area. Three are named for exactly this property —
`every-agent-can-climb-a-ladder`, `every-seam-can-reach-its-ladder`,
`every-seam-script-asks-for-its-ladder` — and two of them genuinely execute, with four `spawnSync`
calls each. All three name `failure-analyst`. All three passed.

**Why it passed**

"Agent has ladder access" is three layers, and each test checked the layer below the one its name
claims:

1. **DECLARED** — the archetype carries a `ladder` field.
2. **RESOLVED** — that declaration maps to a model in the *calling process*. This is what
   `every-seam-can-reach-its-ladder` actually tests, and it tests it well: it runs the parent
   loader the way the orchestrator does and asserts `EPAM_MODEL_LADDER_<TIER>` is exported where
   the seam can see it. It exists because on 2026-08-11 I checked layer 1 and claimed layer 2.
3. **REACHED** — the code path actually *invokes* the agent, so the seam runs at all.

Nothing tested layer 3. The ladder unit tests call `agent_ladder_model` directly — given N recorded
failures, return rung N — which is true, and stays true forever when nothing ever records a failure
because nothing ever invokes the agent. A helper cannot observe that its own call site is
unreachable.

So the same error repeated one layer up: in August I checked declaration and claimed resolution;
this week I checked declaration and resolution and claimed reachability. The test names were
accurate about the intent and silent about the gap.

A second failure compounded it. `deterministic-check-free-retry.test.ts`, the test nominally
covering this exact code region, asserts with `claudeSrc.slice(idx, idx+400)` and `toMatch(...)` —
`readFileSync` + regex over source text. It passes on a comment, on a dead branch, on a call site
that no longer runs. It could never have caught a reachability defect because it never executes
anything.

**Testing rule**

**Test the agent's REACHABILITY in the situation its capability exists for — not the capability in
isolation.** A declared ladder, a resolvable model and a correct rung calculation are three true
facts that together prove nothing if no path calls the agent. For every actor with an escalation
seam, drive the real failure path and *count invocations at the seam*; a count of zero is the
finding, and no unit test of the helper can produce it.

Corollary, from the same day: when a check is skipped because its premise holds, assert what
happens when the premise **stops** holding. A guard whose condition is correct on attempt 1 and
never re-evaluated is indistinguishable, in every green test, from one that is correct always.

**Status** test written and red (`the-analyst-is-reached-when-healing-is-broken.test.ts`); fix to
`claude.sh:10221` awaiting approval.
