# Plan v3 — CodeMie provisioning, with the inheritance architecture in place

**Nothing applied.** This replaces plan v2, which assumed per-project edits. That assumption is
now wrong in your favour.

## What changed since v2

`lib/llm-settings-resolve.js` now merges an engine base with each project's differences, and both
readers consult it. So **the ladders are declared ONCE in `orchestrations/config/llm-defaults.json`
and every project inherits them.** No per-project ladder edits, no duplication to keep in step.

Your decisions, carried in:
- **different entry, same ceiling** — position decides where a seam ENTERS the chain, not how far it can go
- **all Claude, no Kimi** — `moonshotai.kimi-k2.5` dropped; medium starts at Haiku
- **`--base-url` exists on every codemie wrapper**, so the free MockServer rehearsal survives

## The ladders — declared once, in the engine base

| tier | enters at | chain |
|---|---|---|
| medium | `claude-haiku-4-5-20251001` | → `claude-sonnet-4-6` → `claude-sonnet-5` |
| high | `claude-haiku-4-5-20251001` | → `claude-sonnet-4-6` → `claude-sonnet-5` → `claude-opus-5` |
| highest | `claude-sonnet-5` | → `claude-opus-4-8` → `claude-opus-5` |

Medium and high share an entry and differ in ceiling: a `mid` seam tops out at Sonnet-5, a `high`
seam can reach Opus-5. Highest skips the cheap rungs its 25 seams would waste a turn on and reaches
Opus-5 in two hops. Every tier ends at Opus-5 or below it, so nothing is unreachable.

## Steps

1. Add `ladders`, `ladderTierOrder` and `modelOverrides` to `orchestrations/config/llm-defaults.json` — the CodeMie ladders above, declared once for all projects.
2. Add `modelOverrides` for `claude-haiku`, `claude-sonnet` and `claude-opus` in that same base — **none exist today**, so without them the models run with no `maxIterations`, `autoCompressAt`, `temperature` or `reasoningEffort`.
3. Include every escalation edge so no model can enter a tier without a path out — an existing regression guard enforces this and caught me dropping edges last time.
4. Delete the three projects' `ladders`/`modelOverrides` blocks so they inherit, leaving only what genuinely differs per project (probably nothing).
5. Change `run-agent-orchestration.sh:402` to `CLAUDE_SH="$SCRIPT_DIR/claude.sh"; CLAUDE_CMD="codemie-claude"`.
6. Delete `orchestrations/scripts/codemie-claude.sh` — 1,602 lines, 10,712 behind the script it forked.
7. Correct `orchestrations/INSTRUCTIONS.md:92`, which still calls that fork "an identical clone except CLAUDE_CMD".
8. Set `EPAM_MODEL_PROVIDER_MAP="claude-*=codemie-claude"` in project config, replacing the qwen/minimax map.
9. Switch `EPAM_ORCHESTRATION_PROVIDER` and `ORCH_GATE_PROVIDER` from `qwen` to `codemie-claude`.
10. Add `codemie-claude` to `providers.json`'s `known` list — **a live bug today**: preflight rejects a PRD assigning it while two call sites accept it.
11. Pass `--base-url` through `ai-run.sh`'s codemie arm from an `EPAM_CODEMIE_BASE_URL` env var, so the mock can redirect it exactly as OpenRouter and MiniMax are redirected.
12. Update the 14 test files referencing the deleted fork to target `claude.sh`.
13. Run `mock-expectations.js` and the mocked pipeline to prove the wiring before a single real call.
14. Only then consider one live run.

## Tests, written before each change

- the engine base declares a ladder for every tier, and every project resolves to it
- a project that overrides nothing inherits the whole CodeMie ladder
- every model that can enter a tier has an escalation edge out of it
- `claude-haiku|sonnet|opus` each resolve a `modelOverrides` entry — no model runs unconfigured
- `EPAM_CODEMIE_BASE_URL` reaches the wrapper as `--base-url`
- no model literal appears outside the ladder declaration (the existing guard, now covering config)
- the mocked pipeline reaches the same stage it does today

## What I cannot promise

- **Whether Sonnet-5 and Opus-5 behave well in these seams.** They are newer than anything this
  pipeline has run. The mock proves wiring, not judgement.
- **Whether the QA gates and writer behave the same under Claude Code via CodeMie** as under
  glm-5.3 via OpenRouter. Different agent runtime, different tool loop.
- **Model availability is deployment-specific.** These 13 Claude ids came from `codemie models list`
  against your profile today.

## Open question

Step 4 deletes the projects' ladder blocks so they inherit. That is the point of the architecture —
but it means metrolinx, mock3 and skyscanner all move to CodeMie at once, because they would all
inherit the same base. If mock3 or skyscanner should stay on qwen/minimax, they keep their own
`ladders` block and override the base. Which do you want?
