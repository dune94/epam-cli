# Baseline — CODEMIE stack (the default), captured 2026-08-25

What every project resolves with `EPAM_PROVIDER_SET` UNSET, now that `defaultSet` is `codemie`.
This is the reference the pipeline is measured against from here on.

- `resolved-<project>.json` — what `resolveLlmSettings` returns per project (keys sorted)
- `env-<project>.txt`       — the ladder/effort/provider variables a run actually exports
- `MANIFEST.md5`            — checksums

All four projects resolve IDENTICAL ladders: the stack declares them and every project inherits.
25 seams -> claude-sonnet-5, 14 seams -> claude-haiku-4-5-20251001, and ZERO seams resolve no
model at all.
