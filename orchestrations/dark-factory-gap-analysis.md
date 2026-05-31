# Dark Factory / Lights-Out Autonomous Software Engineering — Gap Analysis

**Date**: 2026-05-31  
**Scope**: Open-source projects in autonomous/multi-agent software engineering vs. epam-cli  
**Prepared by**: Research pass over GitHub repositories, documentation sites, and arXiv papers  
**Covers**: SWE-agent, OpenHands, AutoGen/MAF, CrewAI, MetaGPT, Aider, Plandex, Cline, AutoGPT, LangGraph, OpenAI Agents SDK, Continue, GPT-Engineer, TaskWeaver, kyegomez/swarms, OpenAI Swarm, openswarm-ai/openswarm, unclebob/swarm-forge, daveshap/HAAS, ruvnet/ruflo

---

## 1. Executive Summary

The autonomous software engineering landscape has bifurcated into two camps: **single-agent interactive tools** (Aider, Cline, Plandex) that augment a human developer sitting at the terminal, and **orchestration engines** (MetaGPT, CrewAI, OpenHands, SWE-agent) that attempt end-to-end lights-out execution. As of mid-2026 the leading single-agent tools are more mature and polished than most orchestration engines, but none of them deliver what epam-cli provides: a *configuration-prime*, PRD-driven, phase-gated, cost-estimated, multi-specialist pipeline that runs without human presence. epam-cli's closest architectural peers — MetaGPT and OpenHands — both lack its production-hardening layer (phase-cost variance, CPA estimation, structured review cycles, worktree isolation). The most significant gap going the other direction is that several projects now offer richer benchmark-validated context management, browser-native execution environments, and out-of-the-box vector RAG, none of which epam-cli currently ships.

---

## 2. Per-Project Summary Table

| Project | Stars (approx) | Architecture | Key Differentiators | Notable Gaps vs. epam-cli |
|---|---|---|---|---|
| **SWE-agent** (Princeton NLP) | ~14k | Single agent with ACI; RetryAgent wrapper for sequential retries | YAML-configurable; best-in-class SWE-bench scores; Docker sandbox; custom Agent-Computer Interface | No multi-agent pipeline; no PRD/story concept; no phase gates; no cost estimation; no spec-gen phase; no audit JSONL |
| **OpenHands / OpenDevin** (All-Hands AI) | ~43k | Multi-agent SDK (CodeActAgent + DelegatorAgent + BrowsingAgent); sandboxed Docker runtime | REST API + GUI; CodeAct unified action space (Python as tool); Slack/Jira/Linear integrations; enterprise Kubernetes deploy | No PRD-centric config; no per-story cost estimation/variance; no phase-gate escalation; no spec coordination phase; observability requires external wiring |
| **AutoGen** (Microsoft — maintenance mode) | ~42k | Layered: Core (event-driven, distributed), AgentChat (multi-agent), Extensions | Multi-language (Python + .NET); distributed runtime via gRPC; AssistantAgent as tool; MCP support | Maintenance mode; no PRD/story spec; no phase gates; no cost estimation model; no worktree isolation; being superseded by MAF |
| **Microsoft Agent Framework (MAF)** | N/A (new) | Graph-based orchestration; YAML declarative agents; OpenTelemetry built-in | Production-grade OTel tracing; sequential/concurrent/handoff/group graphs; Foundry-hosted deploy; DevUI | No PRD-driven story pipeline; no per-story CPA; no spec coordination agents; infrastructure-layer product, not code-generation focused |
| **CrewAI** | ~52k | Crews (role-based autonomous teams) + Flows (event-driven state machines); YAML-first config | Hierarchical process with manager validation; task guardrails with Pydantic output types; async execution (`akickoff`); `crewai test` scoring; LanceDB memory | No PRD concept; cost control is only `max_rpm` rate-limit; no phase gates or cost-variance escalation; testing is LLM-scored (1-10), not binary pass/fail gates; no worktree isolation |
| **MetaGPT** | ~56k | Software-company-as-SOP multi-agent (PM → Architect → Engineer flow); Python SDK + CLI | PRD-from-one-liner; structured SOP pipeline that produces user stories, design docs, APIs, code; AFlow agentic workflow generation | No per-story cost estimation; no phase-gate escalation; no configurable specialist agent profiles; no JSONL audit trail; no worktree parallelism |
| **Aider** | ~35k | Single interactive agent; optional Architect+Editor dual-model split | Auto-lint/test-fix loop; YAML config; prompt caching; `--watch-files` for IDE integration; highest real-world developer adoption | No multi-agent; no PRD/story/phase model; no cost estimation or variance; no pipeline orchestration; lights-out via scripts only, not native |
| **Plandex** | ~12k | Terminal-based plan executor; version-controlled plan branches | 2M token context; tree-sitter syntax validation; plan branching (explore variants); adjustable autonomy levels; multi-model packs | No multi-agent; no cost estimation model; no structured review agents; no phase gates; server required for team sharing |
| **Cline** | ~33k | VS Code + CLI + SDK + Kanban multi-agent board; MCP integrations | Cron-scheduled agent runs; `.clinerules` config; team coordinator→specialist delegation; Plan/Act toggle; 200+ model support via OpenRouter | No PRD/story concept; no cost estimation; no phase-gate escalation; no structured spec phase; cost tracking not built-in |
| **Smol Developer** | ~11k (archived) | Two-stage: plan → generate; Modal parallelization | Parallelized file generation via Modal; Agent Protocol REST API | Archived/inactive; single-pass generation, no review cycle; no quality gates |
| **AutoGPT** | ~172k (historical) | Platform with block-based agent builder; continuous server runtime | External trigger integration; performance dashboard; Agent Protocol standard; self-hosted or cloud | Block-based, not code-generation-centric; no PRD; no phase gates; heavy SaaS orientation |
| **LangGraph** (LangChain) | ~11k | Graph-based stateful agent orchestration; Pregel-inspired; LangSmith observability | Durable execution with failure resume; human-in-the-loop state inspection; LangSmith integrated tracing | Infrastructure layer, not a software-engineering pipeline; requires significant custom wiring to become a dark factory |
| **OpenAI Agents SDK** | ~10k | Lightweight Python: Agents + Handoffs + Guardrails | Built-in tracing; input/output guardrails; sandbox agents; session memory | No PRD; no phase gates; no cost estimation; no spec generation; single LLM provider |
| **Continue** | ~33k | AI-as-CI: markdown-defined agent checks run as GitHub status checks | PR-gating with AI-generated diffs; source-controlled check definitions; IDE + CLI | Code review CI integration only — not a full pipeline; no spec/implementation flow |
| **GPT-Engineer** | ~55k (archived Apr 2026) | CLI: prompt file → full codebase; parallelized via Modal | Natural language to full repo in one pass | Archived; no review cycle; no quality gates; no multi-agent |
| **TaskWeaver** (Microsoft) | ~6k | Code-first analytics agent; multi-role with plugin orchestration | Stateful code execution history; built-in code verification before execution; rich Python data structures | Scoped to data analytics, not general software engineering; no PRD |
| **kyegomez/swarms** | ~7k | 8 named swarm topologies (Sequential, Concurrent, Hierarchical, MixtureOfAgents, GraphWorkflow, AgentRearrange, GroupChat, HeavySwarm) + SwarmRouter | Runtime topology selection; AutoSwarmBuilder generates specialists from task description; MCP + X402 payment rail; multi-provider | No PRD/story/AC; no phase gates; no cost budgeting; no TypeScript; Python-only |
| **OpenAI Swarm → Agents SDK** | ~27k | Two primitives (Agent + handoff) → production: Agents, Guardrails, Sandbox Agents, Sessions, Tracing, HITL | Guardrails as synchronous first-class primitives; Sandbox Agents (container-isolated); built-in session history compaction; 100+ LLMs via LiteLLM | No PRD; no phase gates; no cost estimation; no spec generation pipeline |
| **openswarm-ai/openswarm** | ~700 | Electron desktop app; spatial infinite-canvas for parallel Claude Code agents; each agent in its own worktree + branch | Unified HITL approval panel across all parallel agents; message branching (fork at any prior turn); spatial layout with pan-and-zoom | No PRD; no automated gates; no cost tracking; UI-dependent, not CI-scriptable |
| **unclebob/swarm-forge** | ~700 | Pure shell/tmux; config-driven topology via swarmforge.conf; Architect→Coder→Reviewer default; shared constitution.prompt | Multi-backend per role (claude, codex, copilot, grok); shared constitution injected as system-prompt prefix; file-based inter-agent messaging | No PRD; no quality gates; no cost tracking |
| **daveshap/HAAS** (archived) | ~3k | 3-tier hierarchy (SOB → Executive → Sub-agents); RBAC privilege inheritance | Formal privilege model (agents cannot exceed parent scope); SOB ethical governance layer | Archived Aug 2025; no spec/PRD; no test gates; research prototype only |

---

## 3. Capabilities They Have That epam-cli Likely Lacks

### 3.1 Execution Sandbox Isolation
**OpenHands, SWE-agent** both run all agent code in Docker containers with clean-slate environments per task. epam-cli runs agents in git worktrees on the host filesystem. This means: (a) no protection against runaway agents deleting host files, (b) no clean environment for reproducible builds, (c) no ability to reset environment between retries. Docker-sandbox execution is the standard for any production dark factory.

### 3.2 Browser/Web Agent Capability
**OpenHands** ships a `BrowsingAgent` that can navigate URLs, fill forms, and interact with web UIs as part of task execution. **Cline** also has browser automation. epam-cli has no browser execution capability — agents cannot visit documentation, test a web app's UI, or interact with external services beyond HTTP fetch.

### 3.3 Benchmark-Validated Performance (SWE-bench)
**SWE-agent** and **OpenHands** publish SWE-bench Verified scores (SWE-agent v1.0 + Claude 3.7 reached top open-source scores; OpenHands publishes comparable numbers). epam-cli has no standardised benchmark evaluation and no mechanism to run SWE-bench scenarios. This makes comparative claims about quality impossible to substantiate.

### 3.4 Plan Versioning and Branching
**Plandex** stores plans as versioned trees with branching support — agents can explore multiple implementation paths, compare results, and roll back. epam-cli's prd.json is a flat append-only document. There is no native plan-branching or variant exploration; stories either complete or fail.

### 3.5 Vector RAG / Semantic Asset Retrieval
EPAM-019 (RAG Asset Discovery) is implemented as keyword-only TF-IDF matching against a static `.epam/assets.json` file. **CrewAI** ships LanceDB-backed semantic memory with cosine + recency scoring. **OpenHands** uses embeddings for its memory module. **Continue** uses Markprompt. Real semantic retrieval is a gap.

### 3.6 External Integration Callbacks (Jira, Linear, Slack)
**OpenHands Cloud** and **Cline** support triggering agents from Slack messages, Jira issue events, or Linear tickets. epam-cli has no inbound webhook or issue-tracker integration — the PRD must be manually edited to start a run. This limits dark-factory operation to pre-planned batches.

### 3.7 Multi-LLM Model Routing Within a Single Story
**Aider**'s Architect+Editor pairing and **CrewAI**'s per-agent model assignment allow different models within the same task execution (e.g., reasoning model for planning, fast/cheap model for file edits). epam-cli assigns a model per story, but within a story execution all turns use the same model. There is no intra-story model switching or automatic planner/executor split.

### 3.8 Continuous / Event-Triggered Runs
**Cline** supports cron-scheduled agent runs that persist across terminal sessions. **Continue** runs as a CI status check on every PR. epam-cli is batch-only: run-agent-orchestration.sh is manually invoked. There is no daemon mode, no cron integration, and no external event trigger.

### 3.9 Human-in-the-Loop State Inspection and Resumption
**LangGraph** and **OpenHands** both provide facilities to pause execution, inspect current agent state, edit it, and resume from an arbitrary checkpoint. In epam-cli, resumption means re-running a story from scratch; there is no mid-story state freeze/edit/resume capability.

### 3.10 OpenTelemetry / Standardised Tracing
**MAF**, **CrewAI** (via OpenLit), and **LangGraph** (via LangSmith) emit OpenTelemetry traces. epam-cli uses Langfuse tracing (non-standard in the broader ecosystem), which requires running a self-hosted Langfuse server. OTel compatibility would allow plugging into any CNCF observability stack (Jaeger, Tempo, Honeycomb, Datadog) without custom instrumentation.

### 3.11 Runtime Topology Selection (from kyegomez/swarms)
**kyegomez/swarms** `SwarmRouter` selects the optimal agent topology at runtime based on task complexity (Sequential for simple linear tasks, MixtureOfAgents for parallel synthesis, HierarchicalSwarm for decomposable work). epam-cli commits fully to a linear phase progression declared in `implementationOrder` — there is no routing layer that adapts topology to actual story complexity.

### 3.12 Guardrails as Synchronous Primitives (from OpenAI Agents SDK)
The OpenAI Agents SDK injects input and output guardrails as synchronous validation at every agent boundary — malformed or dangerous outputs are rejected before the next turn begins. epam-cli's equivalent (sast-sentinel, spec-validator, fuzz-weaver) are post-hoc review agents that run after the implementation phase completes, meaning wasted tokens if an agent produced garbage across many turns.

### 3.13 Unified HITL Approval Surface (from openswarm-ai/openswarm)
**openswarm** presents all parallel agents' tool-approval prompts in a single consolidated UI panel. When epam-cli runs multiple agents in parallel (worktrees), approval requests arrive in separate tmux panes — the operator must watch N windows simultaneously. A unified approval surface reduces cognitive load in true parallel operation.

### 3.14 RBAC Privilege Inheritance (from daveshap/HAAS)
**HAAS** agents inherit privileges from their spawning parent and cannot exceed parent scope. epam-cli currently grants all agents full tool access by default — there is no formal privilege model that restricts, e.g., a review-agent from writing files or a test-engineer from modifying source.

### 3.15 Constitution-as-System-Prompt Prefix (from unclebob/swarm-forge)
**swarm-forge** injects a shared `constitution.prompt` as a system-prompt prefix for all agents — behavioral rules shared across the entire swarm. epam-cli's `KB.md` fills a similar role but is pulled on-demand by agents rather than injected at invocation time, meaning an agent that doesn't read it misses the rules.

---

## 4. Capabilities epam-cli Has That Most Lack (Strengths)

### 4.1 PRD-as-Configuration-Prime
No other open-source project treats a structured JSON product requirements document as the sole source of truth for a complete software build pipeline. MetaGPT comes closest but generates its PRD-equivalent at runtime from a one-liner; it is not an externally-authored, version-controlled specification. epam-cli's prd.json drives everything: story routing, agent assignment, phase ordering, dependency resolution, cost estimation, and gate logic.

### 4.2 Phase-Gate Escalation with Cost Variance
`check-phase-gate.sh` implements a tiered variance model: within-band auto-approves, warn-band logs but proceeds, escalate-band hard-blocks with exit code 2. No other surveyed project has a per-phase cost-variance gate that blocks pipeline execution when actual spend deviates from pre-estimate by a configurable threshold (default 150%). This is unique infrastructure-grade FinOps enforcement.

### 4.3 Contextual Purveyor Agent (CPA) — Pre-Execution Cost Estimation
EPAM-CR-001 runs a TF-IDF + Haiku inference pass over all stories before any implementation agent executes, blending formula estimates with KB-citation-weighted LLM estimates. No other surveyed system does per-story pre-execution token/cost/turn estimation with confidence scoring. This is the closest the open-source space has to a FinOps-grade project estimator built into the pipeline.

### 4.4 Specialist Agent Roster with Self-Enriching Profiles
The `profiles.json` ships 30+ named specialist agents (sast-sentinel, mutant-hunter, fuzz-weaver, perf-sentinel, hygiene-sentinel, review-ranger, spec-validator, dedup-detector, readiness-checker, etc.) — each with deep domain system prompts that run at specific pipeline stages. The `agent-skills-agent` (SKILLS-001) automatically detects spec-elaboration skill gaps and appends targeted addendums to profiles. No other surveyed system has this level of agent self-improvement.

### 4.5 Structured Review Cycles with Bounded Retry
`code-review-cycle.sh` enforces maximum 3 review iterations with iteration tracking in prd.json, agent message bus handoffs, and re-review after fixes. CrewAI's hierarchical process has manager validation but no bounded iteration count. SWE-agent's RetryAgent resets the whole environment. epam-cli's review loop is structurally bounded and auditable.

### 4.6 JSONL Audit Trail Across All Pipeline Events
Every pipeline event (phase start, story completion, gate decision, cost log, review verdict, agent activity) is written to JSONL logs with consistent schemas. No surveyed tool produces a comparable structured audit record. This is essential for post-hoc analysis, cost reconciliation, and compliance.

### 4.7 Dual-Provider Invocation (Bash CLI + Python SDK)
`run-agent-orchestration.sh` dispatches via `claude.sh`, `opencode.sh`, `codex.sh`, or `invoke.py` (Anthropic Python SDK with `EPAM_SDK_INVOKE` toggle). No other pipeline supports both a shell-subprocess execution path and a direct SDK invocation path on the same story queue, with provider selection driven by per-story `aiProvider` metadata.

### 4.8 Multi-Stage Spec Phase (Grooming → Dedup → OpenSpec → Speckit → Skills)
Before a single line of implementation code runs, epam-cli's Stage 1 pipeline includes: grooming-coordinator (INVEST scoring, DoR checks), dedup-detector (semantic overlap detection), openspec-agent (AC refinement), speckit-agent (system coverage), and agent-skills-agent (gap closure). This is a pre-production specification hardening pipeline with no equivalent in any surveyed project.

### 4.9 Worktree-Based Parallel Story Isolation
Git worktrees allow independent stories within a phase to execute in parallel without shared filesystem state. Cline's Kanban and CrewAI's `async_execution` allow agent concurrency but do not provide filesystem isolation between parallel agents.

### 4.10 Documentation Orchestration as a First-Class Pipeline Stage
Stage 6 (doc-coordinator, docstring-agent, api-doc-generator, guide-author, architecture-doc-agent, changelog-agent, doc-reviewer, doc-index-builder, doc-search-agent, doc-site-builder) treats documentation as a fully orchestrated deliverable, not an afterthought. No other surveyed system has a documentation pipeline.

---

## 5. Recommended Priorities (Top Gaps Worth Closing)

Listed in descending order of strategic impact for dark-factory operation:

### Priority 1 — Docker Sandbox Execution (High Impact, High Effort)
Add a `sandbox: true` flag to prd.json stories that wraps agent execution in a Docker container with bind-mounted workspace. This protects the host filesystem, enables reproducible builds, and aligns epam-cli with the SWE-bench evaluation standard. Without it, enterprise adoption is blocked by security review. Reference: OpenHands' runtime sandbox design. Estimated effort: 3-5 stories.

### Priority 2 — External Trigger / Webhook Inbound (High Impact, Medium Effort)
A lightweight control-plane endpoint that accepts a GitHub issue event, Jira webhook, or Slack slash command and inserts a new story into the next available phase slot. This is the difference between a "manually started batch tool" and a true dark factory. `control-plane.js` already exists — extend it with inbound HTTP event handlers. Estimated effort: 2-3 stories.

### Priority 3 — SWE-bench Compatibility / Benchmark Harness (Medium Impact, Medium Effort)
Produce a `run-swe-bench.sh` script that maps SWE-bench task instances to epam-cli prd.json format and runs the pipeline against the official evaluation dataset. Even 5-10 validated tasks provides a reproducible quality claim. No other multi-agent pipeline (CrewAI, MetaGPT) has done this — it would be a unique differentiator.

### Priority 4 — Semantic RAG Upgrade for Asset/Knowledge Retrieval (Medium Impact, Medium Effort)
Replace the TF-IDF keyword match in EPAM-019 and the CPA inference pass with a lightweight vector store (LanceDB, Chroma, or sqlite-vec). Semantic retrieval of relevant KB chunks, past decision records, and asset descriptions would materially improve CPA citation coverage and agent context quality. Reference: CrewAI's LanceDB unified memory.

### Priority 5 — Intra-Story Planner/Executor Model Split (Medium Impact, Low Effort)
Add a `plannerModel` field to story specs alongside the existing `model` field. When set, the agent's first N turns use the planner model (e.g., claude-opus or o3) to produce a structured plan, then switch to the executor model (e.g., claude-haiku or gpt-4o-mini) for file edits. This matches Aider's architect+editor pattern and can reduce per-story cost by 30-50% on implementation stories without sacrificing plan quality.

### Priority 6 — OpenTelemetry Emission (Low Impact, Low Effort)
Add an OTel exporter alongside the existing Langfuse decorator in `TracedProvider.ts`. A single `@opentelemetry/sdk-node` integration that emits spans to stdout (OTLP format) costs one story and unlocks any CNCF-compatible observability backend without requiring a self-hosted Langfuse server.

### Priority 7 — SwarmRouter-Style Topology Selection (Medium Impact, Low Effort)
Add a routing step before phase execution that classifies the story set complexity and selects the appropriate execution topology (sequential, parallel, or hierarchical), rather than hard-coding linear phase progression. Inspired by `kyegomez/swarms` `SwarmRouter`. Low effort because the parallel-async branch already exists — the gap is the selection logic.

### Priority 8 — Constitution Injection (Low Impact, Low Effort)
Inject `KB.md` as a system-prompt prefix at agent invocation time (in `claude.sh`) rather than leaving it to agents to pull on-demand. From `unclebob/swarm-forge`. One-line change in prompt assembly that guarantees all agents share behavioral rules.

### Priority 9 — Plan Branching (Low Impact, High Effort)
Allow a story to spawn N implementation variants (worktrees), run them in parallel, score outputs by test pass rate and token cost, and promote the winner. This is architecturally similar to the existing Ralph Wiggum Loop (`RalphWiggumLoop.ts`) but at story granularity rather than bash-error recovery. Defer until Priorities 1-5 are closed.

---

## 6. Competitive Positioning Matrix

| Capability | SWE-agent | OpenHands | MetaGPT | CrewAI | Aider | Cline | swarms | OAI Agents SDK | epam-cli |
|---|---|---|---|---|---|---|---|---|---|
| PRD/story-centric config | No | No | Partial | No | No | No | No | No | **Yes** |
| Phase-gate with cost variance | No | No | No | No | No | No | No | No | **Yes** |
| Pre-execution cost estimation | No | No | No | No | No | No | No | No | **Yes** |
| Specialist agent roster (30+) | No | Partial | Partial | Partial | No | No | No | No | **Yes** |
| Structured review cycles | Partial | No | No | Partial | Partial | No | No | No | **Yes** |
| JSONL audit trail | Partial | Partial | No | No | No | No | No | Partial | **Yes** |
| Documentation pipeline | No | No | No | No | No | No | No | No | **Yes** |
| Docker sandbox execution | **Yes** | **Yes** | No | No | No | No | No | **Yes** | No |
| Browser/web agent | No | **Yes** | No | No | No | **Yes** | No | No | No |
| SWE-bench benchmark | **Yes** | **Yes** | No | No | No | No | No | No | No |
| Vector semantic RAG | No | Partial | No | **Yes** | No | No | No | No | No (TF-IDF) |
| External event triggers | No | Partial | No | No | No | **Yes** | No | No | No |
| OTel native tracing | No | No | No | Partial | No | No | No | **Yes** | No (Langfuse) |
| Plan branching/versioning | No | No | No | No | No | **Yes** (Plandex) | No | No | No |
| Dual-model planner/executor | Partial | No | No | **Yes** | **Yes** | **Yes** | No | No | No |
| Runtime topology selection | No | No | Partial | Partial | No | No | **Yes** | No | No |
| Guardrails (synchronous) | No | No | No | Partial | No | No | No | **Yes** | No (post-hoc) |
| Unified HITL approval panel | No | No | No | No | No | No | **Yes** | **Yes** | No |
| RBAC privilege model | No | No | No | No | No | No | No | No | No |
| Constitution-as-prompt-prefix | No | No | No | No | No | No | No | No | No (on-demand KB) |

---

*Sources consulted: github.com/princeton-nlp/SWE-agent, github.com/All-Hands-AI/OpenHands, github.com/microsoft/autogen, github.com/crewAIInc/crewAI (+ docs.crewai.com), github.com/geekan/MetaGPT, github.com/paul-gauthier/aider (+ aider.chat/docs), github.com/plandex-ai/plandex, github.com/cline/cline, github.com/Significant-Gravitas/AutoGPT, github.com/langchain-ai/langgraph, github.com/microsoft/agent-framework, github.com/microsoft/TaskWeaver, github.com/smol-ai/developer, openai.github.io/openai-agents-python, github.com/continuedev/continue, github.com/kyegomez/swarms, github.com/openai/swarm, github.com/openswarm-ai/openswarm, github.com/unclebob/swarm-forge, github.com/daveshap/OpenAI_Agent_Swarm, github.com/ruvnet/ruflo, arxiv.org/abs/2405.15793 (SWE-agent paper), arxiv.org/abs/2402.01030 (CodeAct paper). All star counts approximate as of May 2026.*
