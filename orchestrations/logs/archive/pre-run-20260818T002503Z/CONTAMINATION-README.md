# mock-a contamination, run 20260817T231306Z

src/fares.ts and test/fares.test.ts were modified at 2026-08-17 20:03:50 EDT,
inside the Step 1 specification pass (20:01:38 -> 20:16:33). The writer stage
was never reached: both lanes died at Step 7 with exit 127.

Effects:
  - the seeded bug (rider.age > 65) was already fixed before the writer ran
  - two boundary tests were added to test/fares.test.ts
  - Step 5 "Regression guard PASSED - baseline tests green" tested fixed code,
    so it is not a pre-change baseline
  - the spec agent read contaminated source at 20:13 and reported
    "fareFor uses strict > (now >= in code shown but the bug was >)"

mock-b was NOT touched; its seeded bug (i < stops.length - 1) is intact.

The captured diff is CONTAMINATION-mock-a-spec-window.diff. mock-a was reverted
to its seeded baseline (commit 7a06c18) after this capture.
