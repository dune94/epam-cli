# First fully green mock3 run — 2026-08-18

    [11:07:00] Phase 'core' — 'mockb' done.
    [11:21:00] Phase 'core' — 'mocka' done.
    [11:21:04]   ✓ mocka   ✓ mockb
    [11:21:04] ✅ Pipeline complete.        spend $0.1393

Both seeded defects fixed, regression tests written by the writers, type checks
passed, work COMMITTED on per-story branches, QA phases and spec validation
passed, story state merged back into the canonical PRD.

    mock-a  18f2d68  MOCK3-1  rider.age > 65 -> >= 65
    mock-b  d7a5a4e  MOCK3-2  i < stops.length - 1 -> i < stops.length

This was a RESUME of run 20260818T101809Z: launch to writer in ~3 seconds,
reusing the mint, the 57-agent roster, 35 prompts and the spec pass's 13
verification criteria. A cold run of the same work took ~80 minutes.

## The nine defects that had to be fixed to get here

 1. b7b30c7  a stripped `local` ran as a command — exit 127 at Step 7
 2. 70df6fc  an agent handed a null exec never ran; $0 cost shadowed real cost
 3. 2fd526a  write perimeter was in 1 of 8 launchers; story branch needed a remote
 4. 28107c8  the mint was offered a name shape the registry routes nowhere
 5. 2ea644b  an unroutable name ended the run instead of being re-proposed
 6. c8bb392  the generic launcher loaded the project and reset nothing
 7. e8386dc  prompt-review: a full seam nobody invoked
 8. b2e6cae/1a06a55/cbd2e24  resume: 4 separate blockers
 9. 0e4646c  a rate-limited pin had nowhere to fall back; an undeclared check
             was reported as type errors
10. 74d6bc6  a symlinked node_modules made every commit fatal (exit 128)

## Still open

- the skill-note 200-char limit forces a rewrite cycle per attempt (costs
  attempts, blocks nothing)
- the 429 pin-release is committed and unit-tested but has never fired live
