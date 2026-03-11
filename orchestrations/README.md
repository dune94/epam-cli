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
│   ├── profiles.json           # 10 core + 7 QA gate agent role definitions (rich system prompts)
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

## Future: CLI Integration

Once epam-cli is mature, the orchestration mechanism will be injected into the CLI as a first-class feature:

```bash
epam orchestrate --phase finops          # Run a phase
epam orchestrate --dry-run               # Preview
epam orchestrate status                  # Show phase/story status
epam orchestrate story EPAM-001          # Run single story
```

This transforms epam-cli from an AI assistant into a full **autonomous development orchestrator** — using itself to build itself.
