# Gates, tested offline — £0, no model, no paid run

Every gate in this pipeline that calls no model is testable without spending anything: the
baseline gate, the verification runner, the lint gate, the deliverables check. They are shell,
node, and the codeline's own test command.

On 2026-09-23 the question "why does the baseline build yield 5 failure ids by hand and 0 inside a
run?" was chased across three paid runs. Every probe was driven with a HAND-BUILT environment
instead of the one the pipeline sets — which is the whole difference, and why the probes disagreed
with reality. This harness removes that excuse:

  * it copies the install and the codeline (never touches the originals),
  * it carries the ledgers a resume keeps — phase-baseline-sha.txt above all,
  * it loads the project's own env exactly as tier3-run.sh does: config.env plus the active set's
    overlay, so EPAM_PROJECT_CONFIG_DIR, the provider set and every project declaration are what a
    run would have,
  * then it runs the gate and asserts on what the gate produced.

    ./run.sh [install-dir] [project] [set]      # defaults: regintel-pipeline regintel openrouter

## What it asserts today

The baseline must be BUILT, and no id in it may reappear in the delta. A non-empty delta is fine —
a genuinely new failure is the story's. An inherited failure charged to whoever ran last is not,
and that is what blocked REGI-002 twice while it was writing the correct fix.

Current output against the live codeline:

    suite exit=1, 4 FAILED line(s)
    baseline sha: 19439a79e863
    cache: 316 bytes, 5 id(s)
    PASS  every baseline failure is subtracted; the delta holds only genuinely new failures
          new failures: 1     (tests/test_escalation.py::test_no_event_missing_a_classification…)

## Add a gate here before you debug it in a run

If a gate makes no model call, it belongs in this file. A run is for the things that genuinely
need a model; everything else is a test you can run a hundred times for nothing.
