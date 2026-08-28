# Baseline — openrouter/minimax stack, captured 2026-08-25

The byte-identical reference for C-T1. Captured BEFORE any CodeMie change.
A swap back to the openrouter set MUST reproduce these files exactly.

- `resolved-<project>.json` — what `resolveLlmSettings` returns per project (keys sorted)
- `env-<project>.txt`       — the ladder/effort/provider variables a run actually exports
- `MANIFEST.md5`            — the checksums the round-trip test compares against

Plain files on purpose: no git tag, no commit, no rebuild. Restoring is a file compare.

## Facts this capture established

- skyscanner has NO llm-settings.json: it resolves to `{}` and gets its ladders from
  config.env pins alone. It is NOT like metrolinx/mock3.
- hello-dolly is a FOURTH project (llm-settings.json, no config.env). Any plan text saying
  "three projects" is wrong.
- `orchestrations/config/llm-defaults.json` declares NO ladders/modelOverrides/ladderTierOrder
  today, so inheritance is wired but nothing has been moved into the base yet.

## Amendment 2026-08-25 — skyscanner refreshed after B6 / change 30

`resolved-skyscanner.json` and `env-skyscanner.txt` were RE-CAPTURED after B6 migrated its
ladders out of config.env and change 30 added its start models and `highest` tier. The
original capture recorded `{}` — the state where skyscanner had no settings file at all.

metrolinx, mock3 and hello-dolly are UNCHANGED from the original capture, and that is the
proof that the provider-set resolver change is behaviour-neutral: three of four projects
resolve byte-identical, and the fourth differs only by the reviewed change 30.
