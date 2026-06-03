# EPAM CLI Technical Guide

_Last updated: June 3, 2026_

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

### 3.2 run-agent-orchestration.sh Flow
1. **Bootstrap** — resolves directories, PRD path, provider wrapper (`claude.sh`, `copilot.sh`, `codemie-claude.sh`, etc.), ensures logs exist, and installs traps for cleanup.
2. **Dashboards Watcher** — unless `EPAM_DASH_AUTO_SERVE=0`, starts `npm run dashboards:serve` in the background, writes its PID to `orchestrations/logs/dashboards-watch.pid`, and streams logs to `dashboards-watch.log` so BrowserSync remains live.
3. **Specification Pre-pass** — `spec-mode-runner.js` snapshots `prd.json` into `logs/spec-runs/<run>/prd.before.json` (also copied to `logs/spec-baseline.json`), invokes the coordinator agent to assign OpenSpec/Speckit per story, runs those spec agents (in parallel), applies acceptance-criteria edits or story splits, and logs every delta to `logs/spec-phase.jsonl` + `logs/spec-summary.json`. Toggle with `EPAM_SPEC_MODE=0` when you need to skip the step.
4. **Phase/Mode Resolution** — loads `phasesConfig` from `prd.json` to decide orchestration mode (`bash` vs `hybrid`), story subsets, and approval requirements.
5. **CPA & Execution Plan** — runs Context/Plan Analyzer scripts to expand story templates, compute budgets, and write the plan JSON (leveraging jq + helper scripts under `orchestrations/scripts/lib`).
6. **Token Forecast + Failover Ledger** — reads `logs/phase-cost.jsonl`, builds provider/model budgets per plan, and precomputes fallback tuples per story (as described in the failover plan).
7. **Worktree Preparation** — clones fresh git worktrees for each lane (`claude.sh --create-worktree`), seeds environment variables, and writes lane manifests.
8. **Parallel Execution** — launches primary and independent agents (plus optional reviewers) via `CLAUDE_SH` wrapper calls. Each invocation pipes transcripts to `logs/agent-messages.jsonl` and cost data to `phase-cost.jsonl`.
9. **Monitoring & Cutover** — `update-monitor.sh` refreshes `agent-status.json`; when token ceilings are crossed, `provider-cutover.sh --apply` reassigns remaining stories to backup providers while logging the event for dashboards.
10. **Reviews & Cleanup** — reviewer/QA agents validate outputs; on exit the script tears down worktrees unless `--skip-cleanup` is provided and stops the dashboards watcher.

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
- `run-agent-orchestration.sh --sandbox` wraps each agent invocation in a Docker/Podman container. The container is built from `orchestrations/scripts/Dockerfile.sandbox` (node:20-slim + Claude CLI + git/jq/curl, non-root user uid 10000, matching host uid at runtime via `--user $(id -u):$(id -g)`).
- `orchestrations/scripts/lib/sandbox-invoke.sh` is the `CLAUDE_CMD` replacement injected when `--sandbox` is active. It calls `docker run --rm -i` with: only `PROJECT_ROOT` bind-mounted r/w, `--security-opt no-new-privileges`, `--cap-drop ALL`, CPU and memory limits (default: 2 CPUs, 4 GB).
- The sandbox image is auto-built on first `--sandbox` run if not present. Network access is bridge (required for Anthropic API calls).
- Verified: writes to `PROJECT_ROOT` succeed; writes outside (e.g. `/etc/shadow`) are blocked by container isolation.
- Configurable: `EPAM_SANDBOX_IMAGE`, `EPAM_SANDBOX_CPUS`, `EPAM_SANDBOX_MEMORY`.

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
- `logs/phase-cost.jsonl` — append-only cost + token usage per provider/model/story (consumed by token guards and dashboards).
- `logs/provider-failover.json` — sentinel for cross-process failover decisions consumed by agents and dashboards.

### 3.5 Specification Mode (OpenSpec/Speckit)
- `orchestrations/scripts/spec-mode-runner.js` powers the pre-pass: it snapshots `prd.json`, asks the coordinator agent which spec personas to launch, runs OpenSpec and/or Speckit per story (parallel subprocesses), merges acceptance criteria, and writes before/after fragments to `logs/spec-phase.jsonl`.
- Outputs: `logs/spec-baseline.json` (latest baseline), `logs/spec-summary.json` (run metadata), `logs/spec-runs/<run>/` (archives), and any new split stories inserted back into `prd.json` + `implementationOrder`.
- CLI entrypoints: `/orchestrate spec <phase>` (REPL) or `epam orchestrate spec <phase>` shell out to the same runner; `npm run specification:run -- --phase <phase>` is available for automation/CI.
- Operators can skip the pre-pass with `EPAM_SPEC_MODE=0` or run it standalone before estimates to review diffs in dashboards.

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
