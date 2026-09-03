# Baseline — OPENROUTER stack (the swap-back target), captured 2026-08-25

What every project resolves with `EPAM_PROVIDER_SET=openrouter`. This is the proof the hot swap
is real: if CodeMie tokens run out mid-programme, one env var restores THIS, and these checksums
are how that is verified rather than assumed.

## How this differs from `baseline-openrouter-2026-08-25/`

That earlier capture is the PRE-MIGRATION record — what each project resolved on 2026-08-25
BEFORE any of this work, when each declared its own ladders. It is kept unchanged as the
historical reference.

This one is the POST-migration swap target. The difference is deliberate and was confirmed by
the operator: the openrouter stack now declares ONE ladder — metrolinx's, since that is the live
client codeline — and all four projects inherit it. mock3, hello-dolly and skyscanner previously
topped out at glm-5.2/glm-5.1 and now top out at glm-5.3. metrolinx is unchanged.
