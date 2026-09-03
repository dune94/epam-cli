# Seam Consistency & Hot-Swap Compatibility — Analysis

**Date:** 2026-09-03 · **Against:** `v1.6` (pipeline byte-identical) · **Changes made:** none. Analysis only.

---

## 1. The question

`provider-sets.json` states the requirement in its own `$hotSwap` key:

> *"If one provider's tokens run out mid-programme, the other must be back on the air in SECONDS: one env var, no build, no test run, no git operation, no file copied over another."*

So the test for every seam is one thing: **when `EPAM_PROVIDER_SET` changes, does this seam change with it?**

A seam that answers "no" is not a style problem. The swap happens *because* a provider is exhausted,
so a seam that ignores the set keeps calling the dead account and fails the run at the exact moment
the swap was meant to rescue it.

---

## 2. Verdict

**The swap mechanism works. The swap is not honoured everywhere.**

There are **two parallel routing paths**, and only one of them consults the active set.

```
PATH A — the declared path (swap-safe)
  EPAM_PROVIDER_SET
    └─ provider-sets.json  sets.<name>.settingsFile
         └─ llm-defaults.<set>.json
              ├─ runners.<name>        ← which CLI actually executes
              ├─ ladders / ladderTierOrder
              ├─ modelOverrides
              └─ finalFallback

PATH B — the shell-variable path (NOT swap-safe)
  ORCH_GATE_PROVIDER ─┐
  EPAM_ORCHESTRATION_PROVIDER ─┤
  SPEC_MODE_PROVIDER ─┤
  STORY_PROVIDER ─────┼─→ `epam run --provider $X`
  FREE_PROVIDER ──────┤    provider_to_cli "$X"
  EPAM_FINAL_FALLBACK_PROVIDER ─┤
  CPA_PROVIDER ───────┘
```

**Not one of those seven variables appears in any `llm-defaults.*.json`.** Path B is populated from
launcher assignments and ambient `.env`, never from the set. Changing the set does not move it.

---

## 3. How the count was verified

Raw sweeps inflate here, so each stage is recorded:

| stage | count | note |
|---|---|---|
| Raw grep for provider-ish lines in `orchestrations/scripts` | 211 | includes comments |
| Non-comment | 194 | |
| Vendor-literal fallback `${X:-<vendor>}` | 44 | first honest-looking number |
| — minus **binary-name defaults** | −25 | `EPAM_CLI:-epam`, `CLAUDE_CMD:-claude`, `AI_RUNNER_CMD` — these name an **executable**, not a provider. Correct as written. |
| — minus two miscounts | −2 | `claude.sh:6400` (binary lookup), `lib/sandbox-invoke.sh:97` (`EPAM_SANDBOX_TARGET_CMD`, a command) |
| True swap-unsafe provider resolutions (first pass) | 17 | |
| — minus one further correction | −1 | `tier2-free-run.sh:56` (`FREE_PROVIDER:-openrouter`) is a standalone free-tier test harness, not a real seam — declared as an exact-match exemption, not deleted from scope |
| **True swap-unsafe provider resolutions** | **16** | |

Corpus: 142 shell, 118 JS, 110 Python files (venvs excluded).

---

## 4. The 16 swap-unsafe seams

**Corrected 2026-09-03, count was 17.** `tier2-free-run.sh:56`'s `FREE_PROVIDER:-openrouter` was
misclassified below as swap-unsafe. It is a standalone test harness for OpenRouter's free-tier
models specifically, run against its own throwaway PRD (`hello-world-prd.json`) — unrelated to any
client run's `EPAM_PROVIDER_SET`. Hardcoding `openrouter` there is the entire point of the script,
the same way a plugin is allowed a stack fact that engine code is not. Declared as an exact-match
exemption in `orchestrations/config/provider-swap-exemptions.json`, consulted by
`scan-provider-swap-unsafe.js` — not deleted from the scanner's scope, so a genuinely new defect
elsewhere in that file, or the same variable defaulting to a different vendor, is still caught.

| # | file:line | resolves | baked vendor | reachable? |
|---|---|---|---|---|
| 1 | `contextualize-stories.sh:783` | `AI_PROVIDER` for CPA | `openrouter` | **always** — `CPA_PROVIDER` is assigned nowhere in the tree |
| 2 | `brownfield-repro-test-writer.sh:497` | `_base_provider` for the repro-test writer | `openrouter` | when `SPEC_MODE_PROVIDER` and `EPAM_ORCHESTRATION_PROVIDER` are unset |
| 3–6 | `run-agent-orchestration.sh:8286,8337,8361,8367` | `epam run --provider` for gates | `openrouter` | when `ORCH_GATE_PROVIDER` unset |
| 7 | `code-review-cycle.sh:137` | `--provider` for code review | `claude` | when `EPAM_ORCHESTRATION_PROVIDER` unset |
| 8–9 | `team-lead-review.sh:186,195` | reviewer provider | `claude` | when the map misses / var unset |
| 10 | `tier3-skyscanner-app-run.sh:296` | `EPAM_FINAL_FALLBACK_PROVIDER` | `openrouter` | default |
| 11 | `tier3-travel-app-run.sh:281` | `EPAM_FINAL_FALLBACK_PROVIDER` | `openrouter` | default |
| 12 | `update-monitor.sh:132` | `PROVIDER` from positional `$5` | `claude` | when arg omitted |
| 13–16 | `claude.sh:1632, 9441, 9521, 10151` | `STORY_PROVIDER` | **`codex`** | when `STORY_PROVIDER` unset |

### 4.1 The worst of them

**`STORY_PROVIDER:-codex` (4 sites).** `codex` is **not a declared provider set** — it exists only in
`provider_to_cli()`. Four seams default to a vendor that no set can select and no swap can reach.

**`CPA_PROVIDER` (site 1).** Assigned nowhere in the entire tree, so the fallback is not a fallback
— it is the only path. Contextualisation always resolves `openrouter` regardless of the active set.

**Sites 10–11.** `tier3-skyscanner-app-run.sh:218` and `tier3-travel-app-run.sh:216` additionally do
`export EPAM_ORCHESTRATION_PROVIDER="openrouter"` unconditionally. **Those two projects cannot hot-swap
at all** — the launcher overwrites the choice before the run starts. `tier3-metrolinx-run.sh` does
not do this; it exports the variable but never assigns it (line 337), so metrolinx inherits whatever
`.env` holds.

---

## 5. Engine branches on vendor names

`provider-sets.json` `$comment` states the rule:

> *"Selecting a set is a LOOKUP, never a branch: an engine naming its sets in a case statement would
> make adding a third one an engine change."*

`claude.sh:1639-1653` `provider_to_cli()` is exactly that branch:

```bash
case "$1" in
    opencode)                                  echo "opencode" ;;
    codex)                                     echo "codex" ;;
    codemie-claude)                            echo "codemie-claude" ;;
    claude)                                    echo "claude" ;;
    copilot|openai|openrouter|cursor|minimax)  echo "$EPAM_CLI" ;;
    epam)                                      echo "$EPAM_CLI" ;;
    *) error "Unknown aiProvider '$1' …"
```

Ten vendor names in engine code. Adding an eleventh provider is an engine edit — the precise thing
the declaration layer exists to prevent. There are **7 such `case`/branch sites on a provider
variable** across the scripts.

Note this function is *correct in behaviour* — its error arm is loud, and the `claude)` arm carries a
comment recording a real bug where a provider passed the gate and died here. The defect is
structural: the mapping is a fact about a stack and belongs in the declaration, not a case statement.

---

## 6. Inconsistencies between the sets themselves

| set | runner | `finalFallback` |
|---|---|---|
| `claude` | `claude` | `claude-sonnet-5` via `claude` |
| `codemie` | `codemie-claude` | `claude-sonnet-5` via `codemie-claude` |
| `mockserver` | `claude` | `claude-sonnet-5` via **`claude`** |
| `openrouter` | `claude` | **ABSENT** |

Two findings:

1. **`openrouter` declares no `finalFallback`.** The other three do. On ladder exhaustion — the one
   point where the ladder has nothing left to say — the openrouter set has no declared second answer,
   while its hot-swap peers do. Whether that is deliberate is not recorded anywhere.

2. **`mockserver`'s fallback routes to real `claude`.** This is already documented in its own `$why`:
   *"this set was built by copying the codemie one, and the paid wrapper came with it. A fallback is
   the one place a run reaches when everything else has failed — precisely where an escape to a paid
   provider would be least noticed and most expensive."* It is **known and recorded, not fixed**. The
   mock set can still reach a paid provider on exhaustion.

---

## 7. What IS swap-safe

Not everything is broken, and this is the part worth protecting:

- **`llm-handler.sh:33-34`** reads `${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}` — an **empty**
  fallback, then fails loudly at line 189 with *"no provider configured"*. No vendor guess. This is
  the correct shape.
- **Runner selection** genuinely follows the set: `runners.<name>` in `llm-defaults.<set>.json` is
  what decides whether `claude` or `codemie-claude` executes.
- **Ladders, models and effort** follow the set — `ladderTierOrder`, `ladders`, `modelOverrides` are
  all per-set declarations.
- **The credential layer is declared per set** (`$credentials`), fixing an earlier defect where every
  stack exported MiniMax and OpenRouter keys regardless of which one it called.
- **The spend probe is declared per set** (`$spendProbeWhy`), fixing the same class in ten places
  across six launchers — *"a codemie or mockserver run still called OpenRouter."*

**33 lines across 10 files do consult `EPAM_PROVIDER_SET` / `provider-sets.json` / the settings
files.** The declaration layer is real and used. It is Path B that bypasses it.

---

## 8. Why this survived

Three reasons, all structural rather than anyone's oversight:

1. **The work was scoped as "keep both stacks executable", not "make every seam obey the set".**
   Both stacks *are* runnable side by side. Nothing in that framing required sweeping Path B.

2. **Path B predates the declaration layer.** The `*_PROVIDER` variables are the older mechanism.
   `provider-sets.json` was added over the top and took ownership of runners, ladders and models —
   but never of these seven variables.

3. **Nothing detects it.** There is no guard, scan or test that fails when a seam resolves a vendor
   without consulting the active set. `$spendProbeWhy` records this exact class being found and fixed
   once, but that fix was applied to the spend probe alone and never generalised into a check — so
   the class returned in 16 other places, silently.

---

## 9. Severity, for prioritisation

| severity | seams | reasoning |
|---|---|---|
| **Blocks a swap outright** | 1, 11, 12 (+ the two launcher `export`s) | The set is overwritten or never consulted; a swap cannot reach these at all |
| **Silently wrong on exhaustion** | 3–6, 7, 8, 9 | Falls to a literal exactly when the operator swapped away from it |
| **Points at a non-existent set** | 13–16 | `codex` is selectable by no set |
| **Structural, not yet biting** | `provider_to_cli()`, the 7 branch sites | Correct today; makes an 11th provider an engine change |
| **Declared inconsistency** | openrouter `finalFallback` absent; mockserver → paid `claude` | Both are declaration-level, both currently unresolved |

---

## 10. Recommended order (no changes made)

1. **Write the detector first.** A scan that fails when any provider resolution does not derive from
   the active set. Without it the count regresses — it already has, once.
2. **Fix the three swap-blockers** (sites 1, 11, 12 and the two launcher exports).
3. **Fix the eight exhaustion-path seams** (3–9) — these are the ones that bite during a real swap.
4. **Retire `:-codex`** (13–16) or declare a set that can select it.
5. **Resolve the two declared inconsistencies** — decide whether openrouter should have a
   `finalFallback`, and whether mockserver may reach paid `claude`.
6. **Move `provider_to_cli()`'s mapping into the declaration**, closing the engine-branch class.

Steps 2–4 are ~16 sites and should ship together with the detector from step 1 as a test, so the
class cannot come back a third time.

---

## Appendix — method

- Scope: `orchestrations/scripts/**` (142 shell, 118 JS, 110 Python; venvs excluded).
- Provider *values* were separated from *binary names* by hand after the sweep; the raw 44 included
  25 legitimate executable-name defaults.
- Reachability was checked per variable by searching for every assignment in the tree and every
  occurrence in `orchestrations/config/*.json`.
- No file was modified. Every line number is against the tree at the date above, which is
  byte-identical to `v1.6` for `orchestrations/`.
