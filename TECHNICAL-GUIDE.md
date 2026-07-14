# EPAM CLI Technical Guide

_Last updated: June 4, 2026_

This document explains the full EPAM CLI platform — the interactive CLI, agent runtime, orchestration system, and supporting dashboards/operations pipelines. Use it as the canonical reference when onboarding engineers, debugging production issues, or extending automation.

---

## 1. System Overview

| Layer | Responsibilities | Key Entry Points |
| --- | --- | --- |
| CLI Runtime | Command routing, authentication, REPL chat, non-interactive invocations, SDK library surface | `src/index.ts`, `src/cli/index.ts`, `src/sdk.ts`
| Agent Core | Conversation loop, tool execution, plugin tools, memory injection, auditing, history compression, provider failover | `src/agent/AgentRunner.ts`, `src/providers/ProviderChain.ts`, `src/tools/`
| Context & Storage | Session JSONL store, Redis sharing, consultation context ingestion, memory loader | `src/context/*.ts`, `src/memory/`, `.epam/sessions/`, Redis (`EPAM_REDIS_URL`)
| Orchestration | Multi-agent planner/executor, LLM topology routing, idempotent checkpointing, sandbox isolation, behavioral contracts, brownfield ingestion, webhook triggers | `orchestrations/scripts/run-agent-orchestration.sh`, `orchestrations/prd.json`
| Dashboards & Ops | Eleventy pipeline, provider/model filters, scorecard, SWE-bench results, demo path | `orchestrations/dashboards/*`, `benchmarks/`, `scripts/`

Supporting directories: `src/tools` (built-in tools), `src/providers/*` (API adapters), `src/cli/repl` (TTY UX), `orchestrations/agents` (profiles, knowledge base), `plans/` (operational plans).

---

## 2. CLI Architecture

### 2.1 Entry & Command Surface
- `src/index.ts` loads environment variables, creates the Commander program via `createCLI`, and injects the `chat` command when a user supplies only global flags.
- `src/cli/index.ts` registers every command module (`chat`, `run`, `phase`, `orchestrate`, `estimate`, `provider`, etc.), allowing both interactive and scripted workflows to share the same auth/config plumbing.

### 2.2 Configuration & Auth Resolution
- `ConfigResolver` merges CLI flags, `EPAM_*` env variables, project-level `.epam/settings.json`, and global config (`~/.epam/config.json`). Provider/model metadata records the selection source (`flags`, `env`, `project`, or defaults) for auditability.
- `AuthManager` coordinates device and browser login flows, keychain-backed credential storage, and provider logins (`epam provider <cmd>`). `resolveProviderSecret` fetches API keys lazily so commands can run in dry-run mode without secrets.
- **v1 Auth bridge model (DEC-005):** User-managed API keys stored in the OS credential manager (`KeychainKeyStore`). Manual entry via `epam provider login <provider>` or `EPAM_API_KEY_*` env vars. Browser PKCE for Codemie. No auto-provisioned brokered keys in v1 — deferred to v2+. See `.epam/decisions.jsonl` DEC-005 and `.epam/provider-auth-research.md` for full rationale.

### 2.3 Session Lifecycle
- `SessionStore` writes every REPL turn to `.epam/sessions/<ulid>.jsonl`, enabling `/resume`, `/fork`, and crash recovery. Files double as import/export payloads for `epam import <code>`.
- `RedisSessionStore` (activated by `EPAM_REDIS_URL`) serializes `SessionBundle`s for `/share` and `/handoff`. Keys follow `epam:session:<ulid>` (7-day TTL) and optional handoff/team lists. This path is also what future cross-process failover hooks will call.

### 2.4 Interactive REPL UX
- `Repl` (`src/cli/repl/Repl.ts`) orchestrates the prompt loop, multi-provider failover (`ProviderChain.onFailover`), slash commands, history, and streaming output.
- `RawInputBox` handles ANSI rendering, bracketed paste (multi-line insertions stay intact), cursor math, and hotkeys.
- `SlashCommands` expose operations like `/resume`, `/share`, `/handoff`, `/import`, `/config`, etc., all built on top of the same `Repl` context so the running session is never lost.

### 2.5 Agent Execution Pipeline
1. `chat` command builds the system prompt (project constraints + consultation context) and passes it to `AgentRunner`.
2. `AgentRunner` maintains the conversation state, streams output, and enforces limits (`maxIterations`, `autoCompressAt`, `maxOutputTokens`).
3. **MEMORY.md injection (EPAM-039):** `MemoryLoader` (`src/memory/MemoryLoader.ts`) reads `MEMORY.md` from the project root on REPL startup, resolves linked memory files via `MemoryImportResolver`, and injects a summarized block into the system prompt on the first `AgentRunner.run()` call. Memory reloads when `/compact` runs. Lazy injection pattern avoids async I/O in the synchronous `AgentRunner` constructor.
4. Tool calls are routed through `ToolRunner`, with built-ins `ReadFile`, `WriteFile`, `ListFiles`, `Search`, `FetchUrl`, and `Bash`. The `RalphWiggumLoop` retries bash commands on transient failures while keeping transcripts.
5. `AuditorRunner` can run post-turn auditors (lint, tests, etc.) when requested, feeding findings back into the transcript.
6. Memory compression uses `context/MemoryCompressor` to shrink history once token estimates cross thresholds.

### 2.6 Provider Chain & Failover
- `ProviderChain` instantiates provider slots (Anthropic, OpenAI, Gemini, Copilot, Codex, Cursor, Qwen, Codemie, Proxy) and keeps a `ProviderHealth` ledger. On errors it classifies whether to retry the same slot or advance to the next authenticated slot.
- Slots inherit credentials from env vars or provider-specific login files (`~/.codex/auth.json`, SSO tokens, etc.). The chain emits failover events to the REPL, which prints summaries without losing context.
- The orchestration-level failover plan (`plans/orchestration-failover-plan.md`) describes how to pre-register backup provider/model tuples, forecast token ceilings, and persist failover decisions so that CLI + orchestration share the same behavior path.

### 2.7 Non-Interactive Entrypoints
- `epam run` executes a single prompt (stdin or CLI argument) without booting the REPL but still uses `AgentRunner` for deterministic behavior.
- `estimate`, `orchestrate`, `phase`, `report`, `squad`, `sync`, and `provider` commands shell out to orchestration scripts or perform bookkeeping around `prd.json` phases.

---

## 3. Orchestration Architecture

### 3.1 Data & Story Model
- `orchestrations/prd.json` is the canonical backlog. Stories link to phases, providers, and orchestration metadata (lanes, dependencies, token ceilings, etc.).
- `orchestrations/agents/profiles.json` defines persona prompts for each autonomous agent; `AGENTS.md` captures learned behaviors.
- Knowledge base entries live beside the profiles (`KB.md`) and are injected when generating prompts.

### 3.13 Full Pipeline Cost Tracking (GAP-P22)
- `run_orch_prompt()` in `run-agent-orchestration.sh` now passes `ORCH_JSON_RESULT` to `ai-run.sh`, which captures the claude CLI's `--output-format json` response to a temp file. After each invocation, cost and token data are extracted and written to `phase-cost.jsonl` via `append_pipeline_cost_record()`.
- Every pipeline agent type is labeled: `assessment`, `spec-coordinator`, `qa-gate:*`, `topology-router`, `spec-pass`.
- `calibrate.py` computes `pipeline_overhead_ratio` (EMA of pipeline/story cost ratio) and stores it in `calibration.json`. The CPA uses this ratio to show `Total (est): $X.XX (incl. pipeline ×N.NN)` alongside the story-level blended estimate.
- `blendedEstimate.totalCost` field in `cpa-review.jsonl` reflects the story estimate × ratio for use in budget forecasting.
- Scorecard dashboard (`scorecard.html`) shows separate "Avg Story Cost" and "Avg Total Cost" KPI cards with pipeline overhead percentage.
- **Observation (first tracked run):** Assessment agents dominate pipeline overhead (~82% of pipeline cost). Full-gates hello-world run: pipeline = 7.75× story cost. The ratio calibrates via EMA and converges toward the true value over multiple runs.

### 3.2 run-agent-orchestration.sh Flow — Complete Step Reference

Every step below is registered in `step_emit()` (`orchestrations/scripts/run-agent-orchestration.sh`, master ID list ~L179-239) and rendered 1:1 on the `monitor.html` dashboard's Pipeline Steps table — the step IDs in this table are exactly the IDs that appear there. `print_step_checklist()` (~L242-302) prints the planned/skip preview at the start of every phase. This reference is exhaustive: every ID that can appear in `step-status.json` is listed, including the two IDs (3.2, 3.6) that are tracked in logs but never call `step_emit` themselves, and Step 6 which runs once at the very end of a phase.

| ID | Label | Skip condition | What it does | Pass / fail |
|---|---|---|---|---|
| **0 / 0a / 0b** | Specification pass — openspec (elaboration) / speckit (verification) | `--dry-run`; `EPAM_SPEC_MODE=0`; `spec-mode-runner.js` or Node missing | `run_specification_pass()` invokes `spec-mode-runner.js --phase <phase>` (Node), using `SPEC_MODE_OPENSPEC_MODEL`/`SPEC_MODE_SPECKIT_MODEL` (default `moonshotai/kimi-k2`). See §3.5 for what the spec agents actually do (AC elaboration, story splitting). | Runner's own exit code; nonzero hard-exits the whole pipeline. |
| **0.1** | CPA pre-pass | `SKIP_CPA=1`; `contextualize-stories.sh` missing | Runs `contextualize-stories.sh --phase $PHASE --apply`, injecting the latest `phase-handoff-*.md`. `STRICT_CPA=1` adds `--strict`. | exit 0 pass; exit 2 **warn** (elevated risk); exit 3 **fail**, hard-exits unless skipped. |
| **0.5** | Pre-phase skill assessment | `SKIP_SKILL_ASSESSMENT=1` | `run_pre_phase_assessment()` — tool-enabled LLM prompt that assigns missing `agentRole`, splits impl/test-mixed stories, creates `profiles.json` entries for unknown roles, injects per-story skill pitfalls and QA-agent file authorizations. Up to 3 attempts, each gated by a deterministic reviewer (LLM verdict + a Python allowlist diff restricting changes to `agentRole`/`model`/`aiProvider`/`reasoningEffort`, no story add/remove). | Any violation reverts to the pre-attempt snapshot and retries; after 3 failed attempts, accepts the reverted state as `warn "non-critical"` — never hard-fails. |
| **0.6** | Hybrid pre-coordination | Only runs when `RESOLVED_ORCH_MODE = "hybrid"`, else skip reason `ORCH_MODE=<mode>` | Tool-enabled LLM prompt flagging cross-lane dependencies / plan-mode-eligible stories (`estimatedHours>=6` or `dependencies>=2`), appends JSONL handoffs to `agent-messages.jsonl`. | Failures only log a warning — never blocks. |
| **0.7** | Cross-phase regression guard | `SKIP_REGRESSION_GUARD=true`; node/vitest binary missing | `vitest run --root $PROJECT_ROOT` — catches a prior phase's regressions before any new-phase story runs. | Nonzero vitest exit → hard-exit. |
| **0.8** | mkdir src/ dirs | Never (always runs) | `mkdir -p src, src/skyscanner, public, review` so the first coding agent doesn't need to create directories itself. | Always pass. |
| **0.9** | PRD model coordinator | `SKIP_PRD_MODEL_COORDINATOR=1` | Counts pending stories missing `model`/`aiProvider`/`reasoningEffort`; if any, prompts `ORCH_GATE_MODEL` (default `MiniMax-M3`, tool-enabled) to assign them directly in the PRD, up to 3 attempts, gated the same way as 0.5. A post-condition safety net force-fills any still-missing field with `MiniMax-M3`/`minimax`/`medium`. | Always `pass` — mismatches downgrade to the fallback fill rather than failing. |
| **1** | Main-branch stories | No non-review main-branch stories exist | Iterates each story: re-checks live status (skips `deprecated`/`blocked`), runs the **inline TC-writer gate** (see below) for pure-test stories, `run_story_with_watchdog()` (see below), on failure one `run_story_recovery_analyst()` attempt, records cost, per-story `tsc --noEmit` (`story_tsc_gate()`), checkpoints. | Any story failure → `fail`, hard-exit. |
| **1.5** | Auto-commit | No worktree-lane stories exist; working tree already clean | `git add -A`, `scan-secrets.sh`, commits as `chore: auto-commit main-branch story output for phase $PHASE` — so worktrees created next inherit main-branch output. | Secret detected → `fail` + unstage; nothing to commit → `skip`. |
| **2** | Create worktrees | No parallel stories (neither primary nor independent) | `"$CLAUDE_SH" --setup-worktrees`. | Nonzero → hard-exit. |
| **3a / 3b** | Primary / Independent agent | 3b only: no independent stories | Launches `"$CLAUDE_SH" --worktree primary\|independent --phase $PHASE` as **background processes** in parallel, waits on both. | Either failing → `fail`, but the phase continues through 3.1/3.2 first (so completed stories still merge) before failing the phase overall. |
| **3.1** | Worktree health check | No worktrees created | `worktree-health-check.sh AUTO_COMMIT=true` — auto-commits uncommitted agent output before gate assessment. | Nonzero → emitted as `warn "health issues auto-fixed"` but actually hard-exits. |
| *3.2* | *Merge worktrees* | *(tracked in logs only — no `step_emit` calls exist for this ID)* | `git merge-tree --write-tree` as a conflict-detection guard before the real `git merge --no-ff -X ours`, to avoid silently discarding a worktree's changes on a genuine conflict. | — |
| **1.6** | TC writer gate (batch) | `SKIP_TC_WRITER=1`; every test story in the phase already has `testCriteria.facts` | Runs **after** Step 3.2 (deliberately, so it works for both main-branch and worktree topology). Batch call to `post-impl-tc-writer.sh --prd --phase --output-dir`, up to 3 attempts. See "TC-writer gates" below for how this relates to the inline gate inside Step 1. | Invalid PRD JSON after an attempt → hard-exit. Stories still missing facts after 3 attempts are individually marked `status="blocked"` (not the whole phase) → `warn`. |
| **1.65** | Skills coordinator audit | `SKIP_SKILLS_AUDIT=1` | Deterministic scan (no LLM) dedupes exact-duplicate `[Self-Heal]` notes in `profiles.json` and flags "do X...don't do X" self-contradictions via regex; LLM only rewrites the specific flagged paragraph. | Always `pass`; a corrupting rewrite restores the pre-audit snapshot. |
| **1.66** | Tools coordinator audit | `SKIP_TOOLS_AUDIT=1` | Deterministic scan of every reviewed dynamic tool (`.epam/dynamic-tools/*.sh`) for `bash -n` errors, ≥2 "exited non-zero" occurrences this phase, or purpose-comment overlap ≥0.6 (near-duplicate); LLM fixes broken tools or flags duplicates (no auto-merge). | Always `pass`; a corrupting fix restores the pre-audit snapshot. |
| **3.5** | Post-parallel assessment | `SKIP_SKILL_ASSESSMENT=1`; `phase-cost.jsonl` empty | `run_phase_assessment()` analyzes phase-cost data and profile issues; verifies a genuinely new assessment record was written (not just exit code). | Any failure/no-record → `warn "non-critical issues"`, never blocks. |
| *3.6* | *Team Lead Code Review* | *(no `step_emit` call)* | `team-lead-review.sh` | Any story with `reviewStatus == "escalated"` (max review iterations exhausted) → hard-exits the phase. |
| **3.7** | Pre-review build gate | `SKIP_PRE_REVIEW_GATE=true`; no `package.json` | `vitest run` (bounded by `EPAM_TEST_TIMEOUT_SECS`, default 300s), then `tsc --noEmit` (skipped if no `.ts` files yet). | Either check failing → hard-exit. |
| **3.8** | Lint gate | `SKIP_LINT_GATE=true`; no node binary | `tsc --noEmit` + `eslint src/ --max-warnings 0` (config auto-probed via `--print-config`). Failure triggers a 3-agent self-heal chain (`gate-finding-analyst` → `story-ac-remediator` → `profile-augmentor`, on `claude-haiku-4-5-20251001`) that maps the failure to its owning story and appends corrective ACs. | If remediation applied → exit **2** (tier3 runner retries the phase); else hard-exit. |
| **4** | Review stories | No review stories in this phase | Iterates review stories, clears stale `review/<id>-review.md`, `run_story_with_watchdog()` per story. | Any failure → `fail`. |
| **4.2a** | SAST sentinel | (see testing-gates umbrella below) | Evidence-injected, **tool-disabled** prompt over pre-run Semgrep JSON + `npm audit` + tsc diagnostics; dev-dependency CVEs always classified "minor" regardless of CVSS. | `summary.blockerCount>0` → fail; unparseable-with-explicit-fail-string → fail; unparseable-with-no-fail-string → `warn` "no parseable findings" (treated as pass-like). |
| **4.2b** | Spec validator | (umbrella) | Tool-enabled prompt against `.stories[]`. A Python extractor only counts a "fail" verdict as grounded if ≥1 criterion status isn't `untestable` — an all-`untestable` fail downgrades to `warn`. | Grounded failures>0 → fail; `overallVerdict:"warn"` → warn "partial"; no data → warn "no story data". |
| **4.3a** | Review ranger | Phase B — only runs if Phase A had zero failures, else `skip "Phase A failed"` | | Literal `"verdict":"fail"` → fail; `"verdict":"warn"` → warn "non-blocking findings"; else pass. |
| **4.3b** | Mutant hunter | (Phase B, same gate as 4.3a) | Focuses on mutation testing of critical paths (auth, billing, provider failover); explicitly instructed to `warn` with `mutationScore:100` (non-blocking) when no source changed. | Same verdict logic as 4.3a — `warn "score 50-69%"` for borderline scores. |
| **4.4a** | Fuzz-weaver | Phase C — only runs if Phase A+B had zero failures, else `skip "Phase A/B failed"` | Grounding check: actually **executes** the agent's own proposed test against the real code and only honors a "fail" if it genuinely reproduces the bug. | Ungrounded fail → downgraded to `warn "unverified findings downgraded"`. |
| **4.4b** | Perf sentinel | (Phase C, same gate as 4.4a) | Requires `real_blockers>0 AND filesAnalysed>0` to honor a fail. | Otherwise → `warn "hallucinated fail downgraded"`. |
| **4.6** | Browser E2E routing | `SKIP_BROWSER_E2E_ROUTING=true`; no phase stories; "no stories matched" (title/description doesn't hit the `ui\|frontend\|screen\|page\|form\|browser\|e2e\|auth\|checkout\|payment` routing regex) | Scores each matched story 0-N by hours/priority/keywords; routes score ≥7 to `playwright-agent`, 4-6 to `lightpanda-agent` (falls back to lightpanda if playwright profile missing); `FORCE_LIGHTPANDA=1`/`FORCE_PLAYWRIGHT=1` override; capped at `MAX_BROWSER_ROUTING_STORIES` (default 3). | Routed response `"verdict":"fail"` → fail; `"warn"` → warning only; zero routed → skip. |
| *6* | *Final post-phase assessment* | — | Terminal step, runs once at the very end of a phase (not part of the 28-ID checklist, but the last `step_emit` call in the file). | pass/warn only — no fail path. |

**Umbrella for 4.2a-4.4b + 4.6**: `SKIP_TESTING_GATES=true` skips all six testing-gate steps in one block; `phase_story_count==0` skips the whole `run_testing_gates()` function silently (no `step_emit` at all — a plain early return).

#### Model escalation — the inference ladder (`claude.sh`)
Every story attempt is `rung = retry_count / 2`, 2 attempts per rung, up to `EPAM_MAX_RETRIES` (default 7 → **8 total attempts**, retries 0-7):
- **Rung 0** (retries 0-1): base model, base effort.
- **Rung 1** (retries 2-3): same model, effort → `medium`, `STORY_MAX_ITERATIONS += 5`.
- **Rung 2** (retries 4-5): model escalates — priority order PRD `.retryModel` → `EPAM_RETRY_MODEL` → `classify_ladder_tier()` + `get_model_ladder_step()` (reads `EPAM_MODEL_LADDER_MEDIUM`/`_HIGH`, or `EPAM_MODEL_LADDER` to force one ladder for both tiers). Effort stays `medium`.
- **Rung 3+** (retries ≥6): if the story never escalated yet, jumps straight to `EPAM_FINAL_FALLBACK_MODEL`/`_PROVIDER`; otherwise steps the ladder again from the Rung-2 model. Effort → `high` (maximum).
- **Same-rung retry** (the 2nd attempt within a rung): model/effort stay fixed — the previous attempt's FailureAnalyst-injected guidance is expected to do the work instead.
- `classify_ladder_tier()`: PRD `.ladderTier` override wins; otherwise a story that already hit `MAX_RETRIES` in a prior cycle, or has ≥6 distinct failure diagnoses, classifies as `high` tier, else `medium`.

#### Self-healing — `run_failure_analyst()` diagnosis targets (`claude.sh`)
Only runs on test-suite failures (not missing-deliverable failures) when a gate provider is configured. Six targets, each gated by a reviewer + snapshot/revert flow with a 3-round retry and an `[unreviewed-fallback]` tag if the reviewer keeps rejecting:
- **`prd`** — patches a specific `acceptanceCriteria[idx]` entry.
- **`tc`** — patches a specific `testCriteria.facts[idx]` entry.
- **`skill`** — appends `[Self-Heal] <note>` to the story's role in `profiles.json` (this-retry-only guidance), exact-duplicate-guarded.
- **`kb`** — appends to a per-role `KB-<role>.md` (permanent, cross-run lesson), same dedup pattern, entries capped at 200 chars.
- **`tool`** — writes a new script to `.epam/dynamic-tools/<name>.sh`, guarded against a tool re-invoking the project's own test command, marked `.reviewed` before it's ever allowed to execute.
- **`none`** — no structural fix; relies purely on the inference ladder's model/effort escalation.

#### Vendor-dir protection & dependency install (`claude.sh`)
Exact call order per story attempt:
1. `run_dependency_check "$PROJECT_ROOT"` — pre-emptive, **before** the lock, so a dependency an earlier attempt's file already imports gets installed before the agent's own turn starts.
2. `_scope_lock "$story_id"` — locks out-of-scope `.ts` files read-only.
3. `_vendor_lock "$PROJECT_ROOT"` — `chmod -R a-w` on every `.epam/dependency-check.json` `vendorDirs` entry; touches `.epam/.vendor-lock-marker`.
4. Agent turn runs (locked window).
5. Inside `run_external_verification()`: `run_vendor_integrity_check` runs first (flags any vendor-dir file newer than the lock marker, excluding config-declared cache patterns, as tampering), then `_vendor_unlock` **always** runs regardless of the check's result.
6. `run_dynamic_tools_in_unlocked_window` — runs every `.reviewed`, syntax-clean dynamic tool unconditionally in this sanctioned window.
7. `run_dependency_check` runs again, post-turn, before the real test command executes.

When `EPAM_SANDBOX=true` (see §3.12), the chmod-based lock above is a defense-in-depth backstop only — the real enforcement is a kernel-level read-only bind mount the agent's own process cannot override.

#### Story watchdog & timeout escalation (`run_story_with_watchdog()`)
Effort-scaled default timeouts (`STORY_TIMEOUT_SECS` overrides): low → 600s, medium → 1200s, high → 2400s, unknown → 900s. On a timeout (exit 124): `hot_swap_story_model_if_unstable()` escalates one ladder step (or falls back to `EPAM_FINAL_FALLBACK_MODEL`), then retries once at `timeout × EPAM_WATCHDOG_RETRY_MULTIPLIER` (default 1.5×). A second timeout: with `EPAM_PAUSE_ON_TIMEOUT=true`, pauses for operator resume; otherwise marks the story `status="failed"` (`technicalNotes.failureReason="watchdog_timeout..."`), which Step 1's loop routes through one `run_story_recovery_analyst()` attempt before counting it as a phase failure.

#### TC-writer gates — inline vs. Step 1.6 (batch)
Both call the same `post-impl-tc-writer.sh`, but differ in scope and trigger:
- **Inline** (inside the Step 1 loop): per-story, triggers when **all** of a story's declared files are `.test.ts` (a pure test story whose paired impl story already ran earlier in the same loop); runs *before* that story executes; on exhaustion (3 attempts, still empty facts) blocks just that story and continues the loop.
- **Step 1.6** (batch, phase-scoped): runs *after* Step 3.2 worktree merge so it works for both main-branch and worktree topology; triggers when **any** declared file is `.test.ts` (broader — combo stories' files genuinely exist on disk by this point); blocks individually-still-missing stories without aborting the phase.

#### TC-density model upgrade (`maybe_upgrade_model_for_tc_density()`)
Called right after the inline TC writer succeeds, with the story's real `testCriteria.facts` count. No-op unless `ORCH_UPGRADE_MODEL` is set and `facts_count > EPAM_TC_FACTS_UPGRADE_THRESHOLD` (default 15). If triggered, rewrites the story's `.model`/`.aiProvider` in the PRD directly (provider resolved via `EPAM_MODEL_PROVIDER_MAP`) and records `.specification.tcDensityUpgrade = {from, to, reason, upgradedAt}` — corrects for AC count (used at spec-pass time, Step 0) under-predicting real behavioral-check density, which TC facts only reveal once actually written.

### 3.14 CPA Calibration & Blended Forecast Improvements
- **Model-aware calibration buckets** (June 3): `calibrate.py` now keys calibration on `effort:storyType:invokeMode:modelAlias` (haiku/sonnet/opus). Before this, Haiku and Sonnet actuals shared one bucket, causing 12× cost-per-token overestimates for Haiku stories.
- **Blended estimate floor** (June 4): `BLEND_ADJ_FLOOR=0.25` prevents the CPA LLM from adjusting below 25% of the formula baseline. Guards against the pattern where high confidence + aggressive LLM adjustment produced $0.005 blended for a story the calibration showed costs $0.156.
- **Tighter interpolation zone**: `BLEND_LOW` raised from 0.50 → 0.60. Stories with confidence below 0.60 now use the safe formula+20% path rather than a partially-LLM-dominated blend.
- Impact: total blended variance improved from +233% to -14% across a clean travel app run (11 stories, no retries).

### 3.9 LLM Topology Routing (GAP-P11)
- Before phase execution, `run-agent-orchestration.sh` calls `orchestrations/scripts/lib/topology-router.js` with story metadata (IDs, effort, roles, dependency edges, CPA file-overlap signals).
- The router makes a single Haiku tool-call using Claude's structured output (`select_topology` tool schema) and returns `{topology: "single"|"parallel"|"sequential", reason: string, source: "llm"|"heuristic"}`.
- `single` → lone story or tight coupling: collapsed to main branch, no worktree overhead. `parallel` → independent stories: existing worktree lane. `sequential` → shared file scope or dependency chain: stories run in order on main.
- Falls back to the count heuristic when no API key is set or the call fails — zero regression. Decision + reason logged to `phase-cost.jsonl` for dashboard audit.

### 3.10 Idempotent Execution & Checkpointing (GAP-P13 Phase 1)
- Each orchestration run gets a unique `ORCH_RUN_ID` (timestamp-based). After each story completes successfully, `checkpoint_complete()` appends an idempotency entry to `logs/checkpoint-<phase>-<run-id>.jsonl`.
- On crash-restart with the same `ORCH_RUN_ID`, `checkpoint_already_done()` detects already-finished stories and skips them without re-running — preserving partial progress without needing `RESET_STORIES=false`.
- `RESET_STORIES=true` explicitly calls `checkpoint_clear()` to purge checkpoints before resetting PRD story flags, ensuring a true clean slate.
- Checkpoint file location: `orchestrations/logs/checkpoint-<phase>-<run-id>.jsonl`.

### 3.11 Structured Story Outputs (GAP-P17)
- PRD stories can optionally declare `"outputSchema": { ... }` (a JSON Schema object). When present, `claude.sh` appends an `OUTPUT SCHEMA REQUIREMENT` block to the agent system prompt instructing it to conclude with a conforming JSON object.
- After the story completes, `emit_story_artifact()` extracts the first JSON object/array from the agent's result text and emits a `StoryArtifact` record to `logs/story-artifacts.jsonl`.
- Every story emits an artifact record regardless — stories without `outputSchema` emit `structuredOutput: null`. Fields: `storyId`, `phase`, `status`, `elapsedMinutes`, `costUsd`, `turns`, `outputSchema`, `structuredOutput`, `timestamp`.

### 3.12 Sandbox Isolation (GAP-P14)

`run-agent-orchestration.sh --sandbox` / `EPAM_SANDBOX=true` wraps each agent invocation in a Docker/Podman container via `orchestrations/scripts/lib/sandbox-invoke.sh`, injected as the `CLAUDE_CMD` replacement. Originally built to demonstrate filesystem isolation in general; extended 2026-07-13/14 to structurally close the vendor-directory tampering class of failure (`[vendor-guard] Vendor directory tampering detected`, e.g. SKY-004/SKY-002-impl) that the pre-existing chmod-based lock (`_vendor_lock`/`_vendor_unlock`, §"Vendor-dir protection" above) could not: chmod is same-UID-bypassable — the agent's own Bash tool runs as that same user and can just `chmod +w` a "locked" dir back. A kernel-enforced read-only bind mount cannot be undone by anything running inside the container, even as its own root. `chattr +i` was evaluated and rejected as a lighter-weight alternative: it requires `CAP_LINUX_IMMUTABLE`, which neither the orchestrator nor the agent process has (both run as the same non-root host user), so the orchestrator can't even grant the protection.

- **Vendor dirs mounted read-only**: for every entry in `.epam/dependency-check.json`'s `vendorDirs` (the same key `_vendor_lock` already reads — no new config), `sandbox-invoke.sh` adds a nested `-v "<dir>:<dir>:ro"` mount inside the broader `-v "${PROJECT_ROOT}:${PROJECT_ROOT}:rw"` mount; Docker lets the more-specific mount win for that subpath. Verified live: `chmod`/`touch` inside the mounted vendor dir fails with "Read-only file system," not "Permission denied" — proof it's a kernel/mount-level restriction, not a permission bit the same process could flip.
- **Configurable target command**: `EPAM_SANDBOX_TARGET_CMD` (space-separated, default `"claude"`) selects the binary run inside the container. This let the wrapper be reused for the `copilot|openai|qwen|cursor|minimax` provider branch in `claude.sh` (~L5515-5583) — previously the ONLY branch that called `$EPAM_CLI run` directly, unsandboxed, regardless of `--sandbox` state. That branch now swaps to `_epam_run_binary="$CLAUDE_CMD"` with `EPAM_SANDBOX_TARGET_CMD="node /opt/epam-cli/dist/epam.js"` whenever `EPAM_SANDBOX_IMAGE` is set, so qwen/minimax runs (this project's actual providers) are sandboxed too, not just the `claude`/`epam` default branches.
- **epam-cli reachable inside the container**: epam-cli's own repo root is bind-mounted read-only at `/opt/epam-cli` (not baked into the image, so it always reflects current source without an image rebuild). Combined with the target-command point above, this is what lets the sandboxed process actually invoke `epam run` regardless of what stack the *target* project uses — `epam` is always the same Node.js tool.
- **Base image derived dynamically, not hand-authored**: `derive_sandbox_base_image()` (`run-agent-orchestration.sh`, before the sandbox bootstrap block) reads `.project.stack.language`/`.runtime` from the PRD — data the LLM-based `generatePrd()` (`src/scaffold/ManifestAnalyzer.ts`) already writes for every project, previously write-only/unused downstream. Pattern-matches `python*`→`python:3.11-slim`, `golang*|go`→`golang:1.22-bookworm`, `rust*`→`rust:1.75-slim`, `node*|typescript*|javascript*` or unrecognized/missing→`node:20-slim` (fallback, never fails the build). Passed to `docker build --build-arg BASE_IMAGE=...`. `Dockerfile.sandbox` conditionally installs Node.js only `if ! command -v node` — a no-op for the common Node-based-target case, paid only by non-Node target stacks. `EPAM_SANDBOX_BASE_IMAGE` overrides the derivation entirely if set.
- **Env forwarding**: any host env var matching `*_API_KEY` or `EPAM_*` (excluding `EPAM_SANDBOX_*` itself, the wrapper's own control knobs) is forwarded into the container by name — no provider name hardcoded.
- Container hardening unchanged from the original design: non-root (`--user $(id -u):$(id -g)`), `--security-opt no-new-privileges`, `--cap-drop ALL`, CPU/memory limits (`EPAM_SANDBOX_CPUS` default 2, `EPAM_SANDBOX_MEMORY` default 4g), bridge networking (required for provider API calls), image auto-built on first run if `epam-cli-sandbox:latest` isn't already present.
- Rollout stance unchanged from the original design: strictly opt-in (`EPAM_SANDBOX=true`/`--sandbox`), not yet flipped to default-on in `tier3-travel-app-run.sh` — validated so far via direct container write-tests and the unit-test suite (`test/unit/orchestration/sandbox-isolation.test.ts`, 16 tests, real `docker`-stubbed execution), not yet against a full live tier3 run with the new mounts active.

### 3.3 Provider Wrappers & Utilities
- Wrapper scripts (`claude.sh`, `copilot.sh`, `openai.sh`, `cursor.sh`, etc.) normalize provider CLIs to the same contract expected by `run-agent-orchestration.sh`.
- Supporting utilities: `contextualize-stories.sh` (phase context packaging), `estimate-stories.sh`, `team-lead-review.sh`, `worktree-health-check.sh`, `update-monitor.sh`, and `provider-cutover.sh` for bulk reassignment.

### 3.6 Behavioral Contracts (GAP-P8 / GAP-P10)
- **Static constitution (GAP-P8):** `AGENT_CONSTITUTION` in `claude.sh` is a four-rule behavioral contract (filesystem boundary, AC verification, protected paths, credential safety) injected into every agent invocation via `--append-system-prompt` (CLI) and `--system-prompt` (SDK). Rules are non-negotiable and cannot be overridden by story prompts.
- **Dynamic augmentation (GAP-P10):** `resolve_dynamic_constitution()` reads `.epam/constitution-rules.json` at story invocation time and appends matching rules to the base contract. Each rule entry specifies `match.skills` (array of keywords matched against `technicalNotes.requiredSkills`) and/or `match.agentRole` (exact role match). Rules reset per story — no bleed between invocations. When the file is absent, behavior is identical to GAP-P8. Sample rule sets: auth/credentials, database migrations, QA role, API boundary validation.
- To add project-specific rules: create or edit `.epam/constitution-rules.json` in `PROJECT_ROOT`. See the sample at `.epam/constitution-rules.json` in this repo.

### 3.7 Brownfield Context Ingestion (GAP-P9)
- Activated when `brownfield.repoRoot` is set in the PRD. `contextualize-stories.sh` calls `orchestrations/scripts/lib/brownfield-context.js` at CPA time, injecting repo context alongside KB chunks into each story prompt.
- **Stage 1 — git context:** `brownfield-context.js` runs `git ls-files` on the target repo, chunks source files (25 lines), and scores chunks via TF-IDF against the story query. Source labels: `git:<relpath>`.
- **Stage 2 — external stubs / live Jira:** Reads `.epam/brownfield/jira.json` (stub Jira issues) and `.epam/brownfield/confluence.md` (architecture notes) from the target repo's `.epam/brownfield/` directory. When `JIRA_URL`, `JIRA_EMAIL`, and `JIRA_TOKEN` are all set, fetches live Jira issues via REST v3 (ADF→plaintext); falls back to stubs silently. Source labels: `stub:jira:<key>`, `jira:<key>`, `stub:confluence`.
- Greenfield behavior (no `brownfield` key in PRD) is completely unchanged.

### 3.8 External Event Triggers (GAP-P2)
- `control-plane.js` exposes `POST /webhook/jira` when `JIRA_WEBHOOK_SECRET` is set. Incoming payloads are HMAC-verified (`X-Hub-Signature-256`), adapted by `lib/jira-adapter.js` (Jira webhook → PRD story shape), and queued in `lib/webhook-queue.js`.
- **Debounced batching:** Events are grouped by `projectKey` with a 45-second window before flushing to a PRD file in `WEBHOOK_PRD_DIR`. Events labelled `urgent` bypass the window and flush immediately. The queue persists to `.epam/webhook-queue.json` across restarts.
- **Jira writeback (`jira-writeback.sh`):** Called at four pipeline milestones — spec pass (post elaborated ACs as comment), CPA complete (post cost/time estimate), story complete (transition to In Review + post PR link), review done (transition to Done or Reopened). No-ops when `JIRA_URL` is unset.
- Env vars: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_WEBHOOK_SECRET`, `WEBHOOK_PRD_DIR`.

### 3.4 Logging & Persistence
- `logs/agent-status.json` — real-time state for dashboards + automation (current phase, lane cursors, failovers, warnings).
- `logs/agent-messages.jsonl` — streaming transcripts for each story.
- `logs/phase-cost.jsonl` — append-only cost + token usage for **all** agent invocations: story implementation agents (`agent_type` absent) and pipeline agents (`agent_type`: `assessment`, `spec-coordinator`, `qa-gate:sast`, `qa-gate:spec-validator`, `qa-gate:review-ranger`, `qa-gate:mutant-hunter`, `qa-gate:fuzz-weaver`, `qa-gate:perf-sentinel`, `qa-gate:e2e`, `topology-router`, `spec-pass`). Prior to GAP-P22 only story costs were tracked.
- `logs/provider-failover.json` — sentinel for cross-process failover decisions consumed by agents and dashboards.
- `logs/story-artifacts.jsonl` — per-story structured output records emitted by `emit_story_artifact()` (GAP-P17). Contains `structuredOutput` field when story has `outputSchema`.

### 3.5 Specification Mode (OpenSpec/Speckit)
- `orchestrations/scripts/spec-mode-runner.js` powers the pre-pass: it snapshots `prd.json`, asks the coordinator agent which spec personas to launch, runs OpenSpec and/or Speckit per story (parallel subprocesses), merges acceptance criteria, and writes before/after fragments to `logs/spec-phase.jsonl`.
- Outputs: `logs/spec-baseline.json` (latest baseline), `logs/spec-summary.json` (run metadata), `logs/spec-runs/<run>/` (archives), and any new split stories inserted back into `prd.json` + `implementationOrder`.
- CLI entrypoints: `/orchestrate spec <phase>` (REPL) or `epam orchestrate spec <phase>` shell out to the same runner; `npm run specification:run -- --phase <phase>` is available for automation/CI.
- Operators can skip the pre-pass with `EPAM_SPEC_MODE=0` or run it standalone before estimates to review diffs in dashboards.
- **Split authority (2026-07-13):** openspec is the *sole* decision-maker for splitting an over-large story. Speckit's prompt used to grant it independent split judgment too, as a safety net for a missed mandatory split — but that safety net was redundant with the already-existing deterministic `checkSplitMandateViolation()` check (which forces *openspec* to retry a missed split), and the redundancy caused two competing, independently-generated child ID sets for the *same* parent story in one spec-pass turn (found live on SKY-002 and SKY-003) — same-file coherence correctly rejected both, and the story fell back to running unsplit and oversized. Fixed with a prompt change (speckit's schema now says `"splitStories": ALWAYS omit this field`) plus a deterministic code-level guard that unconditionally drops any `splitStories` speckit still emits, before `applySpecChanges` ever sees it.

### 3.15 Agent Profile Roster & Persona System
- `orchestrations/agents/profiles.json` — flat `{role: "prompt string"}` map, ~49 specialized personas covering implementation (`typescript-engineer`, `test-engineer`, `frontend-engineer`, `ui-engineer`, `generator`), specification (`openspec-agent`, `speckit-agent`, `spec-coordinator-agent`, `spec-validator`), QA gates (`sast-sentinel`, `review-ranger`, `mutant-hunter`, `fuzz-weaver`, `perf-sentinel`), documentation (`doc-coordinator`, `doc-reviewer`, `guide-author`, `changelog-agent`, `docstring-agent`), and project/PRD management (`prd-project-manager-agent`, `grooming-coordinator`, `readiness-checker`).
- `profiles.json.original` is the canonical floor — restored at the start of every tier-3 run so drift from a prior run's self-healing writes never persists across runs.
- App-specific profiles are generated dynamically per project from the manifest + PRD (`INIT-001`); `INIT-002` keeps every story's `agentRole` synced to an existing profile key.

### 3.16 Self-Healing Reviewer Gates & Retry-on-Violation Guards (2026-07-13)
Several pipeline agents have tool write access to `prd.json`/`profiles.json` — Step 0.5 (pre-phase skill
assessment), Step 0.9 (`prd-model-coordinator`), spec-pass AC/description rewrites (`spec-mode-runner.js`), and
the post-implementation TC writer. Each is instructed (in its own prompt) to only touch a narrow set of
fields, but a prompt instruction is not enforcement — every one of these has, live, written something outside
its stated scope. Each is gated by a **deterministic** check (a field-allowlist diff, not an LLM judgment call
where one is mechanically possible) rather than trusting the agent's own summary of what it did:

- **Step 0.5** — `PFA_PRD_DIFF_PY` diffs the PRD's per-story fields (only `agentRole`/`model`/`aiProvider`/
  `reasoningEffort` may change) alongside a content reviewer for new/changed `profiles.json` entries.
- **Step 0.9** — `MC_REVIEW_PY` diffs the full PRD by story ID, allowing only `model`/`aiProvider`/
  `reasoningEffort` to change; any added/removed story or `implementationOrder` edit is a violation.
- **Spec-pass AC write** — `reviewPrdChange` (an LLM content reviewer, since AC quality is a judgment call, not
  a mechanical diff) validates every AC/description/title/split rewrite.
- **TC writer** — a post-condition check re-reads `testCriteria.facts` for the target story rather than
  trusting the writer script's exit code alone (exit 0 can legitimately mean "no-op," not "wrote real facts").

**Retry-on-violation (2026-07-13):** each of these now gets up to **3 attempts** before falling back to its
old behavior. On a violation, a corrective note naming the *specific* thing that was wrong is fed into the
next attempt — the same shape `checkSplitMandateViolation` already used for one violation class (a skipped
mandatory split), generalized to the other three. Outcomes:
- **Step 0.5 / Step 0.9** — exhaustion reverts both `profiles.json` and the PRD's per-story fields to the
  pre-attempt snapshot (unchanged fallback, just reached after real retries instead of immediately).
- **AC-review** — exhaustion reverts the story to its pre-call snapshot (unchanged), with an independent
  attempt budget from the split-mandate retry — a story that trips both violation classes in the same turn
  gets attempts from each, not one shared counter.
- **TC writer** — this was the most severe failure mode of the four: a miss used to hard-abort the *entire
  pipeline* over one story. On exhaustion it now marks just that story `status="blocked"` — skipped by Step
  1's live-status re-check (the same mechanism that already skips `"deprecated"` stories) — instead of
  running ungrounded or taking every other story in the phase down with it. A genuine PRD-corruption crash
  (not just an empty-facts miss) still hard-fails.

Every guarded call's final outcome (`pass`/`reverted`/`blocked`, attempt count, reason, and a fixed-vocabulary
`violationTypes` array — e.g. `field_out_of_scope`, `story_added`, `invalid_json`, `content_quality`,
`empty_facts`, depending on the step) is logged to `guarded-step-retries.jsonl` in the project's output
directory; blocked stories are additionally recorded to `blocked-stories.jsonl`. See §4.2 for the dashboard
that surfaces this data.

**Cross-run history (2026-07-13):** the per-run file above lives in the project's own output directory, which
teardown `rm -rf`s before every fresh launch — so on its own it can never show whether a prompt's violation
rate is improving or regressing over time. Every guarded-step write is now a **double-write**: unchanged
append to the per-run file, plus an append (via the shared `_log_guarded_step_retry()` bash helper and its
`logGuardedStepRetry()` JS counterpart in `spec-mode-runner.js`) to a persistent, engine-side history file —
`orchestrations/logs/guarded-step-retries-history.jsonl`, repo-relative to epam-cli, never inside the target
project's output directory — that survives teardown. Each record is tagged with `runId` and `promptVersion`
(the epam-cli repo's own short git SHA at call time, since these prompts live embedded in the scripts
themselves rather than separate templates — the commit hash of the script *is* the version proxy).
`build/snapshot.js`'s `summarizeGuardedStepHistory()` groups the history by `(runId, step)`, newest-first,
capped to the most recent 20 runs, plus a `violationTypesByStep` roll-up — rendered as two additional plain
tables in `health.html`'s Prompt Evals section (see §4.2).

### 3.16.1 Retry-Extension Coordinator (Dynamic Self-Heal Budget)
A story that exhausts `MAX_RETRIES` with genuine, converging progress (each failed attempt a *different*
diagnosed bug, not a repeat) shouldn't necessarily be abandoned at a fixed, one-size-fits-all ceiling.
`compute_retry_extension_evidence()` (`claude.sh`) first computes deterministic, zero-LLM-cost evidence from
two existing JSONL logs — `healing-events.jsonl` (distinct diagnoses, whether healing itself broke) and
`failure-diagnosis-groundedness.jsonl` (average groundedness score) — and only consults an LLM gate when that
evidence is genuinely ambiguous, mirroring this pipeline's "trust the deterministic oracle over an LLM
opinion" principle used elsewhere (e.g. SAST/spec-validator's blocker-count-over-self-reported-verdict trust).
`run_retry_extension_coordinator()` prints the number of extra retries granted (0 if declining) and fails
closed on any error, disabled state, or malformed gate response.

**Bug fixed 2026-07-13 (found live on SKY-003):** the caller captures this function's return value via command
substitution (`_granted_extra_retries=$(run_retry_extension_coordinator "$story_id")`), which captures
*everything* the function writes to stdout — including its own internal diagnostic `log "..."` calls, since
`log()`'s real definition (unlike `error()`) writes to stdout with no `>&2` redirect. A genuinely granted
extension (`extraRetriesGranted:2`, correctly recorded to `retry-extension-decisions.jsonl`) was silently
corrupted into a multi-line, non-numeric capture, so the caller's `-gt 0` numeric check failed and the story
was abandoned anyway with zero further retries. Fixed by redirecting both internal `log` calls to stderr, so
the function's stdout contains only the final numeric `echo`. The pre-existing test suite's stub for
`log()`/`warning()` used a safe, stderr-only definition that never exercised this — a new test
(`retry-extension-log-contamination.test.ts`) reproduces the exact integration bug using the *real*
stdout-writing `log()` definition extracted from `claude.sh`.

### 3.17 Rung-Based Inference Ladder
`claude.sh`'s retry loop escalates in four rungs (two attempts each, `EPAM_MAX_RETRIES` default 7 → 8 total attempts): Rung 0/1 keep the base model and raise `EPAM_REASONING_EFFORT` from low → medium; Rung 2 escalates the model itself; Rung 3 keeps the escalated model at `EPAM_REASONING_EFFORT=high`. A failed self-heal attempt can skip straight to the next rung instead of burning a second attempt on a healing strategy already known to be broken.

The model-escalation lookup is **tier-aware**: `classify_ladder_tier()` picks between two configurable, pipe-separated `from=to` tables — `EPAM_MODEL_LADDER_MEDIUM` (e.g. `MiniMax-M3=z-ai/glm-5.2`) for ordinary stories, and `EPAM_MODEL_LADDER_HIGH` (e.g. `MiniMax-M3=z-ai/glm-5.1`) for stories the classifier flags as needing a stronger ceiling. Each table is a set of direct current→next mappings rather than one fixed chain — most base models jump straight to their tier's ceiling model in a single hop, plus one bridge entry lets a story already at the medium ceiling escalate one further step to the high ceiling if it's reclassified high-tier mid-run. Setting `EPAM_MODEL_LADDER` (no suffix) explicitly overrides both tiers to the same table, for projects that don't need tier-based differentiation. `EPAM_FINAL_FALLBACK_MODEL`/`_PROVIDER` guarantee Rung 3 always has an escalated model even if the tier's ladder lookup produced nothing.

### 3.18 tsc Verification Inside the Retry Loop
`run_tsc_verification()` runs `tsc --noEmit` as part of the same `invoke_success` gate chain as external test verification — *inside* the retry loop, not after it. A TypeScript compile failure sets the same `VERIFICATION_FAILURE` channel the failure analyst and retry prompt already consume, so a tsc error gets full InferenceLadder treatment (model/effort escalation) before the story is marked failed, instead of exiting the phase on the very first compile error with zero retries.

### 3.19 Testing Gates & Self-Healing Remediation
After a phase's stories are implemented, `run_testing_gates()` in `run-agent-orchestration.sh` runs a fixed sequence of quality-check agents in three dependency-ordered phases — Phase B only runs if Phase A passed, Phase C only if A and B passed:

- **Phase A (4.2):** `sast-sentinel` (security/compilation, driven by pre-injected `tsc`/`npm audit` evidence) and `spec-validator` (classifies each acceptance criterion as met/partial/unmet/untestable).
- **Phase B (4.3):** `review-ranger` (code review) and `mutant-hunter` (whether tests would actually catch introduced bugs).
- **Phase C (4.4):** `fuzz-weaver` (edge-case/vulnerability analysis) and `perf-sentinel` (algorithmic complexity/perf hotspots).
- **4.6:** browser E2E routing — UI stories are routed to `playwright-agent` (high-complexity flows) or `lightpanda-agent` (fast, deterministic checks) by a computed complexity score.

Several gates apply a **grounding check** before treating a "fail" verdict as blocking: `fuzz-weaver`'s vulnerability claims must include an `executableTest` that is actually run against the real code (a claim only counts as confirmed if the test genuinely fails); `spec-validator`'s per-story fail only counts if at least one of that story's criteria has a status other than `untestable`. Both exist to prevent an ungrounded "the agent said fail with no real evidence" verdict from aborting a phase.

On a gate failure, a 3-agent remediation pipeline attempts to fix forward rather than aborting outright: `gate-finding-analyst` extracts a grounded `{story_id, file, rule, ...}` finding from the gate log (falling back to a git-history lookup — the file's most recent `"story: complete <id>"` commit — when the LLM can't ground it to a story itself); `story-ac-remediator` augments that story's acceptance criteria with a concrete fix requirement; `profile-augmentor` appends a preventive rule to the relevant agent's profile if the anti-pattern is novel. A successful remediation signals the caller to reset and retry the phase.

Each main-branch story attempt also runs inside a **scope guard** (files outside the story's declared scope, and files owned by other stories, are made read-only for the duration of the attempt) and a **vendor guard** (configured vendor directories, e.g. `node_modules`, are locked read-only during the attempt and separately checked for tampering via mtime).

---

## 4. Dashboards & Real-Time Updates

### 4.1 Eleventy Build Pipeline
- `package.json` exposes `npm run dashboards:build|watch|serve`, all pointing to `orchestrations/dashboards/.eleventy.js`.
- The config copies 11 dashboard HTML templates (including the specification dashboard), runtime assets, PRD data, profiles, and pruned log trees into `orchestrations/dashboards/live/`. Only JSON/JSONL inputs required by the dashboards are watched to avoid noisy rebuilds.
- `orchestrations/dashboards/build/snapshot.js` digests PRD + logs into normalized metrics (`build-info.json`), including hashes, phase summaries, and recent events.

### 4.1.1 Provider & Model Filters (EPAM-027)
- `monitor.html` and `prd-viewer.html` now include Provider and Model filter dropdowns. Selecting a provider (Claude, OpenCode, Codex) or model tier (Haiku, Sonnet, Opus) filters the story lane view to matching stories in real time.
- `sync-monitor-stories.sh` and `update-monitor.sh` emit `aiProvider` and `resolvedModel` fields into `agent-status.json` to power the filters.

### 4.2 Runtime Overlay & Health Signal
- `orchestrations/dashboards/runtime/build-info.js` runs in every dashboard, polling `build-info.json`, rendering a global status pill, and firing `window.EPAMBuildInfo` events for page-specific scripts.
- Dashboards consume the shared overlay by importing the runtime script (see `monitor.html`, etc.), so all pages surface stale/offline states consistently.
- **`health.html`** shows the pipeline's self-healing signals: `build/snapshot.js` tails `healing-events.jsonl` (analyst diagnose-and-patch cycles, skill-note growth per agent role, dynamic tools synthesized) into `metrics.selfHealing`, and — since 2026-07-13 — `guarded-step-retries.jsonl` + `blocked-stories.jsonl` (see §3.16) into `metrics.promptEvals`: total guarded calls, the % that actually hit a violation on attempt 1, pass/reverted/blocked counts overall and per gate, and the blocked-stories list. Both feeds come from the same `build-info.json` snapshot, no separate polling.
- **Cross-run trend:** `snapshot.js` also tails the persistent `orchestrations/logs/guarded-step-retries-history.jsonl` (see §3.16) via `summarizeGuardedStepHistory()`, added to `metrics.promptEvals.history` — a `rows` array (one row per `runId` + step, newest-first, capped to the last 20 runs) and a `violationTypesByStep` roll-up. `health.html` renders both as two additional plain tables under the existing Prompt Evals metrics, making it possible to see whether a specific prompt (identified by `promptVersion`, the epam-cli git SHA at call time) is trending toward fewer violations release over release.

### 4.3 Coupling with Orchestration Runs
- `run-agent-orchestration.sh` automatically launches the Eleventy watcher, ensuring BrowserSync reloads dashboards whenever PRD/logs change during a phase run.
- Generated assets (`live/`) are excluded from git via `.gitignore` but deployed to the demo workspace (`scripts/deploy-demo.sh`) for validation.

### 4.5 Scorecard Dashboard (GAP-P15)
- `scorecard.html` aggregates `phase-cost.jsonl`, `testing-gates.jsonl`, and `cpa-review.jsonl` into a cross-run scorecard — no new instrumentation required, all data was already emitted.
- Metrics per run: story pass rate (completed/attempted), gate pass rate (QA gate verdicts), first-attempt success rate, avg cost/story, avg time/story, CPA accuracy (actual vs estimated minutes).
- Historical runs table (one row per phase+date, sortable), plus a story-level detail table for the most recent run with per-story cost/time/turns/CPA variance badges.

### 4.6 SWE-bench Evaluation Dashboard (GAP-P3)
- `swe-bench.html` displays results from `scripts/run-swe-bench.sh` against the **EPAM TypeScript Benchmark** — 5 curated bug-fix tasks covering logic, data structures, async, and correctness categories.
- Score gauge shows resolved rate; KPI strip shows resolved/partial/failed counts, total cost, and avg time/task. Run history table supports multi-run comparison.
- Results are aggregated by `.eleventy.js` `syncBenchResults()` from `benchmarks/results/*.json` into `swe-bench-results.json` on every build.
- First run: **5/5 resolved (100%)** at $0.40 total, avg 129 s/task, using Haiku.
- Run the harness: `bash scripts/run-swe-bench.sh` (add `--sandbox` for containerized execution, `--task ID` for single task).

### 4.4 Specification Dashboard
- `specification.html` compares the latest spec baseline (`logs/spec-baseline.json`) against the current `prd.json`, highlights acceptance-criteria deltas per story, and surfaces the OpenSpec/Speckit ledger emitted by `logs/spec-phase.jsonl`.
- The page relies on `logs/spec-summary.json` for coverage metrics and uses the shared runtime overlay to flag stale data; selecting a story shows before/after criteria and any split stories created by the spec pass.

---

## 5. Deployment & Environment Management

### 5.1 Building the CLI
- `npm run build` (tsup) produces two artifacts: `dist/epam.js` (CLI executable with shebang) and `dist/sdk.js` + `dist/sdk.d.ts` (importable library surface).
- `npm run dev` launches the CLI via `tsx` for local iteration. Quality scripts: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run dashboards:build`.
- The SDK surface (`src/sdk.ts`) exports `AgentRunner`, `ProviderChain`, `ToolRegistry`, `createTools`, `ToolPlugin`, `PluginLoader`, and all built-in tools under the `epam-cli/sdk` import path. Package `exports` map routes `./sdk` and `./plugin` to the library build. See `TOOL_REGISTRY.md` for plugin authoring docs.

### 5.2 Demo Deployment Flow
1. Run `scripts/deploy-demo.sh`.
2. Script rebuilds the CLI (`npm run build`), copies `dist/epam.js` + sourcemap into `/home/bjerome/projects/ai/epam-cli-demo/dist`, syncs `orchestrations/dashboards/live`, copies Markdown references, and verifies with `node dist/epam.js --version`.
3. Demo workspace already contains the Eleventy outputs so orchestrations/tests can run against the mirrored assets immediately.

### 5.4 Quick-start & Keyless Demo (GAP-P18)
- `QUICKSTART.md` documents the 3-step live demo: clone → set `EPAM_API_KEY_ANTHROPIC` + `RAPIDAPI_KEY` → run `bash orchestrations/scripts/run-travel-app-test.sh`.
- `demo/logs/` contains a snapshot of a completed Skyscanner orchestration run. `scripts/demo-mode.sh on` symlinks `orchestrations/logs → demo/logs` so all dashboards render a full run without executing anything. Restore with `scripts/demo-mode.sh off`.
- The travel-app PRD includes `SKY-001b` (API discovery story) as a scaffold-phase prerequisite for `SKY-002`. On a clean rebuild, `SKY-001b` probes the live RapidAPI endpoint and writes `docs/api-contract.md` so `SKY-002` implements the client against verified paths rather than assumed ones.

### 5.3 Environment Variables & Secrets
- Core CLI: `EPAM_BACKEND_URL`, `EPAM_PROVIDER`, `EPAM_MODEL`, `EPAM_MAX_ITERATIONS`, `EPAM_BUDGET_WARNING_AT`, `EPAM_BUDGET_HARD_LIMIT_AT`.
- Provider keys: `EPAM_API_KEY_ANTHROPIC`, `EPAM_API_KEY_OPENAI`, `EPAM_API_KEY_GEMINI`, etc.
- Orchestration/dashboards: `CLAUDE_CMD`, `EPAM_ORCHESTRATION_PROVIDER`, `EPAM_DASH_AUTO_SERVE`, `EPAM_DASH_PORT`, `EPAM_REDIS_URL`.
- Story timeout: `STORY_TIMEOUT_SECS` (flat override), `EPAM_PAUSE_ON_TIMEOUT` (default `false` — skip on double timeout, never hang), `EPAM_MAX_PAUSE_SECS` (default 300s auto-resume ceiling). Effort-based defaults: `low=600s`, `medium=1200s`, `high=2400s`.
- Specification: `EPAM_SPEC_MODE` (default `1`) toggles the spec pre-pass globally; set `EPAM_SPEC_MODE=0` to skip OpenSpec/Speckit when replaying historical runs.
- Brownfield ingestion: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` — when all three are set, `brownfield-context.js` fetches live Jira issues; absent means stub files used.
- Webhook triggers: `JIRA_WEBHOOK_SECRET` — enables `POST /webhook/jira` on the control plane; `WEBHOOK_PRD_DIR` — output directory for flushed webhook PRD files.
- MCP: `enabled` field on each server entry in `.mcp.json` (default `true`) — set `false` to disable a server without removing its config. Default `.mcp.json` ships with example servers disabled.

---

## 6. Operations & Troubleshooting

### 6.1 Failover & Token Guardrails
- Consult `plans/orchestration-failover-plan.md` for the full design: story-level provider tuples, token quota forecasts, guarded execution retries, shared ledgers, and reporting hooks.
- CLI runtime already shares conversation state between providers; orchestration processes persist ledger decisions to `logs/agent-status.json` and `phase-cost.jsonl` for auditing.

### 6.2 Session Recovery & Sharing
- Use `/resume` to reload JSONL sessions, `/share` or `/handoff` to push bundles into Redis, and `/import` (or `epam import <code>`) to hydrate sessions on another machine or process.
- When building cross-process failover, reuse `storeSession()` and `EPAM_AUTO_RESUME` env plumbing so the backup agent imports and resumes automatically.

### 6.3 Monitoring Health
- `orchestrations/scripts/dashboard-health-check.sh` exercises the Eleventy watcher + BrowserSync endpoint.
- `orchestrations/scripts/check-phase-gate.sh` and `worktree-health-check.sh` validate prerequisites before launching a full phase.
- Logs live under `orchestrations/logs/` and roll between runs; tail them directly when diagnosing stuck lanes.

### 6.4 Automation Hooks
- `update-monitor.sh` pushes real-time status to dashboards/alerting.
- `provider-cutover.sh` enforces the policy for moving remaining stories to backup providers/models.
- `sync-monitor-stories.sh` keeps dashboards in sync with PRD deltas.

---

## 7. Quick Reference

### CLI Commands
- `epam chat` — interactive REPL with failover-enabled provider chain.
- `epam run <prompt>` — one-shot agent run (stdin supported).
- `epam estimate|orchestrate|phase ...` — wrappers around orchestration scripts.
- `epam orchestrate spec <phase>` — coordinator → OpenSpec/Speckit specification pass (also `/orchestrate spec` in the REPL).
- `epam provider list/login/logout/status` — auth for Anthropic/OpenAI/Gemini/Copilot/Codex/etc.
- `epam import <code>` — restore Redis/shared sessions into local storage.
- `epam health-check-claude` — verify Claude CLI binary is reachable and returns a valid response (EPAM-HC-001).
- `epam health-check-proxy` — verify the EPAM proxy backend (`EPAM_BACKEND_URL`) is reachable and healthy (EPAM-HC-004).

### Orchestration Scripts
- `orchestrations/scripts/run-agent-orchestration.sh` — master orchestrator (`--sandbox`, `--allow-network` flags added).
- `orchestrations/scripts/claude.sh` — story agent invocation wrapper; handles constitutions, schemas, artifacts.
- `orchestrations/scripts/spec-mode-runner.js` — specification coordinator (baseline snapshot + OpenSpec/Speckit execution).
- `.../provider-cutover.sh` — enforce backup provider plan.
- `.../update-monitor.sh` — refresh dashboards + logs.
- `.../team-lead-review.sh`, `.../code-review-cycle.sh` — specialized review loops.
- `.../lib/topology-router.js` — Haiku tool-call topology selector (single/parallel/sequential).
- `.../lib/sandbox-invoke.sh` — Docker CLAUDE_CMD replacement for sandboxed execution.
- `.../Dockerfile.sandbox` — container image for sandbox (node:20-slim + Claude CLI).
- `.../lib/brownfield-context.js` — brownfield repo + stub/live Jira context retrieval for CPA.
- `.../lib/webhook-queue.js` — debounced Jira webhook event batching.
- `.../lib/jira-adapter.js` — Jira webhook payload → PRD story shape normalizer.
- `.../lib/jira-client.js` — Jira REST API client (get issue, add comment, transition, update field).
- `.../jira-writeback.sh` — posts milestone updates (spec, CPA, story-complete, review-done) back to Jira.
- `scripts/deploy-demo.sh` — sync build + dashboards to demo workspace.
- `scripts/run-swe-bench.sh` — EPAM TypeScript Benchmark harness (5 tasks, isolated workspace per task, scored resolved/partial/failed).
- `scripts/demo-mode.sh` — toggle dashboards between live logs and canned demo snapshot.

### Dashboards Ops
- `npm run dashboards:build` — one-off build into `orchestrations/dashboards/live`.
- `npm run dashboards:serve` — Eleventy + BrowserSync auto-refresh.
- Watcher auto-started by `run-agent-orchestration.sh` (disable via `EPAM_DASH_AUTO_SERVE=0`).

---

## 8. Extending the Platform

1. **Adding a Command** — create a `src/cli/commands/<name>.ts`, export a factory that builds a Commander command, and register it in `src/cli/index.ts`.
2. **Adding a Provider** — implement `LLMProvider` in `src/providers/<provider>/<Provider>.ts`, update `ProviderChain` slot creation, and supply wrapper scripts for orchestration if the provider requires a separate CLI.
3. **Adding Tools / External Plugins** — for built-ins, follow patterns in `src/tools/builtin`. For external plugins, create an npm package implementing `ToolPlugin` (see `TOOL_REGISTRY.md`), name it `epam-tool-*`, and list it in `.epam/settings.json` `tools` array. `createTools()` loads all listed plugins at startup.
4. **Expanding Dashboards** — create a template in `orchestrations/dashboards/`, wire data via Eleventy data files or the shared snapshot, and import `runtime/build-info.js` for consistent status UX.
5. **Updating Plans** — store operational plans (like failover) under `plans/` so engineers can diff/iterate outside of PRD scripts.
6. **Adding constitution rules** — add entries to `.epam/constitution-rules.json` with `match.skills` (keyword array) and/or `match.agentRole` (exact string) plus a `rules` array of constraint strings. Rules are injected only for stories whose metadata matches; all others are unaffected.
7. **Adding brownfield context** — set `brownfield.repoRoot` in the PRD and optionally seed `.epam/brownfield/jira.json` and `.epam/brownfield/confluence.md` in the target repo. Set `JIRA_*` env vars for live ingestion; absent vars fall back to stubs silently.
8. **Adding structured outputs to a story** — add `"outputSchema": { ... }` (JSON Schema) to the story in the PRD. The agent will produce a conforming JSON object at the end of its response; the result is captured in `logs/story-artifacts.jsonl`.
9. **Adding benchmark tasks** — create a directory under `benchmarks/tasks/<id>/` with `task.json` (metadata, `fail_to_pass` test names), `src/*.ts` (buggy source), and `src/*.test.ts` (vitest tests). `run-swe-bench.sh` picks them up automatically.
10. **Using EPAM CLI as a library** — `import { AgentRunner, ProviderChain, createTools } from 'epam-cli/sdk'` after installing the package. See `src/sdk.ts` for the full stable surface.

---

## 9. Useful Paths

- CLI entrypoint: `src/index.ts`
- Command registry: `src/cli/index.ts`
- REPL runtime: `src/cli/repl/Repl.ts`, `src/cli/repl/RawInputBox.ts`
- Agent loop: `src/agent/AgentRunner.ts`, `src/agent/Executor.ts`
- Memory loader: `src/memory/MemoryLoader.ts`, `src/memory/MemoryImportResolver.ts`
- Health checks: `src/cli/commands/health-check-claude.ts`, `src/cli/commands/health-check-proxy.ts`
- Providers: `src/providers/ProviderChain.ts`, `src/providers/*`
- Tools (built-in): `src/tools/builtin/*.ts`
- Tool plugin interface: `src/tools/plugin.ts`, `src/tools/PluginLoader.ts`, `src/tools/createTools.ts`
- Tool registry docs: `TOOL_REGISTRY.md`
- SDK library surface: `src/sdk.ts`
- Session stores: `src/context/SessionStore.ts`, `src/context/RedisSessionStore.ts`
- Orchestration script: `orchestrations/scripts/run-agent-orchestration.sh`
- Agent invocation / constitution: `orchestrations/scripts/claude.sh`
- Constitution rules: `.epam/constitution-rules.json`
- Brownfield context: `orchestrations/scripts/lib/brownfield-context.js`
- Webhook queue: `orchestrations/scripts/lib/webhook-queue.js`
- Jira adapter/client: `orchestrations/scripts/lib/jira-adapter.js`, `orchestrations/scripts/lib/jira-client.js`
- Jira writeback: `orchestrations/scripts/jira-writeback.sh`
- Dashboards config: `orchestrations/dashboards/.eleventy.js`
- Snapshot builder: `orchestrations/dashboards/build/snapshot.js`
- Runtime overlay: `orchestrations/dashboards/runtime/build-info.js`
- Specification runner: `orchestrations/scripts/spec-mode-runner.js`
- Specification dashboard: `orchestrations/dashboards/specification.html`
- Health / self-healing dashboard: `orchestrations/dashboards/health.html`
- Guarded-step retry log: `guarded-step-retries.jsonl` (project output dir, per-run)
- Guarded-step retry history: `orchestrations/logs/guarded-step-retries-history.jsonl` (engine-side, persistent across runs)
- Blocked-stories log: `blocked-stories.jsonl` (project output dir)
- Deployment script: `scripts/deploy-demo.sh`
- Operational plan: `plans/orchestration-failover-plan.md`
- Auth research: `.epam/provider-auth-research.md`
- Decisions log: `.epam/decisions.jsonl`
- Topology router: `orchestrations/scripts/lib/topology-router.js`
- Sandbox wrapper: `orchestrations/scripts/lib/sandbox-invoke.sh`
- Sandbox image: `orchestrations/scripts/Dockerfile.sandbox`
- Benchmark harness: `scripts/run-swe-bench.sh`
- Benchmark tasks: `benchmarks/tasks/`
- Benchmark results: `benchmarks/results/`
- SWE-bench dashboard: `orchestrations/dashboards/swe-bench.html`
- Scorecard dashboard: `orchestrations/dashboards/scorecard.html`
- Demo log snapshot: `demo/logs/`
- Demo mode toggle: `scripts/demo-mode.sh`
- Quick-start guide: `QUICKSTART.md`

---

For questions or changes, update this guide alongside the relevant code to keep architecture and implementation in sync.
