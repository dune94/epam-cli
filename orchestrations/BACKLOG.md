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
| 1 | GAP-P5 | Intra-story planner/executor model split | pending | Aider, CrewAI |
| 2 | GAP-P4 | Semantic RAG — replace TF-IDF in CPA | pending | CrewAI, OpenHands |
| 3 | GAP-P6 | OpenTelemetry emission alongside Langfuse | pending | MAF, OAI Agents SDK |
| 4 | GAP-P7 | SwarmRouter-style topology selection | pending | kyegomez/swarms |
| 5 | GAP-P8 | Constitution injection at agent invocation | pending | swarm-forge |
| 6 | GAP-P2 | External event triggers (webhook/Jira/Slack) | deferred | OpenHands, Cline |
| 7 | GAP-P1 | Docker sandbox execution | deferred | OpenHands, SWE-agent |
| 8 | GAP-P3 | SWE-bench benchmark harness | deferred | SWE-agent (needs P1 first) |

---

## GAP-P5 — Intra-story planner/executor model split

**Status:** pending  
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

**Status:** pending  
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

**Status:** pending  
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

**Status:** pending  
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

**Status:** pending  
**Priority:** 5  
**Effort:** low (1 line)

### Problem
`KB.md` behavioral rules are pulled on-demand by agents. An agent that doesn't read KB.md misses the rules. There is no guaranteed behavioral baseline across all agents.

### Approach
Prepend a short behavioral contract (never write outside PROJECT_ROOT, never skip AC verification, never modify protected files) to every agent system prompt in `claude.sh` at invocation time. Not all of KB.md — just the non-negotiable rules.

### Files to change
- `orchestrations/scripts/claude.sh` — prepend contract to system prompt

---

## Deferred

### GAP-P2 — External event triggers
Webhook/Jira/Slack inbound to `control-plane.js`. Deferred until core engine improvements (P5, P4) are stable.

### GAP-P1 — Docker sandbox execution
Container isolation for agent Bash execution. High effort, low urgency for current single-operator usage. Re-evaluate at enterprise adoption stage.

### GAP-P3 — SWE-bench benchmark harness
Requires GAP-P1 (Docker sandbox) as a prerequisite.
