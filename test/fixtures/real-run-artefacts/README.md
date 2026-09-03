# Real run artefacts

Captured OUTPUT from real pipeline runs, kept here because the pipeline deletes its own working
copies: `orchestrations/logs/kb-scratchpad/` is cleared by pre-run-reset, so a test that reads from
there passes until the next run and then fails with "artefact missing" — which is exactly what
happened on 2026-09-02.

These are not fixtures anyone wrote. Every byte was produced by a run, which is the whole point:
tests driven by invented inputs pass while production fails on a shape nobody imagined.

## AMSD-1919-suite-failure.txt

`npm run test` output from run 20260902T022134Z on next.gotransit.com. 2.6MB, 746 suites, and
exactly ONE failing suite — the shape that broke the failure analyst, whose prompt reached
~1,141,382 tokens against a 1,000,000 limit. A handler tested with forty synthetic entries never
reached the single-entry branch this file exercises.
