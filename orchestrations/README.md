# EPAM CLI — Agent Orchestration

Multi-agent orchestration system for building epam-cli features autonomously using Claude Code (and other AI CLIs) with parallel execution, phase gates, cost tracking, and live dashboards.

Based on the fitnessapp/shadow-play orchestration pattern. Supports: **claude**, **codex**, **opencode**, **codemie-claude**, and (future) **epam** itself.

> For full context-loading instructions, see [INSTRUCTIONS.md](./INSTRUCTIONS.md).

---

## Directory Structure

```
orchestrations/
├── prd.json                    # Master story definitions + phase assignments
├── README.md                   # This file
├── agents/
│   ├── profiles.json           # 10 core + 10 QA/analysis agent role definitions (rich system prompts)
│   ├── AGENTS.md               # Auto-generated learned patterns log
│   └── KB.md                   # Shared knowledge base
├── scripts/
│   ├── run-agent-orchestration.sh   # Master orchestrator (entry point)
│   ├── claude.sh                    # Claude/Codex/OpenCode/EPAM/Codemie-Claude CLI wrapper
│   ├── codemie-claude.sh                 # Dedicated Codemie-Claude CLI wrapper
│   ├── update-monitor.sh            # Dashboard status updates
│   ├── check-phase-gate.sh          # Phase gate enforcement
│   ├── team-lead-review.sh          # Team Lead code review cycle
│   ├── worktree-health-check.sh     # Worktree commit verification
│   ├── merge-worktree.sh            # Worktree merge back to main
│   ├── check-dependencies.sh        # Story dependency graph check
│   ├── send-message.sh              # Agent message bus (hybrid mode)
│   ├── receive-messages.sh          # Read messages from bus
│   ├── list-messages.sh             # List bus messages
│   ├── ack-message.sh               # Acknowledge message
│   ├── sync-monitor-stories.sh      # Sync story data to monitor
│   ├── load-phase-graph.sh          # Load phase graph to Neo4j
│   ├── load-phase-graph.py          # Python Neo4j loader
│   ├── update-cost-forecasts.sh     # Update cost forecast data
│   ├── code-review-cycle.sh         # Code review automation
│   └── reset-cost-test.sh           # Reset cost data for testing
├── logs/
│   ├── agent-status.json            # Live monitor data (read by dashboards)
│   ├── phase-cost.jsonl             # Per-story cost/time records
│   ├── phase-skill-assessments.jsonl
│   ├── agent-messages.jsonl         # MCP message bus (hybrid mode)
│   ├── agent-activity.jsonl         # Unified agent activity timeline (all event types)
│   ├── profiles-audit.jsonl         # Pre-phase skill augmentation log
│   └── phase-improvements/          # Per-phase improvement reports
└── dashboards/
    ├── monitor.html                 # Live lane/story status
    ├── prd-viewer.html              # All stories + filters
    ├── agent-profiles.html          # Agent profiles + skills
    ├── orchestration-plan.html      # Architecture overview
    ├── phase-cost-monitor.html      # Cost tracking + variance
    ├── agent-messages.html          # Message bus viewer
    ├── agents-orchestration.html   # Orchestration flow diagram
    ├── quality-assurance.html      # QA testing gates viewer
    ├── agent-activity.html         # Unified agent activity timeline
    └── cpa-details.html            # CPA estimation details
```

---

## Quick Start

```bash
# Run a phase (bash mode — default)
./orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Preview execution plan without running
./orchestrations/scripts/run-agent-orchestration.sh --phase finops --dry-run

# Run hybrid mode (coordination agent + message bus)
./orchestrations/scripts/run-agent-orchestration.sh --phase multi_agent --mode hybrid

# Run specific story
./orchestrations/scripts/claude.sh EPAM-001

# View dashboards (requires agent-monitor Docker service)
docker compose -f docker-compose.epam-cli.yml up agent-monitor -d
# Then open: http://localhost:8092/monitor.html

### Dashboard builds (Eleventy)

```bash
# One-off render (writes to orchestrations/dashboards/live)
npm run dashboards:build

# Real-time watch server with BrowserSync reloads on port 8093
npm run dashboards:serve
```

The watch server tracks `orchestrations/prd.json`, `orchestrations/logs/**/*`, and the CLI
scripts that publish dashboard data. Every change triggers an automatic rebuild of the
10 dashboard HTML files plus `build-info.json`, then reloads the browser so the latest
JSON feeds are pulled without manual refreshes.

`./scripts/run-agent-orchestration.sh` now auto-starts `npm run dashboards:serve`
whenever a phase is executed so dashboards stay hot while agents run. Set
`EPAM_DASH_AUTO_SERVE=0` to skip the watcher if you already have one running.
Watcher output (and any failures) land in `orchestrations/logs/dashboards-watch.log`.

---

## Phases

| Phase | Mode | Stories | Priority | Description |
|-------|------|---------|----------|-------------|
| `health_check` | bash | EPAM-HC-001 to HC-004 | P0 | Pre-flight CLI validation |
| `finops` | bash | EPAM-001 to EPAM-003 | P1 | Budget guardrails + burn-up reports |
| `agent_intelligence` | bash | EPAM-004 to EPAM-008 | P1 | Gold profiles, /plan mode, decision records, MCP |
| `team_features` | bash | EPAM-009 to EPAM-011 | P2 | /replay, shared team memory |
| `multi_agent` | hybrid | EPAM-012 to EPAM-014 | P3 | Ralph Wiggum loop, Squad execution |
| `enterprise` | hybrid | EPAM-015 to EPAM-018 | P3 | Remote constraints, auditors, marketplace |
| `rag_poc` | bash | EPAM-019 to EPAM-020 | P4 | RAG Asset Discovery POC |

---

## Agent Roles

| Role | Responsibilities |
|------|-----------------|
| `typescript-engineer` | Feature implementation in TypeScript (src/) |
| `agent-systems-engineer` | Agent orchestration, multi-agent coordination, MCP |
| `billing-engineer` | FinOps, cost tracking, budget guardrails |
| `cli-ux-engineer` | REPL commands, slash commands, terminal UX |
| `test-engineer` | vitest unit + integration tests |
| `team-lead-agent` | Phase gates, dependency validation, code review authority |
| `review-agent` | Code review per story (TypeScript quality, test coverage) |
| `openspec-agent` | First-pass specification elaboration (acceptance criteria, story splits) |
| `speckit-agent` | Second-pass specification review (testability, security, edge cases) |
| `spec-coordinator-agent` | Assigns spec agents per story, final quality review |

### QA Gate Agents (Steps 4.2–4.4)

| Role | Gate Phase | Responsibilities |
|------|-----------|-----------------|
| `test-coordinator-agent` | Coordinator | Governs testing gates, sequences phases, aggregates verdicts |
| `sast-sentinel` | Phase A (4.2) | Static analysis + security pattern scanning (tsc diagnostics, injection, traversal, secrets) |
| `spec-validator` | Phase A (4.2) | Acceptance criteria compliance verification against prd.json |
| `review-ranger` | Phase B (4.3) | Deep diff-level code review (complexity, duplication, API contracts, test gaps) |
| `mutant-hunter` | Phase B (4.3) | Mutation testing analysis (test suite quality scoring) |
| `fuzz-weaver` | Phase C (4.4) | Property-based fuzz testing analysis (edge cases, input domains, vulnerabilities) |
| `perf-sentinel` | Phase C (4.4) | Performance analysis (complexity, memory, async, startup time) |
| `hygiene-sentinel` | Phase C (4.4) | Dead code detection, unused exports (via Knip), code hygiene |
| `design-sentinel` | Phase C (4.4) | Duplication detection (jscpd), SOLID principles analysis (Semgrep) |
| `pattern-sentinel` | Phase C (4.4) | Pattern extraction (ast-grep), dependency analysis (Madge), generalization |

---

## Orchestration Pipeline

```
Step 0.5  Pre-phase skill assessment (augments agent profiles)
Step 0.6  [hybrid only] Pre-phase coordination + message bus seeding
Step 1    Main-branch stories (sequential)
Step 2    Create git worktrees (if primary/independent stories exist)
Step 3    Parallel: PRIMARY + INDEPENDENT lanes run concurrently
Step 3.1  Worktree health check + auto-commit
Step 3.5  Post-parallel skill assessment
Step 3.6  Team Lead code review
Step 4    Review stories
Step 4.2  Testing gate Phase A: sast-sentinel ‖ spec-validator (parallel, blocking)
Step 4.3  Testing gate Phase B: review-ranger ‖ mutant-hunter (parallel, only if A passed)
Step 4.4  Testing gate Phase C: fuzz-weaver ‖ perf-sentinel (parallel, only if A+B passed)
Step 4.5  Unit test gate: vitest run + tsc --noEmit (blocking)
Step 4.8  Pre-gate worktree verification
Step 5    Phase gate: cost variance check (ok / warn / escalate)
Step 5.5  Interstitial E2E phase (if <phase>_e2e exists in prd.json)
Step 6    Final post-phase assessment
```

---

## Provider Support

Set `CLAUDE_CMD` to switch AI provider:

```bash
# Claude (default)
./orchestrations/scripts/run-agent-orchestration.sh --phase finops

# OpenCode
CLAUDE_CMD=opencode ./orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Codex
CLAUDE_CMD=codex ./orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Codemie-Claude
CLAUDE_CMD=codemie-claude ./orchestrations/scripts/run-agent-orchestration.sh --phase health_check

# EPAM CLI (once built — dogfooding)
CLAUDE_CMD="node dist/epam.js run" ./orchestrations/scripts/run-agent-orchestration.sh --phase finops
```

---

## BYOK Provider Routing

When a user has their own API key set (via `EPAM_API_KEY_ANTHROPIC` env var or the encrypted credential store), all LLM calls go **direct to the provider** — never through the proxy backend. This applies to `chat`, `run`, and `new` commands. The proxy is only used for `pro`/`enterprise` tier users without BYOK keys.

---

## Remote Session Handoff (`/remote`)

The `/remote` slash command enables mobile continuation of a desktop CLI session:

1. Desktop encrypts the session (AES-256-GCM) and POSTs to the backend-stub
2. A QR code is displayed containing a claim URL with the encryption key in the URL fragment (never sent to server)
3. Phone scans QR, claims the session, decrypts with Web Crypto API, and renders a chat UI
4. Phone user can continue the conversation with AI (streaming via proxy)
5. "Return to Desktop" re-encrypts and POSTs back; desktop auto-reclaims via polling

Subcommands: `/remote`, `/remote reclaim`, `/remote status`, `/remote cancel`, `/remote help`

Backend endpoints: `POST /v1/remote/sessions`, `GET /v1/remote/sessions/:token`, `POST /v1/remote/sessions/:token/return`, `GET /v1/remote/sessions/:token/reclaim`

---

## Project Scaffolding (`epam new`)

Initialize new projects with full orchestration workspace:

```bash
epam new init                     # Analyze manifest + generate PRD interactively
epam new generate                 # Generate project from existing PRD
```

Scaffolds: `orchestrations/` directory with prd.json, agent profiles, dashboards (Eleventy), scripts, KB.md, and `.epam/settings.json`.

---

## Unified Agent Activity Log

All agents emit events to `orchestrations/logs/agent-activity.jsonl` via the `AgentActivityLogger` (`src/logging/AgentActivityLogger.ts`). Event types:

| Type | Description |
|------|-------------|
| `story_start` / `story_complete` / `story_fail` | Story lifecycle |
| `tool_run` / `tool_result` | External tool invocations (Knip, jscpd, Semgrep, etc.) |
| `finding` | Issue/pattern discovered (with severity) |
| `gate_decision` | QA gate pass/fail/review |
| `cost_snapshot` | Token/cost data point |
| `phase_start` / `phase_complete` | Phase lifecycle |
| `error` / `info` | General events |

View in the **Agent Activity** dashboard (`agent-activity.html`) — filterable by agent, type, phase, story, and severity.

---

## Future: CLI Integration

Once epam-cli is mature, the orchestration mechanism will be injected into the CLI as a first-class feature:

```bash
epam orchestrate --phase finops          # Run a phase
epam orchestrate --dry-run               # Preview
epam orchestrate status                  # Show phase/story status
epam orchestrate story EPAM-001          # Run single story
```

This transforms epam-cli from an AI assistant into a full **autonomous development orchestrator** — using itself to build itself.
