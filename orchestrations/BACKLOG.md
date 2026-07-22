# epam-cli Development Backlog

Tracks direct development work on the epam-cli base project.
This is not a PRD — the orchestration engine is not used to build epam-cli itself.
Source: competitive gap analysis (`dark-factory-gap-analysis.md`).

---

## Status Key
`pending` · `in-progress` · `done` · `deferred`

---

## Priority Queue

| # | ID | Title | Status | Source |
|---|---|---|---|---|
| 1 | GAP-P5 | Intra-story planner/executor model split | done | Aider, CrewAI |
| 2 | GAP-P4 | Semantic RAG — replace TF-IDF in CPA | done | CrewAI, OpenHands |
| 3 | GAP-P6 | OpenTelemetry emission alongside Langfuse | done | MAF, OAI Agents SDK |
| 4 | GAP-P7 | SwarmRouter-style topology selection | done | kyegomez/swarms |
| 5 | GAP-P8 | Constitution injection at agent invocation | done | swarm-forge |
| 6 | GAP-P9 | Brownfield support — existing system context ingestion | done | codemie, smolagents |
| 7 | GAP-P2 | External event triggers (webhook/Jira/Slack) | done | OpenHands, Cline |
| 8 | GAP-P10 | Dynamic constitution augmentation | done | Constitutional AI |
| 9 | GAP-P11 | LLM-based topology routing | done | kyegomez/swarms |
| 10 | GAP-P15 | Cross-run scorecard dashboard | done | SWE-bench, OpenHands |
| 11 | GAP-P18 | One-command demo (travel app + working API) | done | All competitors |
| 12 | GAP-P14 | Sandboxing / security isolation for tool execution | done | OpenHands, SWE-agent |
| 13 | GAP-P16 | First-class plugin/tool marketplace | done | LangGraph, AutoGen |
| 14 | GAP-P17 | Model-specific optimizations + structured outputs | done | LangGraph, AutoGen |
| 15 | GAP-P13 | Durable, distributed orchestration semantics | done | Temporal, Prefect |
| 16 | GAP-P12 | Library/framework ecosystem & composability | done | LangGraph, AutoGen, CrewAI |
| 17 | GAP-P22 | Full pipeline cost tracking (spec, CPA, gates, assessments) | pending | Cost observability |
| 18 | GAP-P19 | Secrets redaction in logs and artifacts | pending | Enterprise security |
| 18 | GAP-P20 | Deterministic replay and version pinning | pending | Temporal, Dagster |
| 19 | GAP-P21 | Multi-repo / monorepo and enterprise GitOps | pending | Enterprise GitOps |
| 20 | GAP-P1 | Docker sandbox execution | deferred | OpenHands, SWE-agent |
| 21 | GAP-P3 | SWE-bench benchmark harness | done | SWE-agent |

---

## GAP-P5 — Intra-story planner/executor model split

**Status:** done  
**Priority:** 1  
**Effort:** low (1-2 stories equivalent)

### Problem
Every agent turn within a story uses the same model. Planning turns (understand the problem, produce a structured approach) are expensive on a fast/cheap model but would benefit from a reasoning-grade model. Execution turns (write the file, run the command) don't need reasoning depth and waste cost on an expensive model.

### Approach
Add a `plannerModel` field to story specs in any PRD. When set, `claude.sh` uses the planner model for the first N turns (planning phase), then switches to the story's assigned model for execution turns. When not set, behaviour is unchanged.

### Files to change
- `orchestrations/scripts/claude.sh` — invoke logic to detect plannerModel, switch after planning turns
- `orchestrations/scripts/contextualize-stories.sh` — CPA dual-model cost estimation when plannerModel is set
- `orchestrations/scripts/ai-run.sh` — forward plannerModel field if present

### Acceptance criteria
- Story spec accepts optional `plannerModel` field alongside existing `model`/`effort` fields
- When `plannerModel` is set, first turn uses plannerModel; subsequent turns use story model
- When `plannerModel` is absent, behaviour is identical to current
- CPA estimates account for dual-model cost split when plannerModel is set
- phase-cost.jsonl records both models used when split occurs

---

## GAP-P4 — Semantic RAG — replace TF-IDF in CPA

**Status:** done  
**Priority:** 2  
**Effort:** medium (spike first, then 2-3 stories)

### Problem
EPAM-019 RAG Asset Discovery uses TF-IDF keyword matching against a static `.epam/assets.json`. Keyword matching fails on synonyms, paraphrasing, and domain concepts. CPA citation coverage is low (typically 3/5 chunks cited). Semantic retrieval would surface more relevant context per story, improving estimation accuracy.

### Approach
Spike first: evaluate sqlite-vec, LanceDB, and Chroma for WSL2 compatibility, zero-server-required operation, and TypeScript/Python interop. Pick the lightest-weight option. Replace the TF-IDF pass in the CPA pre-pass with vector similarity search over the same asset corpus.

### Files to change
- `src/rag/` or `orchestrations/scripts/contextualize-stories.sh` — embedding generation + retrieval
- `.epam/assets.json` → `.epam/assets.db` (or equivalent vector store file)
- CPA inference prompt — update to use semantically retrieved chunks

### Acceptance criteria
- Spike produces a written decision record: chosen library, rationale, WSL2 test result
- CPA retrieval uses cosine similarity, not keyword match
- No external server required (embedded/file-based store)
- KB coverage metric in CPA output improves vs TF-IDF baseline on hello-world run
- Existing assets.json corpus is auto-converted to vector store on first run

---

## GAP-P6 — OpenTelemetry emission alongside Langfuse

**Status:** done  
**Priority:** 3  
**Effort:** low (1 story)

### Problem
`TracedProvider.ts` emits only to Langfuse (self-hosted, non-standard). Any CNCF observability backend (Jaeger, Tempo, Honeycomb, Datadog) requires custom wiring. OTel is the industry standard.

### Approach
Add `@opentelemetry/sdk-node` alongside the existing Langfuse decorator. Emit spans to stdout (OTLP JSON format) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Langfuse tracing remains unchanged.

### Files to change
- `src/observability/TracedProvider.ts` — add OTel span emission
- `package.json` — add `@opentelemetry/sdk-node` dependency

### Acceptance criteria
- When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, behaviour is identical to current
- When set, spans are emitted in OTLP format per LLM call (tokens, cost, latency, model)
- Langfuse tracing still works independently when its env vars are set
- Both can be active simultaneously

---

## GAP-P7 — SwarmRouter-style topology selection

**Status:** done  
**Priority:** 4  
**Effort:** medium

### Problem
Phase execution topology is hardcoded: linear sequential phases as declared in `implementationOrder`. Simple phases (1-2 stories) pay the same overhead as complex parallel phases. There is no routing layer that selects sequential vs parallel vs hierarchical based on actual story count and complexity.

### Approach
Add a routing step before phase execution in `run-agent-orchestration.sh` that classifies the story set and selects topology: single-story (no worktree overhead), small-parallel (2-4 stories, existing parallel branch), large-hierarchical (5+ stories, team-lead-coordinated). Selection driven by story count + effort scores from CPA output.

### Files to change
- `orchestrations/scripts/run-agent-orchestration.sh` — routing classification step

---

## GAP-P8 — Constitution injection at agent invocation

**Status:** done  
**Priority:** 5  
**Effort:** low (1 line)

### Problem
`KB.md` behavioral rules are pulled on-demand by agents. An agent that doesn't read KB.md misses the rules. There is no guaranteed behavioral baseline across all agents.

### Approach
Prepend a short behavioral contract (never write outside PROJECT_ROOT, never skip AC verification, never modify protected files) to every agent system prompt in `claude.sh` at invocation time. Not all of KB.md — just the non-negotiable rules.

### Files changed
- `orchestrations/scripts/claude.sh` — `AGENT_CONSTITUTION` constant; injected via `--append-system-prompt` (CLI) and `--system-prompt` (SDK)
- `orchestrations/scripts/invoke.py` — added `--system-prompt` flag; passed as API `system` block

---

## GAP-P9 — Brownfield support — existing system context ingestion

**Status:** done  
**Priority:** 6  
**Effort:** medium (2-3 stories)  
**Depends on:** GAP-P2 (for live Jira/Confluence path)

### Problem
epam-cli is currently greenfield-only: it seeds new applications from scratch and builds the KB as phases run. Most enterprise work is brownfield — the codebase exists, architecture decisions are documented in Confluence, the backlog lives in Jira, and team patterns are embedded in git history. Without brownfield context ingestion, the orchestration re-implements existing things, contradicts established decisions, and produces CPA estimates that ignore existing tech debt.

### Approach
Two-stage implementation:

**Stage 1 — Local git context (testable without external services)**  
Use the existing `GitIngest.ts` (`src/tools/gitingest/GitIngest.ts`) to ingest the target repo at CPA time and story invocation time. For brownfield runs, the PRD points at an existing repo root. GitIngest extracts relevant file context for each story's scope. No external services required — testable against any local git repo.

**Stage 2 — External system context (requires live Jira/Confluence/GitHub)**  
Add a file-based stub adapter so development and testing can proceed without live services. Stubs are `.epam/brownfield/jira.json`, `.epam/brownfield/confluence.md`, etc. — same shape as what the real MCP adapters would return. Live MCP integration is wired when env vars are present; stubs are the fallback for local development.

Context from all sources feeds the same `{source, score, chunk}` retrieval interface used by P4 — no change to CPA or story invocation call sites.

### Files to change
- `orchestrations/scripts/lib/brownfield-context.js` — new: orchestrates GitIngest + stub/live adapter; same output shape as semantic-search.js
- `orchestrations/scripts/contextualize-stories.sh` — add brownfield context pass when `brownfield: true` in PRD
- `orchestrations/prd.json` schema — add optional `brownfield.repoRoot` and `brownfield.sources[]` fields
- `.epam/brownfield/` — stub files for local development/testing

### Test vehicle
Travel app (`orchestrations/game-prd.json` or equivalent travel PRD) is used as the brownfield test target:
1. Run greenfield travel app PRD → produces a populated repo in the test apps dir
2. Author a follow-on brownfield PRD pointing `brownfield.repoRoot` at that repo
3. Seed `.epam/brownfield/jira.json` with ~5 fake Jira tickets shaped around the travel domain (flight search, booking flow, etc.)
4. Run CPA — verify brownfield chunks appear alongside KB chunks in output

No external services required at any stage.

### Acceptance criteria
- When `brownfield` is absent from PRD, behaviour is identical to current (greenfield)
- When `brownfield.repoRoot` is set, GitIngest runs at CPA time and injects repo context per story
- Stub adapter reads from `.epam/brownfield/*.json|.md` when live service env vars are absent
- Retrieved brownfield chunks labelled `source: git:<path>`, `source: stub:jira`, etc. in CPA output
- Stage 1 (GitIngest) verified by running follow-on PRD against the travel app output repo
- Stage 2 (live MCP) wired but gated behind env vars — absent vars fall through to stubs silently
- CPA estimate for a brownfield story demonstrably differs from the same story run greenfield — confirms context is being consumed

---

## GAP-P2 — External event triggers (webhook/Jira/Slack)

**Status:** pending  
**Priority:** 7  
**Effort:** medium (2-3 stories)  
**Enables:** GAP-P9 Stage 2 (live Jira context ingestion)

### Problem
Orchestration runs are currently triggered manually (`run-agent-orchestration.sh`). There is no inbound path from the systems where work is actually managed — Jira, Slack, GitHub. This means the orchestration is disconnected from the team's workflow: someone has to manually translate a Jira Epic into a PRD and fire the run. For enterprise adoption, the system needs to receive work items and trigger itself.

### Approach
Add an inbound webhook route to `control-plane.js`. Jira webhook payloads (Epic created/updated, Sprint started) are normalised into PRD shape by a Jira adapter and queued. A debounced batch aggregator holds events for a 45-second window before firing the orchestration — batching rapid Jira updates (field edits, AC refinements) into a single run rather than spawning one per event. Urgent-label events bypass the window and fire immediately.

**Writeback is explicitly OUT OF SCOPE and must never be built.** This project never
writes to any client system (Jira, Confluence, or otherwise) — `jira-client.js` is
read-only by design (no method parameter on its `request()` function; a write call
cannot even be constructed). An unauthorized writeback path was added and removed
once already (2026-07-22) after it posted a live comment to a real Jira ticket
without permission. Any future work in this area must stay strictly inbound
(reading Jira to trigger a run) — never outbound (posting status back to Jira).

### Files to change
- `control-plane.js` — add `POST /webhook/jira` and `POST /webhook/slack` routes
- `lib/webhook-queue.js` — new: debounced batch aggregator; 45s window; urgent-label bypass; persistent queue file at `.epam/webhook-queue.json`
- `lib/jira-adapter.js` — new: normalise Jira webhook payload → PRD `phases[].stories[]` shape (read-only; uses the existing read-only `lib/jira-client.js`)

### Acceptance criteria
- When `JIRA_WEBHOOK_SECRET` is unset, `control-plane.js` starts normally with no webhook routes registered
- Jira webhook payload normalises to valid PRD shape; invalid payloads are rejected with 400
- Rapid Jira updates within the 45s window are collapsed into a single orchestration run
- Events with an `urgent` label bypass the debounce window and trigger immediately
- Persistent queue survives `control-plane.js` restart — no events lost
- Writeback posts correct comment at each milestone; transition matches story workflow state
- Testable with synthetic webhook payloads (no live Jira required for unit tests)

---

## GAP-P10 — Dynamic constitution augmentation

**Status:** done  
**Priority:** 8  
**Effort:** low (1 story)

### Problem
P8 injects a static `AGENT_CONSTITUTION` — the same four rules for every agent on every story. High-risk story types have additional non-negotiable constraints that the static constitution doesn't cover: auth stories should never store credentials in plaintext; migration stories should never drop columns; API boundary stories must validate all inputs. A generic constitution can't express these without becoming so long it dilutes attention on all stories.

### Approach
Add a `.epam/constitution-rules.json` file (per-project, optional) containing match/rules pairs. At story invocation time, `claude.sh` checks each rule's `match` criteria against the story's `agentRole`, `tags`, and `technicalNotes.requiredSkills`. Matched rules are appended to the base `AGENT_CONSTITUTION` before injection. No match → base constitution only, identical to P8 behaviour.

```json
[
  {
    "match": { "skills": ["auth", "jwt", "oauth", "session"] },
    "rules": ["Never store credentials or tokens in plaintext. Always hash passwords with bcrypt."]
  },
  {
    "match": { "skills": ["database", "migration", "sql"] },
    "rules": ["Never DROP COLUMN or DROP TABLE. Only ADD COLUMN with a default. Never run destructive DDL."]
  },
  {
    "match": { "agentRole": "qa-engineer" },
    "rules": ["Never modify production source files. Write tests only. Do not fix the code under test."]
  }
]
```

### Files to change
- `orchestrations/scripts/claude.sh` — new `resolve_dynamic_constitution()` function; appends matched rules to `AGENT_CONSTITUTION` before injection
- `.epam/constitution-rules.json` — per-project rule config (optional; absent means no change)

### Acceptance criteria
- When `.epam/constitution-rules.json` is absent, behaviour is identical to P8
- When present, rules whose match criteria overlap the story's skills/role are appended to the base constitution
- Multiple rules can match a single story; all are appended
- Matched rules appear in the injected system prompt for that story only — not carried to subsequent stories
- Testable with a synthetic PRD story that has `requiredSkills: ["auth"]` + a rule file targeting "auth"

---

## GAP-P11 — LLM-based topology routing

**Status:** done  
**Priority:** 9  
**Effort:** medium (1-2 stories)

### Problem
P7's topology router uses story count as the sole signal: ≤1 story collapses to main branch, ≥2 uses worktrees. This misclassifies a single high-effort story (e.g., effort=high, 5-point, touching 12 files) the same as a single trivial story. Conversely, two low-effort stories that are tightly coupled may be better run sequentially on main than in parallel worktrees. A count heuristic cannot distinguish these cases.

### Approach
Replace the count check in `run-agent-orchestration.sh` with a call to `lib/topology-router.js`. The router takes the phase's story set (ids, effort scores, dependency edges, file overlap from CPA signals) and returns a topology decision: `single`, `parallel`, or `hierarchical`. The decision is made by a cheap model call (Haiku) with a structured prompt — not a reasoning model. Falls back to the count heuristic if the LLM call fails.

Cost: one Haiku call per phase (~$0.001). Acceptable overhead relative to phase execution cost.

### Files to change
- `orchestrations/scripts/lib/topology-router.js` — new: takes story metadata array, calls Haiku, returns `{topology, reason}`
- `orchestrations/scripts/run-agent-orchestration.sh` — replace `_wt_count` block with `topology-router.js` call; retain count heuristic as fallback

### Acceptance criteria
- When `EPAM_API_KEY_ANTHROPIC` is unset, falls back to count heuristic (no regression)
- Single high-effort story (effort=high) routes to `single` topology despite count=1 matching current behaviour — verifiable by checking the reason field
- Two tightly-coupled stories (shared files in CPA signals) route to `sequential` rather than `parallel`
- Router decision and reason logged to phase-cost.jsonl alongside cost records
- Adds ≤1 Haiku call per phase to total run cost

---

---

## GAP-P12 — Library/framework ecosystem & composability

**Status:** pending  
**Priority:** 10  
**Effort:** high (architectural)  
**Source:** LangGraph, AutoGen, CrewAI

### Problem
Tools like LangGraph, AutoGen, and CrewAI win on being embeddable libraries with a broad community pattern library (nodes, tools, memory types, integrations, tutorials). EPAM CLI presents more like a productized workflow system + shell scripts — less obviously a reusable SDK that developers can import, subclass, and extend in their own codebases.

### Approach
Expose a clean TypeScript SDK surface alongside the CLI. Key surfaces: `AgentRunner` as a first-class importable class, `ProviderChain` composable from user code, `OrchestrationPlan` as a typed schema that callers can construct programmatically. Publish to npm. Add a "use as a library" section to README with a 10-line example. The CLI remains the primary interface; the SDK surface is additive.

### Acceptance criteria
- `import { AgentRunner, ProviderChain } from 'epam-cli'` works from an external project
- Public API surface is documented with JSDoc and exported types
- README includes a library usage example (not just CLI usage)
- npm package published with `main`, `types`, and `exports` fields
- No breaking changes to existing CLI behavior

---

## GAP-P13 — Durable, distributed orchestration semantics

**Status:** pending  
**Priority:** 15  
**Effort:** Phase 1 low (1 story — idempotency keys + file checkpoints, no external services); Phase 2 medium (2 stories — resumable state machine); Phase 3 high (Temporal backend, future)  
**Source:** Temporal, Prefect

### Problem
Platforms like Temporal offer durable state, retries, deterministic workflow replay, and horizontal scalability. EPAM has Redis/session stores and a control plane, but lacks explicit durable-workflow guarantees: idempotency keys, replay-safe execution, distributed task scheduling across workers, and crash-safe mid-story resume. A process kill mid-story loses state.

### Approach
Phase 1 (low effort): add idempotency keys to every story execution record in `logs/agent-status.json`; on restart, skip stories whose key already completed. Phase 2 (medium effort): make `run-agent-orchestration.sh` a resumable state machine — checkpoint before and after each story so a restart replays from the last checkpoint rather than from scratch. Phase 3 (high effort, future): evaluate Temporal SDK as an optional execution backend.

### Acceptance criteria
- Killing and restarting orchestration mid-phase resumes from the last completed story, not from scratch
- Each story execution has a deterministic idempotency key logged to `agent-status.json`
- Duplicate story execution (same key) is a no-op, not a double-run
- Phase 1 and 2 require no external services — file-based checkpoints only

---

## GAP-P14 — Sandboxing / security isolation for tool execution

**Status:** done  
**Priority:** 12  
**Effort:** high  
**Source:** OpenHands, SWE-agent  
**Supersedes:** GAP-P1 (Docker sandbox, deferred — this is the re-evaluation)

### Problem
Many judging panels and enterprise buyers require containerization/sandboxing for shell and file tools: per-run containers, seccomp profiles, network controls. EPAM has behavioral contracts (GAP-P8/P10) and path constraints, but those are prompt-level guardrails, not hard OS-level isolation. A compromised or misbehaving agent can still reach the host filesystem and network.

### Approach
Add an optional `--sandbox` flag to `run-agent-orchestration.sh` that wraps each agent invocation in a rootless `podman run` (or `docker run`) container with: (a) the project directory bind-mounted read-write, (b) no network access by default (override with `--allow-network`), (c) resource limits (CPU, memory). The container image is a minimal Node 20 image with the EPAM CLI installed. Without `--sandbox`, behaviour is unchanged.

### Acceptance criteria
- `--sandbox` flag is accepted; without it, behaviour is identical to current
- Agent file writes land in the bind-mounted project dir and survive container exit
- Network is blocked inside the container by default; `--allow-network` restores it
- A test story that attempts to write outside PROJECT_ROOT fails with a permission error (not a prompt refusal)
- Works on WSL2 with rootless podman or standard Docker Desktop

---

## GAP-P15 — Cross-run scorecard dashboard

**Status:** done  
**Priority:** 10  
**Effort:** low (1 story — data already emitted, gap is aggregation + view)  
**Source:** SWE-bench, OpenHands  
**Related:** GAP-P3 (SWE-bench harness, deferred)

### Problem
All the raw scoring data already exists: `phase-cost.jsonl` has per-story status/cost/time/tokens/turns; `testing-gates.jsonl` has gate verdicts (pass/fail per phase); `cpa-review.jsonl` has estimation accuracy vs actuals. What's missing is a cross-run aggregator that reads these files and renders a historical scorecard — story pass rate, test gate pass rate, cost/story, time/story, defect rate — comparable across runs. Without the aggregation layer, quality claims remain anecdotal even though the data is there.

### Approach
Add a `scorecard.html` dashboard to `orchestrations/dashboards/` that reads the three existing JSONL files via the same Eleventy data pipeline used by `phase-cost-monitor.html`. Compute per-run aggregates client-side: story pass rate (status=completed / total), gate pass rate (verdict=pass / total), mean cost/story, mean elapsed minutes/story, first-attempt success rate (stories completed on attempt 1 vs retried). Render a historical runs table (one row per run date/phase) and a summary pill strip matching the existing dashboard UI.

### Acceptance criteria
- `scorecard.html` loads in the Eleventy build and is linked from `monitor.html` nav
- Reads `phase-cost.jsonl`, `testing-gates.jsonl`, and `cpa-review.jsonl` — no new log emitters required
- Displays per-run metrics: story pass rate (%), gate pass rate (%), mean cost/story ($), mean time/story (min), first-attempt success rate (%)
- Historical runs table sortable by date; current run row highlighted
- Matches existing dashboard visual style (dark theme, pill strip, shared runtime overlay)
- No new backend scripts required — purely a dashboard-layer addition

---

## GAP-P16 — First-class plugin/tool marketplace

**Status:** pending  
**Priority:** 14  
**Effort:** medium (2-3 stories — interface definition + loader + docs; no registry infra needed initially)  
**Source:** LangGraph, AutoGen

### Problem
Competitors offer a clean plugin interface, tool registry, and community-contributed integrations. EPAM has tools under `src/tools/builtin` and MCP server config, but there is no stable plugin API with versioning, no tool registry discoverable at runtime, and no extension documentation that would let a third-party author publish a compatible tool package.

### Approach
Define a stable `ToolPlugin` interface (name, version, schema, execute) in `src/tools/plugin.ts`. Add a `tools` array to `.epam/settings.json` where each entry is either a built-in tool name or an npm package path exporting a `ToolPlugin`. The tool resolver loads external plugins at startup alongside built-ins. Add `TOOL_REGISTRY.md` documenting the interface and publishing contract.

### Acceptance criteria
- `ToolPlugin` interface is exported from the package with stable semver guarantees
- `.epam/settings.json` `tools` array is respected at startup; unknown built-in names warn, don't crash
- An external npm package implementing `ToolPlugin` loads and executes correctly when listed in settings
- `TOOL_REGISTRY.md` documents the interface, versioning policy, and a 20-line example plugin
- Existing built-in tools continue to work with no behavior change

---

## GAP-P17 — Model-specific optimizations + structured outputs

**Status:** pending  
**Priority:** 15  
**Effort:** medium (2 stories — outputSchema field in PRD + StoryArtifact emitter; no provider changes needed)  
**Source:** LangGraph, AutoGen

### Problem
LangGraph and AutoGen ecosystems lean into structured outputs (JSON schemas, typed tool calls) and model-specific prompt optimizations. EPAM likely does some of this internally, but from the outside it can read as "shell scripts + prompts" unless structured contracts and typed artifacts are clearly showcased. Structured outputs also reduce parse failures and hallucinated field names.

### Approach
Add an optional `outputSchema` field to story specs. When present, `claude.sh` appends the schema as a JSON block to the agent system prompt and requests structured output. Pair with a `StoryArtifact` TypeScript type that captures the structured output (files written, tests run, AC results). Emit `StoryArtifact` to `logs/story-artifacts.jsonl` per story. Add a showcase section to README/docs.

### Acceptance criteria
- Story spec accepts optional `outputSchema` (JSON Schema object)
- When set, agent system prompt includes the schema and a structured-output instruction
- Agent response is parsed against the schema; parse failures are logged with the raw response for debugging
- `logs/story-artifacts.jsonl` is emitted per story regardless of `outputSchema` (schema-less stories emit a minimal artifact)
- README documents structured output usage with an example

---

## GAP-P18 — One-command demo (travel app + working API)

**Status:** done  
**Priority:** 11  
**Effort:** low (demo mechanism exists; gap is travel app API endpoint + canned recording)  
**Source:** All competitors  
**Depends on:** SKY-001b (API discovery story) resolving the correct RapidAPI endpoint

### Problem
The CLI already exists as a demo vehicle and the travel app PRD (`orchestrations/travel-app-prd.json`) is the right demo payload. The gap is that the Skyscanner API client uses a hallucinated endpoint (`sky-scanner3.p.rapidapi.com/search/flight` — returns 404). A demo that hits a 404 on the first real search is not a demo. SKY-001b (added 2026-06-02) adds an API discovery story that will fix this on the next rebuild. The secondary gap is a recorded/canned dashboard state so the demo works even without a live API key.

### Approach
1. **Fix the API endpoint** — run the travel app rebuild once SKY-001b is in place; the discovery story will produce the correct host/path in `docs/api-contract.md` and SKY-002 will implement against it.
2. **Canned dashboard state** — snapshot a completed run's `logs/` JSONL files into `demo/logs/` so the dashboards render a full run without needing a live API key. Add a `scripts/demo-mode.sh` that symlinks `demo/logs/` into the active logs path.
3. **QUICKSTART.md** — 3 steps: clone, set `RAPIDAPI_KEY`, run `orchestrations/scripts/run-travel-app-test.sh`. Link to canned dashboard recording for keyless preview.

### Acceptance criteria
- Travel app rebuild with SKY-001b completes without 404 on `/search` or `/cheapest` endpoints
- `demo/logs/` contains a complete snapshot of a successful travel app run (all JSONL files)
- `scripts/demo-mode.sh` points dashboards at `demo/logs/` — dashboards render fully without a live run
- `QUICKSTART.md` exists with exactly 3 numbered steps
- README minimum-setup section lists only `RAPIDAPI_KEY` as required for the live demo path

---

---

## GAP-P22 — Full pipeline cost tracking (spec, CPA, gates, assessments)

**Status:** pending  
**Priority:** 17  
**Effort:** medium (2-3 stories)  
**Source:** Cost observability — identified during travel app test session

### Problem
`phase-cost.jsonl` only tracks story implementation agent costs. All support pipeline agents — spec pass (OpenSpec/Speckit), CPA estimation calls, topology router, pre/post-phase assessments, team lead review, and QA gate agents (SAST, spec-validator, review-ranger, mutant-hunter, fuzz-weaver, perf-sentinel) — are untracked. In practice these agents can cost 3–5× the story implementation total, making the dashboard cost figures unreliable and the scorecard's "cost/story" metric misleading. The Anthropic API dashboard shows the true total; the orchestration dashboard doesn't.

### Approach
Add a lightweight `append_pipeline_cost_record()` function (mirroring `append_cost_record()`) that emits to `phase-cost.jsonl` with an `agentType` field distinguishing pipeline agents from story agents. Wire it into: spec-mode-runner.js (per-story spec agent invocations), contextualize-stories.sh (CPA LLM call), topology-router.js, and the run_testing_gates() function in run-agent-orchestration.sh (each QA gate agent). The scorecard dashboard then sums all records and breaks down story vs pipeline costs separately.

### Acceptance criteria
- Every agent invocation in the pipeline emits a record to `phase-cost.jsonl` with `agentType: "spec"|"cpa"|"topology"|"assessment"|"qa-gate"|"story"`
- `phase-cost.jsonl` total matches (within 5%) the cost shown on the Anthropic API dashboard for the same run
- Scorecard dashboard shows story cost vs pipeline overhead as separate line items
- CPA formula estimates account for pipeline overhead when computing phase-level budget forecasts
- No regression in existing story cost tracking

---

## GAP-P19 — Secrets redaction in logs and artifacts

**Status:** pending  
**Priority:** 17  
**Effort:** medium (2 stories — scrubber library + wiring into all JSONL emitters)  
**Source:** Enterprise security requirements, contest judging

### Problem
JSONL log files (`agent-messages.jsonl`, `phase-cost.jsonl`, `story-artifacts.jsonl`, `agent-activity.jsonl`) are written by agents and orchestration scripts without any scrubbing layer. If an agent echoes an env var, API key, or credential in its output (e.g. in a bash command result or reasoning trace), it lands in the log file unredacted. The behavioral constitution forbids this, but that's a prompt-level control — not a hard guarantee. Judges and enterprise buyers will ask whether secrets can leak into dashboards or JSONL artifacts.

### Approach
Add a `scrub()` pass to every JSONL write path. The scrubber regex-replaces known secret patterns (API key formats, env var names containing KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL) and any value that was set in the process environment at startup. Redacted values are replaced with `[REDACTED]`. Wire into: `append_cost_record()` in `claude.sh`, the agent-messages writer in `run-agent-orchestration.sh`, and `emit_story_artifact()`. Add a `EPAM_LOG_REDACTION=1` env var (default on) with an opt-out for development environments.

### Acceptance criteria
- `scrub()` function in `orchestrations/scripts/lib/scrub.sh` replaces known secret patterns with `[REDACTED]`
- All known `EPAM_API_KEY_*`, `ANTHROPIC_API_KEY`, `RAPIDAPI_KEY`, `JIRA_*_TOKEN` values from the environment are redacted before any JSONL write
- Patterns: 40+ char hex/base64 strings, `sk-ant-*`, `ghp_*`, `Bearer *`, `token:*`
- `EPAM_LOG_REDACTION=0` disables scrubbing (dev/debug only)
- Dashboard JSON files (`agent-status.json`) pass through the same scrubber
- Existing tests pass; new test verifies a known key value does not appear in output JSONL after a story run

---

## GAP-P20 — Deterministic replay and version pinning

**Status:** pending  
**Priority:** 18  
**Effort:** medium (2-3 stories)  
**Source:** Temporal/Dagster-style reproducibility, contest judging

### Problem
Orchestration runs are not deterministic across time. If a model is updated (e.g. `claude-haiku-4-5-20251001` → newer haiku), the same PRD produces different outputs. Prompt templates in `claude.sh` are not versioned. There is no way to replay a past run from its artifacts and get the same result. Judges expecting reproducibility guarantees will find this gap.

### Approach
Phase 1 (low effort): add a `runManifest` record to `logs/` at the start of each orchestration run capturing: `orchRunId`, `claudeShHash` (sha256 of claude.sh), model resolved per story, `prdHash` (sha256 of prd.json at run start), tool versions, Node version, and timestamp. This creates an auditable snapshot of "what ran".

Phase 2 (medium effort): add `"model"` and `"toolVersions"` pinning fields to PRD story specs. When set, `claude.sh` asserts the resolved model matches the pinned value and warns (not errors) on mismatch. Add a `--replay <runManifest>` flag to `run-agent-orchestration.sh` that loads the manifest and enforces pinned values from it.

### Acceptance criteria
- `logs/run-manifest-<ORCH_RUN_ID>.json` is written at orchestration start with model, hash, and version fields
- PRD story `"model"` field is respected as a hard pin (not just a preference)
- `--replay <manifest>` flag loads the manifest and enforces all pinned values
- `npm run test` still passes; manifest write does not block orchestration on error

---

## GAP-P21 — Multi-repo / monorepo and enterprise GitOps

**Status:** pending  
**Priority:** 19  
**Effort:** high (3-4 stories)  
**Source:** Enterprise GitOps adoption, contest judging

### Problem
Worktree-based parallelism works within a single git repository. Enterprise projects often involve: (a) multi-service changes spanning several repos with coordinated PRs, (b) mono-repo constraints where multiple packages share a root and branch naming is controlled, (c) GitOps release pipelines where story completion must trigger downstream CI/CD steps. EPAM CLI has no model for cross-repo coordination or GitOps integration hooks.

### Approach
Phase 1 (medium effort): add `"repos"` array to PRD project config. Stories can declare `repo: <alias>` to indicate which repository they modify. `run-agent-orchestration.sh` checks out each repo's worktree independently and merges independently. Phase handoff artifacts record cross-repo commit SHAs.

Phase 2 (high effort): add a `POST /webhook/github` route to `control-plane.js` (mirroring the Jira webhook). On PR merge events, the control plane can trigger downstream phases. Writeback to GitHub (PR comments, status checks) is OUT OF SCOPE — this project never writes to any client system; see GAP-P2's note on why writeback must never be built.

### Acceptance criteria
- PRD `project.repos` array allows per-story `repo` field routing to different checkouts
- Worktree creation respects the per-story repo root rather than assuming a single `GIT_WORK_ROOT`
- Phase handoff artifact records `repoSha` per repo touched
- `POST /webhook/github` route verified with a synthetic webhook payload (no live GitHub required for unit tests)
- Existing single-repo behavior unchanged when `project.repos` is absent

---

---

## GAP-P23 — Orchestration agent coverage — integration tests

**Status:** pending  
**Priority:** 20  
**Effort:** medium (2-3 stories)  
**Source:** Run 84 — identified during profiles.json audit

### Problem
The 10 orchestration/tooling agents (`project-initiator-agent`, `prd-project-manager-agent`, `agent-skills-agent`, `grooming-coordinator`, `readiness-checker`, `dedup-detector`, `generator`, `dashboard-orchestrator-agent`, `dashboard-test-agent`, `dashboard-update-agent`) have profiles in `profiles.json` but are only invoked from `src/scaffold/ProjectScaffolder.ts` (during `epam new init/generate`) or `reset-cost-test.sh` (a reset utility). They are never exercised by the tier3 travel-app pipeline, and no integration tests exist that invoke them end-to-end. A stale prompt, wrong output schema, or broken invocation path in any of these agents is undetectable until a user actually runs `epam new init`.

### Approach
Add a lightweight smoke-test suite under `test/integration/orchestration-agents/` that invokes each agent with a minimal fixture PRD and validates:
1. The agent returns a structurally valid JSON response matching its declared output schema
2. No agent crashes the process or produces an empty response
3. Profiles in `profiles.json` match the schemas used in `ProjectScaffolder.ts`

Use a mock LLM provider (`EPAM_PROVIDER=mock`) for CI so tests don't incur API costs. Each test asserts output schema validity only — not content quality.

### Acceptance criteria
- One integration test per orchestration agent (10 tests)
- Tests run via `vitest run test/integration/orchestration-agents/`
- Use mock provider — zero LLM cost, runs in CI without API keys
- Test fails if agent returns empty output, crashes, or output fails JSON schema validation
- Profile key in `profiles.json` validated against the key referenced in `ProjectScaffolder.ts` — mismatch is a test failure
- All 10 tests pass on a clean checkout before any `epam new init` is run

---

## GAP-P24 — Documentation agent coverage — pipeline wiring and smoke tests

**Status:** pending  
**Priority:** 21  
**Effort:** medium (2 stories)  
**Source:** Run 84 — identified during profiles.json audit

### Problem
The 10 documentation agents (`doc-coordinator`, `docstring-agent`, `api-doc-generator`, `guide-author`, `architecture-doc-agent`, `changelog-agent`, `doc-reviewer`, `doc-index-builder`, `doc-search-agent`, `doc-site-builder`) have profiles in `profiles.json` but are not wired into `run-agent-orchestration.sh` at all. There is no doc-generation phase in the travel-app PRD or any other active PRD. The agents exist as profiles only — they have never produced a real output artifact in a live run. It is unknown whether their prompts are correct, their output formats are parseable by the pipeline, or their invocation mechanism works.

### Approach
Two parallel tracks:

**Track 1 — Smoke tests (immediate):** Add smoke tests under `test/integration/doc-agents/` identical in structure to GAP-P23: mock provider, schema validation, one test per agent. These confirm at minimum that the agent can be invoked and returns valid output.

**Track 2 — Doc phase wiring (pipeline):** Add an optional `doc` phase to the travel-app PRD (behind `SKIP_DOC_PHASE=true` env var by default). The doc phase runs after `ui_and_review` completes and invokes `doc-coordinator` → `docstring-agent` + `api-doc-generator` + `architecture-doc-agent` → `doc-reviewer` → `doc-index-builder` in sequence. Output: `docs/` directory in `OUTPUT_DIR`. Wire into `run-agent-orchestration.sh` and `tier3-travel-app-run.sh`.

### Acceptance criteria
**Track 1:**
- 10 smoke tests, one per doc agent, using mock provider
- Each test validates output schema — fails on empty or non-JSON response
- Tests run in CI with zero API cost

**Track 2:**
- `SKIP_DOC_PHASE=false` enables the doc phase in tier3 travel-app runs
- Doc phase steps appear in the tier3-checklist.py view
- At least one complete travel-app run with doc phase enabled produces a non-empty `docs/` directory
- `doc-reviewer` verdict gates the phase (warn on partial, fail on no docs produced)

---

---

## GAP-P25 — Runtime story split enforcement: AC cap, depth guard, parent AC redistribution

**Status:** pending  
**Priority:** 1 (blocking quality — observed in Run 84 CORE phase)  
**Effort:** medium (2-3 stories)  
**Source:** Run 84 — SKY-002a-1 (93 ACs), SKY-004-B-IMPL (56 ACs), depth-6 splits observed

### Problem

Story splits bypass all enforcement that only runs at preflight time, causing three compounding failures observed in Run 84:

**1. AC overflow on split stories.** `preflight-check.sh` validates the ≤24 AC limit on stories that exist at run start (`status=pending`). Split stories are dynamically added to the PRD mid-execution (during Step 1), after preflight has already passed. Result: 6 core stories exceeded the AC limit — including SKY-002a-1 with 93 ACs (4× the limit). The spec-validator, review-ranger, and mutant-hunter all receive this story and cannot meaningfully evaluate 93 ACs in a single prompt pass.

**2. Parent ACs not redistributed on split.** When `spec-mode-runner.js` splits a story, children receive their own AC arrays but the parent's AC array is never cleared or trimmed. The parent continues to carry all its original ACs in addition to the children's ACs, creating redundant and contradictory coverage expectations.

**3. Split depth exceeds max-depth=2 at runtime.** `spec-mode-runner.js` enforces `maxSplitDepth=2` only during the spec pass (Step 0). When stories request further splits mid-execution (during Step 1 agent runs), the depth guard is not re-applied. Result: `SKY-004-B-TEST-IMPL-1` and `SKY-004-B-TEST-VALIDATION-1` reached depth 6 parts — well beyond the canonical max of 2. A `split budget` of max 4 children per parent was also exceeded.

### Root cause locations

- **Architectural flow gap (primary):** speckit only runs during Step 0 (spec pass) on stories openspec just processed in the same pass. Mid-execution splits — stories registered by agents during Step 1 — bypass speckit entirely. There is no code path that routes a mid-execution split through speckit before it becomes active.
- `orchestrations/scripts/spec-mode-runner.js` line 1133: `maxSplitDepth` check only runs in `applyPRDChanges()` during spec pass — not when stories self-register splits mid-execution.
- `orchestrations/scripts/spec-mode-runner.js` line 1157: child ACs are set but parent ACs are never cleared after split.
- `orchestrations/scripts/spec-mode-runner.js` lines 991–995: speckit's `SPLIT RULES` instruct it not to split `splitDepth > 0` stories — but this is a prompt instruction, not code enforcement. Mid-execution splits ignore it.
- `orchestrations/scripts/preflight-check.sh`: AC limit check uses `status=pending` filter — excludes any story added after preflight runs.
- No runtime split registration guard exists anywhere in the pipeline.

### Approach

**Fix 1 — Speckit as universal split gatekeeper (architectural fix, primary).**
Speckit must review ALL splits regardless of when or how they are registered — not just splits proposed by openspec during the spec pass. Implement a `runSpeckitOnSplit(parentStory, splitStories, prd)` function in `spec-mode-runner.js` that is called from:
- `applyPRDChanges()` — existing path (speckit already runs here via the agent loop, but make it explicit and mandatory)
- The mid-execution PRD write path in `run-agent-orchestration.sh` — any time an agent writes new story entries to the PRD during Step 1, intercept the write and call speckit before committing to `implementationOrder`

Speckit's review of mid-execution splits uses the same prompt it uses during the spec pass (lines 974–1010 of spec-mode-runner.js) with the parent story context + proposed children. If speckit rejects a split (returns empty splitStories or flags AC violations), the split is not registered and the agent is instructed to complete within scope.

This makes speckit the single enforcement point for split quality — one place, all paths.

**Fix 2 — Hard AC cap at split registration.** Add a `validateSplitStory(story, prd)` function called whenever a new story is written to the PRD (both in `spec-mode-runner.js` and in the mid-execution PRD write path in `run-agent-orchestration.sh`). If `story.acceptanceCriteria.length > 24`, truncate to 24 and log a warning. Never silently accept an over-limit story.

**Fix 3 — Parent AC redistribution.** When a split is registered in `applyPRDChanges()`, clear the parent story's `acceptanceCriteria` array and replace with a single summary AC: `"Delegated to split children: <child_ids>"`. This prevents the spec-validator from seeing 93 ACs on a completed parent.

**Fix 4 — Runtime depth guard (code, not prompt).** Move the depth check out of `applyPRDChanges()` and into a shared `canSplitStory(story, prd)` guard called from both spec-mode and any mid-execution PRD mutation path. Hard-reject (log error, skip split) any story where `splitDepth(story, prd) >= maxSplitDepth`. This is a code invariant — not a prompt instruction that an agent can ignore.

**Fix 5 — Split budget per parent.** Track `story.splitCount` in the PRD. When a story requests a split, increment the counter. Reject the split if `splitCount >= MAX_CHILDREN_PER_SPLIT` (default: 4). Prevents runaway splitting on a single story.

**Fix 6 — Post-phase AC invariant check.** After each phase completes (before starting the next phase), run a lightweight validation pass over all stories in `implementationOrder` — including dynamically added splits — and fail-fast with a clear error if any story exceeds 24 ACs or depth > 2. This catches violations before the quality gates try to evaluate them.

**Fix 7 — Test coverage.** Add tests to `test/unit/orchestration/` verifying: (a) split registration rejects >24 ACs, (b) parent ACs are cleared after split, (c) depth guard fires at depth 2, (d) split budget fires at 4 children, (e) mid-execution split path invokes speckit before registering.

### Acceptance criteria
- **Flow:** Every split — regardless of whether it originates from openspec during Step 0 or from an agent mid-execution during Step 1 — passes through speckit review before being registered in `implementationOrder`. No split bypasses speckit.
- **AC cap:** No story in any phase can have `acceptanceCriteria.length > 24` after a split — hard cap enforced at registration time, not as a prompt instruction
- **Parent redistribution:** Parent story ACs are cleared and replaced with a delegation note when any child split is accepted
- **Depth guard (code):** A story at `splitDepth >= 2` cannot spawn further splits — mid-execution split requests are hard-rejected in code, not just in prompt rules that agents can ignore
- **Split budget:** No parent story can have more than 4 split children — 5th split request is rejected
- **Post-phase invariant:** Runs automatically before each phase transition; blocks the next phase if any story violates AC or depth limits
- **Tests:** All 5 new unit tests pass before any live run (AC cap, parent clear, depth guard, split budget, mid-execution speckit invocation)
- **Preflight extended:** Covers all stories in `implementationOrder`, not just `status=pending` at run start

---

## Deferred

### GAP-P1 — Docker sandbox execution
Superseded by GAP-P14 (Sandboxing / security isolation) which re-scopes to rootless podman with an optional flag. Re-evaluate alongside GAP-P14.

### GAP-P3 — SWE-bench benchmark harness
**Status: done** (2026-06-03). 5 bundled TypeScript tasks + harness (`scripts/run-swe-bench.sh`) + `swe-bench.html` dashboard wired into Eleventy. Run: `bash scripts/run-swe-bench.sh`. Results aggregate into `benchmarks/results/` and render in the dashboard. Extend by adding tasks to `benchmarks/tasks/` following the existing format.
