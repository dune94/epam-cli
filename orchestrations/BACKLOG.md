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
| 6 | GAP-P9 | Brownfield support — existing system context ingestion | in-progress (Stage 1 done) | codemie, smolagents |
| 7 | GAP-P2 | External event triggers (webhook/Jira/Slack) | done | OpenHands, Cline |
| 8 | GAP-P1 | Docker sandbox execution | deferred | OpenHands, SWE-agent |
| 9 | GAP-P3 | SWE-bench benchmark harness | deferred | SWE-agent (needs P1 first) |

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

**Status:** pending  
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

## Deferred

### GAP-P1 — Docker sandbox execution
Container isolation for agent Bash execution. High effort, low urgency for current single-operator usage. Re-evaluate at enterprise adoption stage.

### GAP-P3 — SWE-bench benchmark harness
Requires GAP-P1 (Docker sandbox) as a prerequisite.
