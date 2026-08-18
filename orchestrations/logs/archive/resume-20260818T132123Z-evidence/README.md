# Resume of run 20260818T101809Z — outcome

Both seeded defects were fixed correctly and both suites pass; the pipeline
reported Implemented: 0, Failed: 2.

  mock-a  rider.age > 65        -> >= 65             tests 6 passed, tsc exit 0
  mock-b  i < stops.length - 1  -> i < stops.length   tests 6 passed, tsc exit 0

## Why it failed — a 429 treated as terminal

  "z-ai/glm-5.2 is temporarily rate-limited upstream"
  provider_name: CoreWeave · provider_error_code: rate_limit_exceeded
  limit_source: upstream_provider_shared_pool

llm-settings.json pins glm-5.2 to providerOrder ["CoreWeave"] and kimi-k3 to
["Moonshot AI"] for cache stickiness (measured 99.6% / 98.2%). Pinned to one
upstream there is nowhere to fall back, so a recoverable 429 became
raw=0 bytes / exit=1, was classified as an environment crash, and burned 10 of 12
attempts per lane at ~10s each.

Reproduced in one variable:
  EPAM_PROVIDER_ORDER unset      -> exit 0, 410 bytes
  EPAM_PROVIDER_ORDER=CoreWeave  -> exit 1, 0 bytes

Both upstreams ARE still serving these models (OpenRouter endpoints API) — this is
congestion, not a missing route.

## Second, independent defect

tsc-verify reports TypeScript errors while `npx tsc --noEmit` exits 0 in both
repos. HealingBroken flagged it as unwinnable; the failure analyst correctly
reported "verification.json lacks a typecheck section; code and tests are correct".

## Confirmed working this run

resume (launch -> writer in 3s, roster of 57 reused), provider follows the
escalated model (qwen + glm-5.2, was minimax + glm-5.2), cost records no longer
repeat a previous attempt's usage, failure analyst produces a grounded diagnosis.
Real spend: $0.0771 across 24 cost records.
