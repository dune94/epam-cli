# Tier 3 travel-app run — 2026-07-10T10:44:24 — SUCCESS

First fully clean end-to-end run of the 2026-07-10 debugging session (10 bugs fixed
via TDD earlier the same day). Log preserved at
`tier3-travel-app-run-20260710T104424-SUCCESS.log` in this directory.

## Outcome
- All 9 stories completed: SKY-001-impl/-test, SKY-002-impl/-test, SKY-003-impl/-test,
  SKY-004-impl/-test, SKY-004-dashboard.
- Zero checkpoint violations (no STORY-ID-LOSS, no UNAUTHORIZED STORY CREATION, no
  watchdog double-timeouts).
- Self-healing fired mid-run and recovered every time (SKY-003-impl hit HealingBroken
  on a repeated TS syntax error, escalated a rung, converged; SKY-004-test used 1 free
  retry on a deterministic-check violation).

## Cost grid (per-story, self-reported by claude.sh)

| Story             | Model               | Tokens In | Tokens Out | Cost      | Elapsed  |
|--------------------|---------------------|----------:|-----------:|----------:|---------:|
| SKY-001-impl       | MiniMax-M3          |    30,348 |      1,208 | $0.010554 | 0.28 min |
| SKY-001-test       | MiniMax-M3          |    23,303 |      2,131 | $0.009548 | 0.41 min |
| SKY-002-impl       | MiniMax-M3          |    32,017 |      2,429 | $0.012520 | 1.31 min |
| SKY-003-impl       | MiniMax-M3          |   107,136 |      7,587 | $0.041245 | 2.56 min |
| SKY-004-impl       | MiniMax-M3          |    77,086 |      4,279 | $0.028261 | 0.95 min |
| SKY-004-dashboard  | MiniMax-M3          |   214,019 |     12,428 | $0.079119 | 1.85 min |
| SKY-002-test       | moonshotai/kimi-k2  |    26,848 |     12,247 | $0.043471 | 5.86 min |
| SKY-003-test       | moonshotai/kimi-k2  |    45,095 |      4,594 | $0.036270 | 2.43 min |
| SKY-004-test       | moonshotai/kimi-k2  |   233,100 |     14,648 | $0.166557 | 11.31 min|
| **Sum (logged)**   |                     | **788,952** | **61,551** | **$0.4275** | |

## Reconciliation
- OpenRouter account balance: $168.167887556 (before) -> $168.714045534 (after)
- **Total spent this run (real, OpenRouter delta): $0.5462**
- Gap vs. logged per-story sum ($0.4275): ~$0.12, attributed to token cost of failed/
  retried attempts before convergence (e.g. SKY-003-impl's HealingBroken retries) that
  don't get their own `Cost[...]` line — only the final successful attempt is logged
  per story.
- `gpt-5-codex` never actually ran despite appearing 9 times in the log — those are all
  unused effort-tier defaults, overridden by prd.json's per-story model assignment every
  time. $0 cost, no real dispatch. (Tracked as a log-clarity backlog item — see
  project_backlog.md "Misleading gpt-5-codex log line".)
