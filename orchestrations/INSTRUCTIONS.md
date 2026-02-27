# Orchestration System — Context Instructions

Load this file at the start of any AI session working on the orchestration layer.
It provides the minimal context needed to understand, run, and extend the system.

---

## What This Is

A multi-agent orchestration system that uses AI CLI tools (Claude, Codex, OpenCode, Codemie-Claude) to autonomously implement features for the **epam-cli** project. Stories are defined in `prd.json`, grouped into phases, and executed by role-specific agents with cost tracking, phase gates, and live dashboards.

---

## Project Root

```
/home/bjerome/projects/ai/epam-cli
```

Node.js 20 is required. System node (v14) is too old.

```bash
# Build
~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup

# Test
~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run

# Typecheck (works with system node)
npx tsc --noEmit
```

---

## Key Files

| File | Purpose |
|------|---------|
| `orchestrations/prd.json` | Master story definitions, phase assignments, phase config |
| `orchestrations/agents/profiles.json` | Agent role definitions (7 roles with rich system prompts) |
| `orchestrations/agents/KB.md` | Shared knowledge base injected into every agent prompt |
| `orchestrations/scripts/run-agent-orchestration.sh` | Master orchestrator entry point |
| `orchestrations/scripts/claude.sh` | CLI wrapper for claude/codex/opencode/epam/codemie-claude |
| `orchestrations/scripts/codemie-claude.sh` | Dedicated CLI wrapper for codemie-claude variant |
| `orchestrations/scripts/check-phase-gate.sh` | Phase gate enforcement (cost variance, completion) |
| `orchestrations/scripts/team-lead-review.sh` | Automated code review per phase |
| `orchestrations/scripts/code-review-cycle.sh` | Per-story iterative review (max 3 iterations) |
| `orchestrations/logs/agent-status.json` | Live monitor data (read by HTML dashboards) |
| `orchestrations/logs/phase-cost.jsonl` | Per-story cost/time tracking records |
| `orchestrations/logs/agent-messages.jsonl` | Agent message bus (hybrid mode) |

---

## Phases (execution order)

| # | Phase | Mode | Stories | Description |
|---|-------|------|---------|-------------|
| 1 | `health_check` | bash | EPAM-HC-001 to HC-004 | Pre-flight CLI validation (claude, opencode, codex, codemie-claude) |
| 2 | `finops` | bash | EPAM-001 to EPAM-003 | Budget guardrails + burn-up reports |
| 3 | `agent_intelligence` | bash | EPAM-004 to EPAM-008 | Gold profiles, /plan mode, decision records, MCP |
| 4 | `team_features` | bash | EPAM-009 to EPAM-011 | /replay, shared team memory |
| 5 | `multi_agent` | hybrid | EPAM-012 to EPAM-014 | Ralph Wiggum loop, Squad execution |
| 6 | `enterprise` | hybrid | EPAM-015 to EPAM-018 | Remote constraints, auditors, marketplace |
| 7 | `rag_poc` | bash | EPAM-019 to EPAM-020 | RAG Asset Discovery POC |

The `health_check` phase **must** run before all others. It validates that each CLI variant is reachable and functional.

---

## CLI Provider Variants

The orchestrator supports 5 CLI providers. Each story's `aiProvider` field in `prd.json` determines which CLI is invoked.

| Provider Value | CLI Binary | Wrapper Script | Output Format |
|----------------|-----------|----------------|---------------|
| `claude` (or `claude-sonnet`, `claude-opus`) | `claude` | `claude.sh` | JSON |
| `opencode` | `opencode` | `claude.sh` | JSONL (normalized) |
| `codex` | `codex` | `claude.sh` | JSONL (normalized) |
| `epam` | `$CLAUDE_CMD` | `claude.sh` | JSON (same as claude) |
| `codemie-claude` | `codemie-claude` | `codemie-claude.sh` | JSON (same as claude) |

**Wrapper selection logic** (in `run-agent-orchestration.sh`):
```bash
case "${CLAUDE_CMD}" in
    codemie-claude) CLAUDE_SH="$SCRIPT_DIR/codemie-claude.sh" ;;
    *)              CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
esac
```

`claude.sh` handles all providers internally via its dispatch `case` block. `codemie-claude.sh` is an identical clone except `CLAUDE_CMD` defaults to `codemie-claude` instead of `claude`.

---

## Agent Roles

| Role | Assigned To |
|------|-------------|
| `typescript-engineer` | Feature implementation (TypeScript/Node.js) |
| `agent-systems-engineer` | Agent orchestration, multi-agent, MCP |
| `billing-engineer` | FinOps, cost tracking, budget guardrails |
| `cli-ux-engineer` | REPL commands, slash commands, terminal UX |
| `test-engineer` | vitest unit + integration tests, health checks |
| `team-lead-agent` | Phase gates, dependency validation, review authority |
| `review-agent` | Per-story code review (TypeScript quality, test coverage) |

---

## Orchestration Pipeline Steps

```
0.5   Pre-phase skill assessment (augments profiles.json with missing skills)
0.6   [hybrid only] Pre-phase coordination + message bus seeding
1     Main-branch stories (sequential, no worktrees)
2     Create git worktrees (if primary/independent stories exist)
3     Parallel execution: PRIMARY + INDEPENDENT lanes concurrently
3.1   Worktree health check + auto-commit
3.5   Post-parallel skill assessment (cost/time variance analysis)
3.6   Team Lead code review (iterative, max 3 cycles per story)
4     Review stories (review-agent runs)
4.5   Unit test gate: vitest run + tsc --noEmit (BLOCKING)
4.8   Pre-gate worktree verification
5     Phase gate: completion + cost variance (ok / retry / escalate)
5.5   Interstitial E2E phase (if <phase>_e2e exists in prd.json)
6     Final post-phase assessment
7     Neo4j graph load (optional, if Neo4j is running)
```

---

## Running the Orchestrator

```bash
# Run a specific phase
./orchestrations/scripts/run-agent-orchestration.sh --phase health_check

# Dry run (show execution plan, no actions)
./orchestrations/scripts/run-agent-orchestration.sh --phase finops --dry-run

# Run with a specific CLI provider
CLAUDE_CMD=codemie-claude ./orchestrations/scripts/run-agent-orchestration.sh --phase health_check

# Run a single story directly
./orchestrations/scripts/claude.sh EPAM-001

# Run hybrid mode (coordination agent + message bus)
./orchestrations/scripts/run-agent-orchestration.sh --phase multi_agent --mode hybrid

# Skip worktree cleanup for debugging
./orchestrations/scripts/run-agent-orchestration.sh --phase finops --skip-cleanup
```

---

## Story Schema (prd.json)

Each story in the `stories` array has:

```json
{
  "id": "EPAM-001",
  "title": "Budget Guardrails",
  "description": "...",
  "priority": "high|medium|low|critical",
  "status": "pending|in_progress|completed|failed",
  "completed": false,
  "agentGroup": "main|primary|independent",
  "agentRole": "typescript-engineer|...",
  "acceptanceCriteria": ["..."],
  "dependencies": ["EPAM-XXX"],
  "estimatedHours": 6,
  "technicalNotes": {
    "files": ["src/..."],
    "requiredSkills": ["TypeScript", "..."]
  },
  "storyType": "implementation|review|health_check",
  "aiProvider": "claude|opencode|codex|codemie-claude"
}
```

`agentGroup` determines execution lane:
- **main** — runs on main branch, sequentially (Step 1)
- **primary** — runs in git worktree, parallel lane 1 (Step 3)
- **independent** — runs in git worktree, parallel lane 2 (Step 3)

---

## Agent Message Bus (Hybrid Mode)

Scripts: `send-message.sh`, `receive-messages.sh`, `list-messages.sh`, `ack-message.sh`

Messages are JSONL records in `orchestrations/logs/agent-messages.jsonl`:

```json
{"id":"msg_<epoch>","timestamp":"<ISO8601>","from_agent":"<role>","to_agent":"<role>","story_id":"<id>","phase_id":"<phase>","message_type":"handoff|plan_required|risk|feedback|approval","priority":"normal|high","subject":"...","body":"...","status":"new|read|acked"}
```

All writes use `flock` for atomic JSONL appends.

---

## Dashboards

Open in a browser (serve via the `agent-monitor` Docker service on port 8092):

| Dashboard | URL Path | Purpose |
|-----------|----------|---------|
| `monitor.html` | `/monitor.html` | Live lane/story status |
| `prd-viewer.html` | `/prd-viewer.html` | All stories + filters |
| `agent-profiles.html` | `/agent-profiles.html` | Agent profiles + skills |
| `phase-cost-monitor.html` | `/phase-cost-monitor.html` | Cost tracking + variance |
| `agent-messages.html` | `/agent-messages.html` | Message bus viewer |
| `orchestration-plan.html` | `/orchestration-plan.html` | Architecture overview |

---

## Conventions

- **Config priority**: CLI flags > `EPAM_*` env vars > `.epam/settings.json` > `~/.epam/config.json` > defaults
- **Error handling**: Non-zero exit from a story triggers retry (up to `MAX_RETRIES=2`), then marks story as failed
- **Cost tracking**: Every story invocation appends a record to `orchestrations/logs/phase-cost.jsonl`
- **Phase gate**: Blocks progression if cost variance exceeds threshold (default 150%) or stories are incomplete
- **Atomic writes**: All JSONL files use `flock` for concurrent safety
- **Worktrees**: Created under `.worktrees/` in project root; cleaned up on exit unless `--skip-cleanup`

---

## Adding a New Phase

1. Add stories to the `stories` array in `prd.json`
2. Add the phase key + story ID list to `implementationOrder` (position determines run order)
3. Add the phase to `phasesConfig` with `orchestrationMode: "bash"` or `"hybrid"`
4. Run: `./orchestrations/scripts/run-agent-orchestration.sh --phase <new_phase> --dry-run`

## Adding a New CLI Provider

1. Add a case to `provider_to_cli()` in `claude.sh` returning the binary name
2. Add a dispatch case in the story execution block of `claude.sh` with the invocation pattern
3. Add a normalization case in `normalize_provider_json()` if the output format differs from Claude's JSON
4. If the provider needs a dedicated wrapper script, clone `claude.sh` and update `CLAUDE_CMD` default
5. Add a `case` to the wrapper selection in `run-agent-orchestration.sh`
6. Add a health_check story in `prd.json` for the new provider
