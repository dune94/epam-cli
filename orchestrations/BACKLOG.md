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
| 1 | VC-1 | **Investigate VC agent drift — fallback VCs poison the whole downstream chain** | pending | Live metrolinx repro-gate block, 2026-07-25 |
| 2 | TOKEN-VISIBILITY-1 | **Tool usage is not recorded, so grep-vs-codegraph and per-tool tokens cannot be measured** | pending | Agent tooling review, 2026-08-09 |
| 2 | PROMPT-BUDGET-1 | **Prompt trim measures total size but cuts only guidance — file injection is 39% and untrimmable** | pending | Live AMSD-2041, 2026-08-09 |
| 2 | TEST-GAP-1 | **Writer-phase test coverage gaps — see "Writer-Phase Test Coverage Gaps" below** | pending | Coverage audit, 2026-08-09 |
| 2 | SCHEMA-1 | **Schema-bind agent output — BLOCKED on the reviewer: strict schema suppresses tool calls** | blocked | Live metrolinx failures + probe, 2026-07-25 |
| 3 | GAP-P5 | Intra-story planner/executor model split | done | Aider, CrewAI |
| 4 | GAP-P4 | Semantic RAG — replace TF-IDF in CPA | done | CrewAI, OpenHands |
| 5 | GAP-P6 | OpenTelemetry emission alongside Langfuse | done | MAF, OAI Agents SDK |
| 6 | GAP-P7 | SwarmRouter-style topology selection | done | kyegomez/swarms |
| 7 | GAP-P8 | Constitution injection at agent invocation | done | swarm-forge |
| 8 | GAP-P9 | Brownfield support — existing system context ingestion | done | codemie, smolagents |
| 9 | GAP-P2 | External event triggers (webhook/Jira/Slack) | done | OpenHands, Cline |
| 10 | GAP-P10 | Dynamic constitution augmentation | done | Constitutional AI |
| 11 | GAP-P11 | LLM-based topology routing | done | kyegomez/swarms |
| 12 | GAP-P15 | Cross-run scorecard dashboard | done | SWE-bench, OpenHands |
| 13 | GAP-P18 | One-command demo (travel app + working API) | done | All competitors |
| 14 | GAP-P14 | Sandboxing / security isolation for tool execution | done | OpenHands, SWE-agent |
| 15 | GAP-P16 | First-class plugin/tool marketplace | done | LangGraph, AutoGen |
| 16 | GAP-P17 | Model-specific optimizations + structured outputs | done | LangGraph, AutoGen |
| 17 | GAP-P13 | Durable, distributed orchestration semantics | done | Temporal, Prefect |
| 18 | GAP-P12 | Library/framework ecosystem & composability | done | LangGraph, AutoGen, CrewAI |
| 19 | GAP-P22 | Full pipeline cost tracking (spec, CPA, gates, assessments) | pending | Cost observability |
| 20 | GAP-P19 | Secrets redaction in logs and artifacts | pending | Enterprise security |
| 21 | GAP-P20 | Deterministic replay and version pinning | pending | Temporal, Dagster |
| 22 | GAP-P21 | Multi-repo / monorepo and enterprise GitOps | pending | Enterprise GitOps |
| 23 | GAP-P1 | Docker sandbox execution | deferred | OpenHands, SWE-agent |
| 24 | GAP-P3 | SWE-bench benchmark harness | done | SWE-agent |

---

## VC-1 — Investigate VC agent drift  `pending`  **PRIORITY 1**

**Symptom, live 2026-07-25 (AMSD-1820).** The VC guard flagged:

> `VC 3 addresses station names, which is unrelated to the ticket's stated symptom
> (promo code amount in return trip email)`

Two regeneration cycles failed to clear it, so `enforceVerificationCriteria` returned
`safeFallbackVc` — dropping from 4 specific VCs to 2 generic ones. The run then produced a
VALID test (ran, typechecked, committed on attempt 1) which the repro-gate rejected:

> `⛔ BLOCK: the new test(s) FAIL with the fix in place — the fix is incomplete or the test
> is wrong.`

**The suspected chain.** Fallback VC → test writer has nothing concrete to assert → test
targets the wrong behaviour → repro-gate blocks a fix that may well be correct. Note this was
the FIRST run where every mechanical stage succeeded (writer first-attempt, no self-heal, no
ladder), so VC quality became the binding constraint rather than being masked by earlier
failures.

**Three things to investigate, in order.**

1. **The drift itself, not the phrasing.** "Station names" for a promo-code-in-email ticket is
   not a mechanism leak — it is the generator answering a different question. The guard is
   catching a symptom of bad generation. Look at what the generator is given: which fields of
   the ticket, in what order, and whether the codeline context is crowding out the symptom.

2. **`VC_MAX_CYCLES` default of 2 means ONE regeneration attempt.** The loop ladder-escalates
   the model per cycle, so a third cycle would reach a stronger model before giving up. Cheap
   to try, but only worth it if (1) shows the generator can recover with a better model rather
   than needing better input.

3. **Falling back may be worse than failing.** `safeFallbackVc` is derived purely from the
   ticket title and is guaranteed-safe *and* guaranteed-uninformative. It cannot fail the
   guard, and it cannot drive a useful test — so the story proceeds and burns the writer, the
   repro-gate and the reviewer before dying. Blocking with "VCs could not be established" would
   fail faster and more honestly. Weigh against: a hard block on an optional-ish quality signal
   stops runs that might otherwise succeed.

**Gather data before changing anything.** Across runs, count `source: clean` vs `regenerated`
vs `fallback`, and check whether `fallback` correlates with repro-gate blocks. One run is one
data point; this whole area has already produced two wrong diagnoses from single observations
(the 300s timeout, the first sanity guard).

Code: `orchestrations/scripts/spec-mode-runner.js` — `enforceVerificationCriteria`,
`safeFallbackVc`, `findVcMechanism`.

---

## SCHEMA-1 — Schema-bind agent output  `blocked`  **PRIORITY 2**

> **BLOCKED 2026-07-25 — do NOT implement as originally written.** A live probe showed a
> strict `json_schema` SUPPRESSES tool calling on both pipeline models. Measured on
> OpenRouter with a prompt that explicitly demanded a tool call ("You MUST call list_files
> first. Do not answer until you have called it."):
>
> | model | schema off | schema ON |
> |---|---|---|
> | `z-ai/glm-5.2` | tool_calls=**1** | tool_calls=**0** |
> | `moonshotai/kimi-k3` | tool_calls=**1** | tool_calls=**0** |
>
> The team-lead reviewer runs with `AI_GATE_ALLOW_TOOLS=1` and
> `EPAM_ALLOWED_TOOLS="bash,read_file,list_files,search"` for a documented reason — the
> comment in `team-lead-review.sh` says it is so the reviewer can "run the read-only
> CodeGraph tool to confirm whether an existing helper already provides logic the diff
> hand-rolled". That is the IMPL-FIDELITY check (see memory
> `project_impl_fidelity_minimal_fix_reuse`, added after AMSD-1820's false pass).
>
> Schema-binding the reviewer would silently delete that check: perfectly-formed verdicts
> produced without ever looking at the code. A mechanism reporting success while doing LESS
> than before — the exact class this session spent the day removing.
>
> The original entry assumed schema binding was free for the reviewer. It is not.

### Three options, none chosen — each needs live verification before it is written

1. **Forced tool-call instead of `response_format`.** Bind the output by requiring a
   `submit_verdict` tool call rather than a response schema, so structure comes THROUGH the
   tool channel instead of fighting it. Preferred instinct, but unverified: must confirm both
   models honour `tool_choice` while still permitting the investigative calls first.
2. **Two-phase.** A tool-using investigation pass, then a second schema-bound call that only
   formats the verdict. Correct, but doubles reviewer cost and latency.
3. **Bind only the NON-tool agents.** `code-review-cycle.sh` and similar keep their schema;
   the tool-using team-lead reviewer stays as-is. Smallest blast radius, leaves the highest-
   value agent unbound.

### Still true, and still the motivation

`lib/kb-synthesizer.js` is the ONLY one of twelve agent invocation sites whose output space is
schema-bound. Every other agent generates freely and a parser recovers structure afterwards
(`claude.sh` alone has ~197 post-hoc parse sites); `kb_schema.py`'s Pydantic reach stops at the
self-heal KB boundary. The reviewer's 169-byte truncated non-verdict (B28) blocked four
consecutive runs and is exactly what binding would prevent — which is why this stays high
priority rather than being dropped.

### The build specifics still hold for whichever option wins

1. **Keep a free-text field** (`reasoning`) so the model can still think in prose while the
   decision stays machine-readable. Constraining output changes behaviour — the VC producer is
   pinned to low effort precisely because high reasoning caused prescriptive drift.
2. **Do not touch the output budget.** Schema binding does NOT remove `<think>` tokens; they
   still bill against `EPAM_MAX_OUTPUT_TOKENS`. A trivial verdict used 663-842 completion
   tokens live.
3. **Fail loudly; never fall back to parsing.** `provider.require_parameters` makes routing
   explicit so OpenRouter cannot silently pick an upstream that ignores the schema.

### Acceptance — quality must not regress

Standing rule: *"if quality is not the same or is lower — revert."* Run the reviewer both ways
over the SAME diffs and compare verdicts AND issues found. For the reviewer specifically, also
confirm the CodeGraph helper-reuse check still fires — that is the capability most at risk.

Related: `project_structured_agent_io_framework` (memory), B28, `constraint-sanity.js`.

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

---

## Greenfield: hardcoded gates (deferred 2026-08-06)

**Priority:** medium — greenfield paths are not currently exercised; brownfield was fixed first.

Guards on greenfield-only code paths still carry hardcoded content, in violation of the
project's no-hardcoding rule. Found during the brownfield guard sweep and deliberately
deferred so the brownfield fix could ship.

### Sites
- `orchestrate.sh:275-284` — **scope-guard snapshot**. Hardcodes both the source directory
  (`src`) and the language (`find src -name "*.ts"`). A greenfield Python or Go project
  snapshots ZERO files and the guard still logs success: "0 files backed up" and "backed up
  everything" are indistinguishable. Same silent-nullity failure class as the old VC guard.
- `claude.sh:769-773` — `_brownfield_rung_bump` returns a bare literal `5` on the greenfield
  branch. The brownfield branch derives its bump from `cpaIterationEstimate`; greenfield gets
  a number somebody picked.
- `scaffold-be-repo.sh`, `scaffold-fe-repo.sh`, `scaffold-frontend-repo.sh`,
  `analyze_scaffold_phase.py` — named for a fixed backend/frontend split, itself a hardcoded
  project shape. Not yet inspected line by line.

### Approach
Same as the brownfield fix: the guard becomes a pure applier holding no content; what it
checks is derived per project by the `guard-vocabulary-agent` (schema-bound, inherits
ladder/retry/self-heal via `runAgentForJson`) and persisted for reproducibility. If the
vocabulary cannot be derived, the run aborts — an unarmed guard must never report clean.
For the scope-guard specifically, the file set should come from the repository itself
(`git ls-files`) rather than a hardcoded directory and extension, exactly as
`codeline-write-perimeter.sh` already does.

### Verified clean (no action needed)
- `prd-remediate.sh` — no pattern lists, no domain vocabulary.

## Review: `lexicalMentionCount` in `lib/codeline-structure.js`

Raised 2026-08-06 during the hardcoding sweep, deferred by the operator.

`codeline-structure.js:162` holds `const SKIP = new Set(['.git', 'node_modules'])` — a
directory-walk skip list inside `lexicalMentionCount`.

**Review the function before touching the list.** Its own docstring says it is "the OLD
signal, kept only to compare against": `rankByStructure` decides on declared dependencies
and buildability, and this raw term count exists so the structural score can be shown to
beat it. If that comparison is no longer being made, the function goes and the list goes
with it — which is a smaller change than replacing the list.

If it stays, the file list should come from `git ls-files` like the rest of the pipeline.
`.git` is git's own directory, which `git ls-files` never returns; `node_modules` is the
only genuinely stack-specific entry, and it is already excluded for any repo whose
`.gitignore` declares it. So the skip list is largely redundant on the git path either way.

Not urgent: nothing in the decision path reads it.

## Write perimeter: "not the baseline" is not "safe to write"

Found live 2026-08-06, deferred by the operator (does not impair the current run — the
codelines it leaves open are not the one being modified).

`perimeter_is_write_allowed` (lib/codeline-write-perimeter.sh) infers a story branch by
elimination: a repo that is not on the configured baseline branch and is not detached is
assumed to be a worktree or story branch, and is left WRITABLE. That holds only if every
repository under JIRA_CODELINE_ROOT shares one branch name.

They do not. Of 33 repositories the perimeter locked 23 and left 10 open, every one of them
on its OWN mainline: `Development` (azure.metrolinx.psme.com, c365,
construction-notice-pdf-service), `master` (cx-shared, docs.tools.com,
metrolinx.powerbi.com), `main` (docs.ads.com), `development` (login.metrolinx.com).

None is a story branch. The perimeter exists because ~1050 lines of client source were
destroyed by an agent, and it is leaving a third of the repositories unprotected — including
c365, which codeline discovery has ranked as a top candidate before.

**The fix** is to make the test POSITIVE rather than by elimination: permit writes only in a
worktree, or on a branch the ENGINE created. git-ops.sh:172 builds it as
`${EPAM_BRANCH_PREFIX:-}AI-${story_id}`, so the pattern is engine self-knowledge and needs no
per-project configuration. Anything else is somebody's mainline, whatever it is called.

Add a test asserting the perimeter's pattern still matches what git-ops.sh constructs, so the
two cannot drift.

**Correction (same day)**: I recorded here that the perimeter's own test suite was failing —
`bash` writing to a locked file, the "writer may write" case false. That was wrong. The file
had been destroyed by a bad edit of mine and recovered from the session transcript, and the
recovered copy was an EARLY DRAFT whose REPO_ROOT resolved to `test/` instead of the repo
root. Every path it built was wrong, so the perimeter library was never sourced and the
functions under test did not exist. With the path corrected the suite is 16/16 green. The
perimeter behaves correctly; only the baseline-branch assumption above is a real defect.

## Prompt hardcoding: the persona guard cannot see vendor or domain terms

Found 2026-08-07 while chasing why the VC guard kept deleting documentation-derived criteria.

Three client/vendor values were sitting in agent personas — prompt text sent to a model on
every run — and `prompts-carry-no-client-values.test.ts` passed the whole time:

- `guard-vocabulary-agent`: `"onEntryChange" is a useful blacklist term`. This is why criteria
  quoting that vendor callback were deleted for three consecutive runs: the guard had been
  TOLD to blacklist it, by example.
- `code-graph-detective`: `the business concepts (promo code, discount, amount, return trip,
  dispatch, report, line item), the data fields named (report.price.discount), and the
  domain/integration (Mozio)` — the entire domain vocabulary of a fare-discount bug, sent on
  every ticket. A plausible cause of the plan/execution MISMATCH warnings seen on unrelated
  stories, which remain untraced.
- `kb-change-reviewer`: `references a specific story ID (SKY-xxx, EPAM-xxx, etc.)`.

All three are fixed in the three persona files. **The gap in the guard is not.** Its `VOCAB`
is derived from the running project's CONFIG — codeline names, project key — so it cannot see
a vendor's API name, a domain noun left over from another ticket, or a tracker-ID prefix.

**Two rules were tried and REJECTED as too noisy to ship** (a permanently red test teaches
people to ignore it):

- tracker-ID shape `[A-Z]{2,6}-\d+`: matches `MPL-2` (the Mozilla licence) and epam-cli's own
  scaffolding story IDs (`INIT-001`, `DASH-001`, `SKILLS-001`), which are engine
  self-reference, not client leakage.
- terms derived from every project's canonical PRD: matches `Node`, `Express`, `Jira`,
  `Without`, `implementationOrder`, `phasesConfig` — ordinary prose and engine field names.

A workable rule probably has to distinguish the CLIENT project's vocabulary from the engine's
own, which the current layout does not cleanly separate. Until then this class is caught only
by reading the personas.

## The VC declaration standard applies to only one of the two producers

Added 2026-08-07 (run 20260807T015510Z).

`verificationCriteriaDetail` makes each criterion declare who observes it, on what surface,
and what precondition the test establishes. It works: that run produced four criteria, all
observable, with zero internal-surface claims and zero placeholder leakage — after two
earlier attempts (prose rules, then worked examples) failed to stop criteria asserting
internal structure and internal call paths.

But TWO agents produce criteria, and only one was taught the field:

    openspec   asked for detail = yes    returned detail = yes
    speckit    asked for detail = NO     returned detail = no

speckit runs second and its criteria win, so the declarations never reach the story
(`declarations persisted: 0`). The schema hint lives in the brownfield archaeology block,
which openspec receives and speckit's review prompt does not.

**Fix**: give speckit the same declaration requirement, so the declarations travel with
whichever agent's criteria survive. Note the persistence filter matches declaration to
criterion by exact text — fine within one payload, wrong across two, since the second agent
rewords. Persist from the payload that supplied the final criteria.

## A declared observer is not checked against what the criterion says

Added 2026-08-07, same run.

The declaration makes an unobservable criterion visibly unanswerable — "Given the Stack
initialization options object, it contains a live_preview property" has to name a person who
observes an options object. That is the point of the field.

It is not enforced. A model can answer `observer: tester, surface: the rendered page` for a
criterion that plainly asserts internal structure, and nothing compares the two. On the run
above it did not, but the field currently makes dishonesty VISIBLE, not impossible.

**Possible fix**: a deterministic consistency check — a criterion whose text asserts a config
object, query, argument or call while declaring a human observer is contradicting itself, and
that contradiction is decidable without any vocabulary of domain terms. Care needed: the
check must not become a word list, which is what the guard's vocabulary agent exists to avoid.

---

## DET-1 — Detective-before-roster: holistic parent + per-codeline children

**Status:** `partially built 2026-08-08` — the parent survey is in and grounds the roster.
What remains is listed under "Still to build" at the end of this entry.
**Source:** live roster runs 2026-08-07, and the design discussion that followed them.

### The problem it solves

The agent roster is minted from the ticket, the documents linked on it, and each codeline's
declared dependencies. It has no knowledge of what the code actually looks like. Two live
consequences:

- Briefs name files the model believes should exist rather than files that do. Run 2 proposed
  roles owning "the Stack initialization module" without anything having looked for it.
- Scope is taken from ticket labels. AMSD-2041 is titled `[GO, UP, MX]` with components
  `GO, Intake & Planning, MX, UP`, and nothing verified which codelines the work truly touches.

The detective already answers both questions — it grounds a story in the existing repository —
but it runs inside the per-story spec pass, i.e. AFTER the roster it should inform.

### Agreed design

Order: **Ingest (all codelines) → Detective (all codelines) → Roster (all codelines) → PAUSE
→ per-codeline processes.** Everything project-wide completes before lanes fork, so no two
lanes write the same artefact — the shared-state hazard that has bitten cross-lane work before.

**Parent (holistic) detective**, before the roster, sweeping every codeline. Two SEPARATE
outputs, and they must stay separate all the way through:
  1. survey findings — breadth, not fix-site depth: which codelines this work touches, which
     surfaces are involved;
  2. a recommendation for which per-codeline child detectives this estate needs.
A recommendation arriving in the same blob as evidence would be read as something discovered
about the code.

**The roster consumes both** and mints two classes: project engineers, and the per-codeline
child detectives the parent recommended. The pause then reviews the whole agent team,
investigators included — a bad detective brief corrupts everything downstream of it, and today
that would be invisible.

**Per-codeline processes** each run their own child detective. Isolation is structural: a lane
sees one repository, so no filtering rule has to be remembered at each consumption point.

**The parent then watches the children.** The children are isolated by design and therefore
nobody can see across them — yet these codelines share a stack. The parent is the only
vantage point from which "all three share this module" or "two found it and the third
returned nothing, so re-investigate" is visible. Recommended shape: one reconciliation pass
after the children complete, rather than continuous supervision — same value, far less
machinery, and it fits the sequential lane structure.

### Constraints that MUST hold if this is built

- **The parent may report ABOUT the investigation; never supply findings FOR a codeline it did
  not investigate.** Its output is a judgement on investigation quality and consistency, with
  its own schema, structurally unable to be read as a `fixSiteAnalysis` entry. Its remedy is
  *re-investigate*, never *substitute*. If parent output can become a fix site, every
  contamination route below reopens through the supervisor.
- **Contamination routes to keep closed** (all live today if findings are pooled naively —
  a finding carries `{file, function, reason, fix}` and no codeline):
  - a file found in codeline A entering codeline B's writer manifest (`manifestFileExcerpts`);
  - `checkFixSiteCoverage` passing on another repo's evidence — a fail-open gate;
  - `locationHint` pointing into the wrong repository;
  - reviewers rejecting correct work because a declared file is a phantom there.
- **Investigators must never write.** Already enforced (698b56f): minted investigators are
  registered in `project-investigators.json`, which the write perimeter does not read and
  story assignment never offers. An unrecognised `kind` is refused rather than coerced.
- **Capability comes from the seam, not the brief.** A minted detective must run at the
  detective invocation seam to receive CodeGraph tools and its response schema; invoked
  elsewhere it is a name that cannot investigate.
- **Three states, not two.** "Investigated and found nothing" is evidence that the story does
  not apply to that codeline. It must be distinguishable from "not investigated" and from
  "investigation failed", or an empty artefact reads as a clean bill of health.
- **An empty result must not block.** A codeline with no fix site proceeds as "nothing to do
  here"; otherwise adding a codeline to the estate breaks runs for stories that do not touch it.
- **The lane must consume, not re-run.** If the spec pass keeps invoking the detective itself,
  the run pays twice and the two investigations can disagree — roster grounded in one answer,
  manifest in another.

### Cost

Investigations scale with codelines x stories. One story across three codelines is three
before the pause; a ten-story phase is thirty. The parent's survey is the mitigation: it is
cheap by construction and identifies which codelines are genuinely in scope, so deep
investigation is skipped where the work does not reach.

### Already delivered from this design

- `698b56f` — implementer/investigator registry split; investigators cannot write or be assigned.
- `698b56f` — ingest persists `codeline-discovery.json` to `LOG_DIR`; all codelines are now
  visible to project-wide stages (verified: 149/103/93 declared dependencies across the three).

---

## ROSTER-1 — Build the implementer roster BY STACK, resolve the role per lane

**Status:** `pending` — unparked 2026-08-07 the same day, on evidence (see below)
**Source:** operator direction after reviewing the AMSD-2041 roster.

### The defect this fixes

`agentRole` is a SINGLE value on a story, but a spanning story executes in N lanes. AMSD-2041
carries `codelines: [nextgotransitcom, nextmetrolinxcom, nextupexpresscom]` and one
`agentRole: contentstack-preview-engineer`. That role is handed the work in all three lanes.

Today this is harmless — all three codelines are Next.js + TypeScript + Contentstack, so one
implementer is genuinely valid everywhere. It breaks SILENTLY the moment an estate mixes
stacks: a role briefed for a React codebase is handed work in a repository its brief does not
describe, and nothing objects. The story is assigned, the writer runs, the brief is simply
wrong about where it is.

"One roster for the project" was the right correction to "one roster from one codeline". It is
not the general answer.

### Agreed design

- **Group codelines by STACK**, derived from evidence already gathered: manifest type and the
  overlap between declared dependency sets. No stack, language or framework is named in engine
  code — the grouping falls out of what the repositories declare. (Current estate: 149 / 103 /
  93 declared dependencies, one group.)
- **Mint implementers per stack group** — not per project, not per codeline. This bounds roster
  size by number of stacks rather than by number of codelines or feature domains, which is the
  operator's stated constraint: "limit number of implementors to a stack".
- **Investigators stay per codeline.** A repository's layout is its own even when two
  repositories share a stack. (Already built — b037fe7.)
- **Resolve the implementer PER LANE, not per story.** `agentRole` becomes "the implementer for
  this codeline's stack". This is the real mechanical change and the part that does not exist
  today.

### Why it also settles the reassignment question

A reviewer currently cannot re-route a story to a different implementer; only an operator can,
by dropping `redirect-<story-id>.json` into LOG_DIR with a `targetAgent`. Adding a
reviewer-driven path would give one agent authority over another's work.

With a by-stack roster and per-lane resolution, the cross-stack mis-assignment becomes
impossible by construction — there is nothing for a reviewer to correct. What remains is the
right-stack/wrong-specialism case (SDK work handed to the routing engineer), which is a genuine
judgement call and is already covered by the operator redirect.

### Scope

Touches assignment (`assignAgentRoles`, `candidateRoles`), the write-gate check at the writer
seam, the writer seam itself, and `assert_phase_stories_have_roles` — all currently assume one
role per story. All are tested, so it is tractable; it is not a prompt edit.

### Why it was parked, and why that reason did not survive the day

Parked on the claim that it "changes nothing for this estate — all three codelines share a
stack, so a by-stack mint would produce exactly the roster that already exists".

That claim was wrong, and the roster reviewer disproved it within hours on its first live run.
The three codelines share a FRAMEWORK, not a stack. Their tooling genuinely differs, and five
of the reviewer's seven blocking findings are the same defect: a brief generalising a
convention across all three that only two of them actually use.

  - one codeline transpiles its tests with a different transpiler than the brief asserted
  - an import-ordering plugin is absent from one codeline, present in two
  - an environment-variable package is absent from one codeline, present in two
  - a class-name utility is absent from a DIFFERENT one of the three
  - a sitemap tool is absent from one codeline, present in two

Note the fourth: the odd-one-out is not always the same codeline. There is no single
"exception" to special-case — the estate genuinely has more than one tooling profile, which is
exactly the condition this item exists to handle. A roster minted per stack group would state
each convention only for the codelines that hold it.

The remaining two findings were roster COHERENCE rather than stack divergence — two implementer
briefs claiming the same files, so neither is accountable — which no dependency grouping fixes
and which the reviewer catches instead.

Unparked on that evidence. The reviewer makes the cost of NOT doing this visible every run;
it does not remove it.

---

# Architectural issues — found 2026-08-07, three-codeline run 20260807T212714Z

That run reached the lanes for the first time: roster clean on the first review cycle, three
lanes forked, per-codeline investigators invoked, 6 verification criteria per lane. Two lanes
paused cleanly before the writer; the metrolinx lane was halted by the spec review gate at
quality 0.68 against a 0.7 bar. These are the structural causes found while diagnosing it.

Priority order agreed with the operator. NOTE: the roster pause and writer pause are temporary
scaffolding and will be REMOVED once the pipeline stabilises — which sharpens ARCH-2 and
ARCH-3 considerably, because today they cost a pause and afterwards they will decide whether a
client codeline receives code while its siblings have already merged.

## ARCH-1 — a per-lane fact read from a singular field  `in progress`

The detective resolves which investigator to use from `story.codeline`, the story's PRIMARY
codeline. For a story spanning three codelines that value is the same in every lane, so all
three lanes used the first lane's investigator — briefed on a different repository's layout,
conventions and module structure. Exactly the contamination the per-codeline split exists to
prevent, through a door left open.

  log: 4 x "detective for gotransit = gotransit-investigator", never the other two
  story.codeline  = "gotransit"                           (primary)
  story.codelines = [gotransit, upexpress, metrolinx]      (the lanes that run)

The same shape produced two other defects: `agentRole` singular while a spanning story runs in
N lanes (fixed b62f90b), and `project.outputDir` vs `outputDirs` (which produced a wrong
"1 lane" claim in an operator-facing report). A singular field that is right for exactly one
lane in three is a trap, not a convenience.

FIX: the per-lane PRD is the seam. `_filtered_prd` already writes `<codeline>-prd.json` per
lane and copies stories through unchanged; stamping the lane's own codeline onto the stories it
emits makes `story.codeline` TRUE within that lane, and every consumer — present and future —
becomes correct without knowing lanes exist. Plus the detective preferring `EPAM_CODELINE`, as
the writer seam already does.

## ARCH-2 — a model-invented scalar wired to a hard gate  `pending`

`qualityScore` is a bare number the reviewer emits. Nothing constrains its derivation and
nothing checks it, and story-guards.sh compares it against SPEC_REVIEW_MIN_QUALITY (0.7).
metrolinx scored 0.68: a 0.02 margin on a number with nothing behind it.

The code's own comments record the instability — lanes at 0.78/0.72/0.65 with the gate stopping
ones ABOVE the bar, and elsewhere every lane sailing through at 0.45. That is archaeology of
people fighting the number rather than what it measures.

Everything else a model asserts here is now either structurally constrained (enums, schema-bound
output, required fields) or independently re-checked (roster findings are re-run against the
repository). This is neither, and it cannot be: "0.68" is not a claim about anything checkable.

FIX: gate on the reviewer's SPECIFIC objections — `flags[]` and `verdict`, which are enumerable
and verifiable the way roster findings now are. Keep qualityScore as telemetry. If a numeric bar
is wanted, derive it from something countable (flag count by severity), not from a model
compressing judgement into a float whose third decimal decides delivery.

## ARCH-3 — lane independence ends at the first failure  `pending — operator decision`

Lanes have their own log dir, PRD, worktree, investigator and writer, run in parallel, and the
code notes "no lane is upstream of another". Then the outcome collapses to one exit code: one
lane's gate decision failed a run in which two lanes had cleared.

Consequences: partial success cannot be acted on (there is no per-lane resume — the checkpoint
is per run); and "failed" reads identically to "the pipeline broke" when it means "one of three
lanes was blocked by a quality gate".

Once the pauses are removed this stops being cosmetic: the two cleared lanes will have written
and MERGED code before the third lane's gate fails, so the run aborts with two client codelines
already modified.

DECISION NEEDED: is a story spanning codelines all-or-nothing, or may lanes land independently?
Both are defensible — partial delivery of one change across an estate may be worse than none —
but it must be stated as policy rather than implied by an exit code.

## ARCH-4 — cross-run learning is dead because the KEY is regenerated  `pending`

KB-<role>.md survives the per-run reset by design. But the roster is ephemeral and the mint
invents a NEW role name each run for essentially the same agent, so the next run looks up a KB
file that does not exist and starts blank. Twenty-odd KB files have accumulated, each holding
what one run learned, none reachable by any later run. The store persists; the address does not.

AGREED FIX: key agent knowledge on the CODELINE, which is stable, discovered, already the
investigator key, and the subject of most durable learning ("this codeline's tests are
transpiled with X", "the SDK init lives here"). Does not cover project-wide implementer lessons;
that gap is accepted for now.

## ARCH-5 — the roster mutates after it is set  `pending`

Operator direction: after the mint, the roster is SET. Today the self-heal `skill` target
appends into profiles.json, claiming in its own comment that "future runs inherit this
learning" — they cannot, because pre-run-reset restores profiles.json from its original at the
start of every run. A second write path (the syntax-class escalation) does an unlocked
read-modify-write on the same file while the main path is properly flocked.

FIX: nothing writes profiles.json after the mint. Self-heal guidance still reaches the retry
prompt in flight, which is the part that helps. Durable lessons go to the KB under ARCH-4's
key. This also stops profiles.json drifting from its original, which has broken the same
invariant test repeatedly.

## ARCH-6 — one script serving two roles  `pending`

Lanes re-invoke `bash "$0" --reset`, so every stage must know whether it is the parent or a
lane (JIRA_CODELINE_RUN), and getting it wrong is invisible. This is why resume was evaluated
after a dispatch that exits and never ran on a Jira project (fixed d7f2a65), why the roster
reset needed a top-level guard, and why the writer pause fires once per lane rather than once.
Project-wide orchestration and per-lane execution are different programs sharing an entry point.

## ARCH-7 — correction is total, not incremental  `pending`

A single blocking roster finding clears the ENTIRE roster and re-proposes, discarding good
briefs with the bad one. Cycle counts have swung 1->9 and 10->0 between runs. Repair should
touch the brief that was wrong.


## ARCH-6 — one script, two roles: CLOSED 2026-08-07

The parent/lane role is now derived in one place (`orch_role`/`is_parent`/`is_lane`, top of
run-agent-orchestration.sh) and `JIRA_CODELINE_RUN` is read nowhere else. A guard test
(`orchestrator-role-is-explicit.test.ts`) fails if a new site re-tests the raw variable.

Fixed en route: the parent and its FIRST lane derived the same control-plane port. The
synthesizer sets `project.outputDir = outputDirs[0].path`, so the parent resolved to codeline
index 0 — the same index the first lane resolves to from its filtered PRD. `start_control_plane`
kills whatever holds the port before binding, so the first lane killed the parent's control
plane and took it; the lane's cleanup then stopped it entirely, leaving the port dead while the
parent still held a PID it believed was live. The parent now reserves the base port and lanes
are offset past it. `CODELINE_NAME` was also read but never set anywhere — lanes export
`EPAM_CODELINE`, which the resolver now prefers.

NOT done, deliberately: the script was not split in two. The shared body is what gives a lane
the identical pipeline, and splitting it would duplicate 11k lines to remove a condition that
is now named and enforced.


## DET-1 progress — 2026-08-08

### Built

- `surveyEstate()` (spec-mode-runner.js) — the holistic pass that runs BEFORE the roster,
  through runAgentForJson, so it inherits ladder/retry/self-heal/timeout/cost like every other
  agent. Seam `estate-survey` in invocation-profiles.json, bound to HIGHEST.
- Two structurally separate outputs: `codelines[]` (evidence about the estate) and
  `recommendedInvestigators[]` (a recommendation about the TEAM). They stay separate through
  the sanitizer AND into the mint prompt, where each is labelled for what it is.
- Four states, not two: `in_scope` / `no_work_found` / `not_investigated` / `failed`. A
  codeline offered but unreported is filled in as `not_investigated` — an absent entry must
  never read as a clean bill of health.
- `sanitizeSurvey()` enforces the parent/child boundary IN CODE: any fix-site-shaped key
  (file, files, function, fix, patch, locationHint, lineRange, diff) on a survey entry is
  stripped and the breach recorded; a report on a codeline not in scope is discarded. A prompt
  is a request, and this is the one thing that must not depend on compliance.
- Persisted to `estate-survey.json` at generation time; the mint consumes it.
- An empty, broken or failed survey never blocks the run — that is the state the roster was
  minted in until now.

### Still to build

- **The lane must CONSUME, not re-run.** The per-story spec pass still invokes its own
  detective. Today the survey grounds the roster and the lane investigates independently, so
  the run pays twice and the two investigations can disagree — roster grounded in one answer,
  manifest in another.
- **The reconciliation pass.** The parent watching the children after they complete: "all three
  share this module", "two found it and the third returned nothing, so re-investigate". Same
  constraint applies — its remedy is *re-investigate*, never *substitute*.
- **Skipping deep investigation for `no_work_found` codelines.** The survey now reports it; the
  lane loop does not yet act on it. This is the cost mitigation, so it matters: investigations
  otherwise scale as codelines x stories.

## Architectural issues found at pause 1, 2026-08-08 (evidence-based)

Ordered by how much they impede getting to correct code. #1 and #2 fixed same day; the rest
are open and recorded with their evidence so the next person does not re-derive them.

### FIXED — ORD-1: derived artifacts were never invalidated when their input changed
Assignment ran BEFORE the roster review/correction loop. Stories were assigned from the
proposed roster; the reviewer indicted three agents, the correction replaced them, and the
assignments were never revisited — all three lanes pointed at a role with no profile. ARCH-7's
targeted correction is what made it reachable: a wholesale re-mint fails loudly, a surgical
replacement leaves the roster healthy-looking and only the assignments stale. Assignment now
runs after the loop, plus a deterministic check that every assignment names a role in the
settled roster.

### FIXED — ORD-2: the survey's leads were laundered into facts
The replacement brief opened "CRITICAL FACTS — verified by prior investigation:" and restated
survey findings, one of which was false. Provisional evidence GAINED authority as it
propagated. The survey now reaches the mint explicitly as leads, and briefs are forbidden from
restating it as established.

### OPEN — EVID-1: absence of evidence is reported as evidence of absence  ← highest value
Run 3's survey reported nextgotransitcom had "no Contentstack references in its own source".
Ground truth: next.gotransit.com/src/services/contentstack.ts exists, 20+ source files match.
A failed search and a true negative are indistinguishable to the agent, and run 2 flagged the
same anomaly honestly ("the search tool did not traverse as expected") while run 3 asserted
absence. DET-1 makes no_work_found a TRUSTED state, so this is load-bearing: had it said
no_work_found, a codeline needing work would have been skipped with "evidence".
FIX: corroborate deterministically. A manifest declaring a package while the search returns
zero source references is a detectable contradiction — force re-investigation, never conclude.
Same blind spot applies to the per-lane detective, so fix it once, below both.

### OPEN — KB-1: the KB has two addressing schemes that never meet (ARCH-4 is half-done)
mergeProjectAgents seeds KB-<role>.md; _kb_file_for_story reads/writes KB-<codeline>.md.
Evidence: 36 KB files on disk, ALL role-keyed, ZERO codeline-keyed. Every seeded brief is
write-only, and role names are minted fresh each run so they accumulate forever
(KB-contentful-cms-engineer.md survives from the vendor-hallucination run). Cross-run learning
— the one thing meant to persist — persists nothing.

### OPEN — ID-1: codeline identity is an unstable derived label
logs/lanes/ holds both gotransit and nextgotransitcom: the same repository under two names from
two runs. Discovery scores repos deterministically then hands close calls to an LLM
("top1/top2=1.33 (CLOSE — genuine ambiguity, LLM judgment matters)"), and the label varies. KB
files, lane log dirs, byCodeline, branches and checkpoints all key off it, so a resume can
target a differently-named version of the estate than the pause reviewed. The repo PATH is
stable; the identity we key on is not. KB-1 cannot be fixed properly until this is.

### OPEN — FAILOPEN-1: a verdict derived from an empty collection reads as clean
Fixed for the roster reviewer (empty output → review_failed, not sound). The SHAPE is generic:
any gate that derives a verdict from a collection treats "nothing ran" as "nothing wrong".
Sweep every gate rather than waiting to be bitten again.

### OPEN — ART-1: run artifacts are not run-scoped
roster-review.json is written once at the end into a shared logs dir. Mid-run it still holds
the PREVIOUS run's verdict, and was very nearly reported as current. Stamp artifacts with
ORCH_RUN_ID, or refuse to read one whose run id is not this run's.

## Open after 2026-08-08

### TEST-1 — jira-ingest-project-identity flakes under full-suite load
Failed 4× inside `vitest run` (once as a 120s timeout with `r.prd` null), passed every time in
isolation (42s for all five cases). Real LLM-backed ingest with a 120s per-case budget that
does not get CPU under full-suite parallelism. Give it a serial lane or a budget matching a
loaded machine — a test that fails for reasons unrelated to its subject trains people to ignore
the suite.

### KB-2 — a relabelled codeline fragments its own store
KB-1 is fixed: seed and read now agree on one normalised, codeline-keyed address, verified by
executing the JS and bash implementations against each other. What normalisation CANNOT fix is
ID-1: the same repository has been labelled `gotransit` on one run and `nextgotransitcom` on
another, and those are different stores. The KB will now accumulate — and will fragment the
first time discovery relabels a repo. The stable identifier is the repository itself (path or
origin URL), not the label an LLM chose for it this run.

### WRITE-1 — an unexplained write to a client file during the spec phase
Run 20260808T205736Z (first resume): `content.mock.ts` in next.metrolinx.com was rewritten
during the spec pass — 106 lines of captured fixture replaced with 5 lines of invented
placeholder, and the export renamed. No commit, no activity-log entry, and Step 8 (the writer)
never ran. Restored by hand; a live repo-write monitor on the following run caught nothing, so
it did not recur and the cause is UNKNOWN, not fixed. The perimeter permitted it because that
codeline was already on its story branch, where tracked files are unlocked by design — so the
window exists for any agent with Bash between branch creation and the writer.

---

## Writer-Phase Test Coverage Gaps (TEST-GAP-1)

Audit of 2026-08-09, after two live defects shipped in code the suite appeared to cover.
Counts are non-comment mentions of the function across `test/unit/orchestration/`.

**The count did not predict the risk.** `verify_story_deliverables` had 25 mentions and still
shipped the union-vs-per-codeline bug, because nothing asserted on its jq SELECTOR — only on the
behaviour around it. `_render_technical_notes` had ONE mention and carried the defect that told
gotransit's writer to build a metrolinx-only component. Treat the zero and near-zero rows as the
starting point, not the whole job: the real gap is what the tests assert, not which functions
they name.

### Zero coverage

| Unit | Why it matters |
|---|---|
| `compute_token_cost` | Real cost tracking is the #1 priority; nothing verifies the arithmetic |
| `normalize_provider_json` | Has a KNOWN past defect (empty `.result` dropped) with no regression test |
| `update_monitor_status`, `log_to_monitor` | Observability is priority #2; dashboard state is unverified |
| `resolve_dynamic_constitution` | Injects the constitution into every agent invocation |
| `resolve_codex_model_settings` | Per-model overrides; silent misroute is plausible |
| `get_next_story`, `get_story_phase`, `get_phase_stories`, `get_phases`, `list_phases` | Story selection and ordering |
| `get_story_dependencies`, `story_exists`, `get_story_priority` | Dependency gating |
| `check_prerequisites`, `check_plan_mode_required` | Pre-flight |
| `get_next_kb_id`, `update_agents_file`, `increment_iteration` | KB and roster mutation |
| `get_project_context`, `show_status`, `dry_run` | Lower risk |

### Thin coverage (≤12 mentions) on writer-critical units

| Unit | Mentions | Risk |
|---|---|---|
| `_render_technical_notes` | 1 → now 12 | FIXED 2026-08-09 (cfab98a) |
| `_rejection_repeat_check` | 7 | Decides whether a retry is unwinnable |
| `record_story_outputs`, `build_generator_prompt` | 8 | Writer-output manifest; generator prompt |
| `append_cost_record` | 9 | Cost ledger write path |
| `run_anti_pattern_check`, `run_named_import_check`, `run_mock_completeness_check` | 9–10 | Gates that can fail open |
| `_scope_lock`, `_vendor_lock` | 10–12 | Write perimeter |

### Residual defect, not yet fixed

`unresolved` paths are rendered into the WRITER prompt. gotransit's prompt still names
`ContentstackQuote.tsx` once via its own `unresolved` list — spec-pass diagnostics meaning "this
declared path does not resolve in this repo". The deliverable gate ignores it, so it is no longer
story-fatal, but naming an unresolvable path in a writer prompt invites the writer to create it.
Proposal: exclude `unresolved` from the writer prompt (keep it in the spec artefacts).

---

## Prompt Budget Is Measured Against The Wrong Thing (PROMPT-BUDGET-1)

Live AMSD-2041, 2026-08-09. The writer's prompt was 86,809 chars against a 16,000 threshold.

`claude.sh` triggers on TOTAL prompt size but trims only `COORDINATOR_PROMPT_AMENDMENT` — the
accumulated guidance from prior attempts. It cannot touch anything else.

| Component | Chars | Trimmable |
|---|---|---|
| Injected file contents ("do NOT ReadFile these") | 34,510 (39%) | no |
| Root Cause Analysis (authoritative) | 12,670 | no |
| BLOCKERS | 6,056 | no |
| Project Tools | 5,200 | no |
| Coordinator guidance | remainder | YES — the only thing cut |

Three consequences:

1. It fired on ATTEMPT 1 (82,276 chars), when there was almost no accumulated guidance. The
   trigger had nothing to do with what it cut.
2. It structurally cannot do what its comment claims ("bound unbounded prompt growth"): after
   trimming to 3 sections the prompt is still ~70K, because 39% is file contents. It will fire on
   every attempt of every brownfield story with real files and never approach 16,000.
3. Guidance pays for the files' size — making the exact failure the config comment warns about
   (a run repeating a mistake five retries after being corrected) MORE likely on large files.

The 16,000 default was tuned when prompts were guidance-dominated. Deterministic file injection
was a later, deliberate choice to save ReadFile round-trips, and the two have never been
reconciled.

**Proposed fix:** budget per component instead of one global threshold. Trigger the guidance trim
on GUIDANCE size; give file injection its own budget (rank by relevance to the fix sites, cap the
total, let the agent ReadFile the remainder). Both budgets belong beside `thresholdChars` in
orchestrations/config/spec-mode-defaults.json — no new literals.

**Interim:** `EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=0` disables trimming so no guidance is
discarded. Used for the 2026-08-09 clean-run attempt.

---

## Agent Tooling: grep vs CodeGraph, and where the tokens actually go (TOKEN-VISIBILITY-1)

Review of 2026-08-09, asked as "review all agents' use of grep versus giving them code graph and
schema/pydantic to reduce token consumption gaps".

### What already exists and is wired

`codegraph_query` (orchestrations/plugins/codegraph-tools.js) is a real static symbol index with
seven modes — explore, query, callers, callees, impact, helpers, show — and its description tells
the agent to prefer it over grepping and to call it iteratively. It is discovered per codeline
via `project_tool_names()` and reaches allow-lists dynamically, verified by execution: the
gotransit codeline exposes nine plugin tools including `codegraph_query`, `resolve_test_file`,
`check_anti_patterns`, `dependency_contract` and `scan_secrets`. The reviewer and the writer are
both told the tools exist AND permitted to call them.

So the capability is not missing. What is missing is any way to know whether it is used.

### Finding 1 — tool usage is invisible (this is the blocker for everything else)

`agent-activity.jsonl` records `agent, model, phase, provider, story_id, type, detail, timestamp`
and NOT the tool name. Nothing in the logs distinguishes an agent that ran one `codegraph_query`
from one that ran forty `search` calls, and per-tool token attribution is impossible. Cost
tracking is the stated #1 priority and observability #2; this is the gap that makes both
unanswerable for tool spend. Fix before tuning anything: emit tool name + token cost per call
into the activity log, then measure.

### Finding 2 — the prompt pre-pays for reading, then forbids it

The writer prompt injects every declared file verbatim under "## Existing File Contents
(injected once, deterministically — do NOT ReadFile these)". Live AMSD-2041: 34,510 of 86,809
chars, 39% of the prompt, re-paid on every one of up to 8 attempts.

That block exists for a good reason (2026-07-23: an agent told "do NOT investigate" invented a
non-existent `@eps/utils` import across 8 attempts at every model tier). But it pays the full
read cost up front for 12 declared files whether the writer needs them or not, and it is exactly
the cost `codegraph_query` exists to avoid. The two mechanisms solve the same problem and are
both switched on.

Worth measuring once Finding 1 is fixed: injection at a lower line budget plus an explicit
"query the graph for anything not shown" directive, against the current all-up-front injection.
The per-file budget is now configurable (`existingFileInjection.maxLinesPerFile`, env
`EPAM_EXISTING_FILE_MAX_LINES`), so this is an experiment rather than a code change.

### Finding 3 — structured output exists at the invocation seam, not for tools

Agent I/O is schema-bound via the invocation gateway (`agent-output-schema.js`,
invocation-profiles.json), which is where the Pydantic-style contract already lives. Tool
RESULTS, by contrast, come back as prose the model re-reads and re-summarises. `codegraph_query`
returns formatted text rather than a typed record, so a caller wanting one field pays for the
whole rendering. A typed result shape for the high-traffic tools is the natural next reduction —
but again, only measurable after Finding 1.

### Not a finding

`_EXISTING_FILE_MAX_LINES = 400` WAS a literal inside build_implementation_prompt and is now
configuration, since it is the single largest term in prompt size and an operator could not
reach it. Fixed 2026-08-09.
