# TF-7 — a budget guarded a number the artefact never had

**Date** 2026-08-14

**Agreed**

The writer prompt has a token budget, and growth must be deliberate: "Every added token is re-sent on
EVERY agent iteration and billed in full (this pipeline gets no prompt caching). If the growth is
intended, raise the baseline in writer-prompt-budget.json deliberately."

**Shipped**

`writer-prompt-characterization.test.ts` extracts `build_implementation_prompt` and four helpers it
depends on, runs them, and measures the rendered bytes against a recorded baseline of 2191.

`story_declared_files` — called twice by the prompt builder, once to list the deliverables and once
when walking them — was NOT in the extraction list. Execution died at the first call with
`story_declared_files: command not found`, before the deliverables block rendered.

The harness caught the non-zero exit and reported it as a prompt-builder failure, so the measurement
that produced 2191 was taken from a prompt that stopped short. The real prompt is **2437 bytes**
(2642 across three codelines). The budget had been guarding a number the artefact never had.

Proven by baseline compare: HEAD's `claude.sh` with the dependency added renders the identical
2437/2642, so the growth is not a regression — it is the first honest measurement.

**The test**

Ten tests, all passing for months. Three assert prompt CONTENT, two assert the budget, five assert
lane scoping. The content assertions passed because everything they looked for renders before the
deliverables block. The budget assertions passed because they compared a truncated render against a
baseline recorded from the same truncated render.

**Why it passed**

The harness and the baseline were derived from the same broken run, so they agreed with each other
and with nothing else. A budget test is a comparison between a measurement and a recorded
measurement; when both come from the same faulty instrument the comparison is self-consistent and
meaningless. Nothing in the file could detect that, because every number in it was internally
correct.

The failure only surfaced when an unrelated edit shifted which lines the extractor reached. That is
the tell: the test's verdict depended on how far execution happened to get, not on what the prompt
contained. It had been reporting on an artefact that was never produced.

The deeper cause is the extracted-function harness itself. It restates a function's dependencies as
a hand-maintained list, and that list silently drifts from the real dependency set every time the
function gains a call. Five instances surfaced on this one day — `story_declared_files` here,
`verify_client_env_boundary` across fourteen harnesses, `_ANALYST_SEAM` in a snippet runner, and two
seam-name matchers that stopped resolving when the name moved into a variable.

**Testing rule**

**A recorded baseline must be traceable to a run that PRODUCED the artefact, not merely to a run
that exited.** Before trusting any measurement, assert the artefact is complete on its own terms —
that the render reached its last section, that the process exited zero, that the byte count is not
simply where execution stopped. A harness that dies mid-render and a harness that renders a small
artefact are the same number.

Corollary: when a budget test fails after an unrelated change, establish whether the ARTEFACT grew or
the MEASUREMENT did, by running the old code through the new harness. Raising the baseline to
restore green, without that check, converts a broken instrument into a permanent fiction.

**Status** dependency added to the harness; the 2191/2407 baselines are still recorded from the
truncated render and need re-baselining to 2437/2642 — deliberately, with the reason written into
`writer-prompt-budget.json`, which is the operator's decision and not mine to take.
