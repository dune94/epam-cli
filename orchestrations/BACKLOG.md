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
| 9 | GAP-P11 | LLM-based topology routing | pending | kyegomez/swarms |
| 10 | GAP-P15 | Cross-run scorecard dashboard | done | SWE-bench, OpenHands |
| 11 | GAP-P18 | One-command demo (travel app + working API) | done | All competitors |
| 12 | GAP-P14 | Sandboxing / security isolation for tool execution | done | OpenHands, SWE-agent |
| 13 | GAP-P16 | First-class plugin/tool marketplace | pending | LangGraph, AutoGen |
| 14 | GAP-P17 | Model-specific optimizations + structured outputs | pending | LangGraph, AutoGen |
| 15 | GAP-P13 | Durable, distributed orchestration semantics | pending | Temporal, Prefect |
| 16 | GAP-P12 | Library/framework ecosystem & composability | pending | LangGraph, AutoGen, CrewAI |
| 17 | GAP-P1 | Docker sandbox execution | deferred | OpenHands, SWE-agent |
| 18 | GAP-P3 | SWE-bench benchmark harness | done | SWE-agent |

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

Writeback closes the loop: at each pipeline milestone, the Jira client transitions the ticket and posts a comment with the relevant output (elaborated ACs at spec pass, cost estimate at CPA, PR link at story complete, review result at review done).

### Files to change
- `control-plane.js` — add `POST /webhook/jira` and `POST /webhook/slack` routes
- `lib/webhook-queue.js` — new: debounced batch aggregator; 45s window; urgent-label bypass; persistent queue file at `.epam/webhook-queue.json`
- `lib/jira-adapter.js` — new: normalise Jira webhook payload → PRD `phases[].stories[]` shape
- `lib/jira-client.js` — new: Jira REST API client for writeback (transition, comment)
- `orchestrations/scripts/jira-writeback.sh` — new: called at spec pass, CPA complete, story complete, review done

### Writeback events
| Milestone | Jira action |
|---|---|
| Spec pass (AC elaboration) | Update story description with elaborated ACs |
| CPA complete | Post comment with cost estimate and effort breakdown |
| Story complete | Transition to In Review; post PR link |
| Review done | Transition to Done or Reopened based on review result |

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

**Status:** pending  
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

## Deferred

### GAP-P1 — Docker sandbox execution
Superseded by GAP-P14 (Sandboxing / security isolation) which re-scopes to rootless podman with an optional flag. Re-evaluate alongside GAP-P14.

### GAP-P3 — SWE-bench benchmark harness
**Status: done** (2026-06-03). 5 bundled TypeScript tasks + harness (`scripts/run-swe-bench.sh`) + `swe-bench.html` dashboard wired into Eleventy. Run: `bash scripts/run-swe-bench.sh`. Results aggregate into `benchmarks/results/` and render in the dashboard. Extend by adding tasks to `benchmarks/tasks/` following the existing format.
