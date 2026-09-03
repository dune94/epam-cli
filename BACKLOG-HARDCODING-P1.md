# HARDCODING BACKLOG — ALL PRIORITY 1

**371 unique sites** across 208 pipeline files.

Scope: `orchestrations/scripts/**`, `orchestrations/plugins/**`. Excludes `test/`, `src/`,
config JSON, and `hardcoding-audit.sh`. Executable lines only — comment lines excluded.
Five sweeps, deduplicated by `file:line` (15 sites matched more than one sweep).

## Method — five lenses

| # | Lens | What it finds | Sites |
|---|------|---------------|-------|
| 1 | Literal | vendor, model and provider names | 79 |
| 2 | Structural | decisions frozen as literal sets, arrays, dispatch case arms | 68 |
| 3 | Semantic | branch names, src/test directory conventions, file extensions | 79 |
| 4 | Numeric | thresholds, truncations, ports, timeouts | 75 |
| 5 | Contract | tool names, seam names, story-kind vocabulary | 85 |
| | | raw sum | 386 |
| | | **unique after dedupe** | **371** |

## Verification applied

Sweep 3 was narrowed twice before being counted: 271 raw → 117 → 79. The discarded matches were
the two false-positive classes the repo's own `hardcoding-audit.sh` documents — the LANE called
`"main"` (`agentGroup // "main"`, monitor lane arguments, `lane = 'main'`) which is not a git
branch, and `lib/handlers/*.py|sh` script paths matching the file-extension pattern. Branch
literals are counted only where a git/branch/origin/checkout keyword is on the same line.

The other four sweeps were sampled but not narrowed; treat 371 as the verified floor, not a
precise total.

## Concentration

| File | Sites |
|------|-------|
| spec-mode-runner.js | 83 |
| run-agent-orchestration.sh | 36 |
| claude.sh | 36 |
| codemie-claude.sh | 17 |
| tier3-travel-app-run.sh | 15 |
| tier3-skyscanner-app-run.sh | 15 |
| mint-agents-step.js | 9 |
| codeline-context-plugin.js | 9 |

## Single source each category should read

| Lens | Owner |
|------|-------|
| 1 | `config/providers.json`, project `llm-settings.json` |
| 2 | the declaring registry for that decision |
| 3 | codeline `.epam/verification.json`, `config/codeline-scan.json` |
| 4 | `config/services.json`, project `llm-settings.json` |
| 5 | `agents/invocation-profiles.json`, `config/agent-contract.json` |

## Gaps in the existing audit

`hardcoding-audit.sh` reports 275 including `test/` and `src/`. It has no category for provider
names, for hardcoded test/typecheck commands, or for structural/contract vocabulary, and its model
regex does not match `gpt-5-codex`.

## Guard required with every fix

A lint test deriving the forbidden set FROM the declaring config, so a new instance turns a test
red. Counting is not a guard.

## Site inventory

`/tmp/claude-1000/-home-bradleyjerome-projects-ai-epam-cli/b3256e63-249f-4899-beee-fb994dd2f187/scratchpad/sweeps/unique.txt` — 371 `file:line` entries.
