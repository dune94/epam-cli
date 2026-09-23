# The self-heal loop, proven on a real failure

WHAT FAILED, AND WHAT THIS REPRODUCES (regintel run 20260921T140717Z, resume 8, 2026-09-22):

    12:34  Effort[final] -> maxIter=6  maxOutTok=8192          REGI-009a assigned effort LOW
    13:00  Coordinator[L1]: truncated at its output cap (8192) — class output_cap
    13:00  Coordinator[L1]: output budget 8192 -> 32768 for the retry     <- the ENGINE decided, once
    {"storyId":"REGI-009a","failureClass":"output_cap","attempt":4,"rawBytes":932,"outputTokens":0}
    {"storyId":"REGI-009a","failureClass":"output_cap","attempt":5,"rawBytes":0,"outputTokens":0}

    healing-events.jsonl : 0 bytes, since 2026-09-21        <- THE ANALYST NEVER RAN

Four attempts, ~$5.50, on a story starved to 6 iterations and 8,192 output tokens, and the agent
whose whole purpose is to diagnose and remedy a failed attempt was never invoked — because
run_failure_analyst returns at its second line unless VERIFICATION_FAILURE is set, and a run that
dies at its output cap never reaches verification.

This test drives the REAL loop to that exact failure and asserts the remedy that must follow it.
No mock, no stub, no replay, no recorded response: a real model, really starved, really truncated.

RUN:  ./run.sh            (costs real tokens — one story)
      ./run.sh --mutate   (restores the guard, re-runs: the test MUST fail, or it proves nothing)

IT TOUCHES NOTHING OF YOURS. Every execution builds a throwaway copy of the engine and a throwaway
git codeline under $TMPDIR. It never reads or writes an install, a run's logs, a PRD, a roster or
a prompt.
