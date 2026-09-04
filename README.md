# EPAM CLI

A multi-LLM AI coding assistant CLI with agent orchestration, provider failover chain, OAuth authentication, team collaboration, and enterprise features.

## ✨ New Features (2026)

- **38 Slash Commands** — `/orchestrate`, `/status`, `/team`, `/share`, `/handoff`, `/diff`, `/export`, `/dashboard`, and more
- **Container Sandbox Isolation** — `EPAM_SANDBOX=true` runs agent invocations in a Docker/Podman container with vendor dirs mounted genuinely read-only (kernel-enforced), base image derived from the target project's own detected stack
- **Tab Autocomplete** — Type `/` + Tab for command completion
- **Session Handoff** — Automatic context transfer on provider failover
- **Team Collaboration** — Share sessions, invite members, transfer ownership
- **Live Dashboards** — 17 real-time orchestration dashboards at `http://localhost:8092`

---

## Features

### Multi-Provider Support

9 providers behind one abstraction (`src/providers/`), with health monitoring, slot-based failover, and cooldown backoff:

| Provider | Models | Auth |
|----------|--------|------|
| **Anthropic** | claude-opus-4, claude-sonnet-5, claude-haiku-4-5 (see `src/billing/pricing.ts` for the full, current model list) | API Key |
| **OpenAI** | gpt-5.x, gpt-5-codex, o-series | API Key |
| **Google** | gemini-2.5-pro/flash, gemini-3-pro-preview | API Key |
| **OpenRouter** | OpenRouter routing alias — NOT literal Alibaba OpenRouter models; routes to Moonshot Kimi-K2 / Z-AI GLM / DeepSeek depending on `EPAM_MODEL_PROVIDER_MAP` | API Key |
| **MiniMax** | MiniMax-M series | API Key |
| **Codemie** | claude-sonnet, EPAM-hosted | SSO OAuth |
| **Codex** | gpt-5-codex family | CLI Auth |
| **Copilot** | GitHub Copilot-hosted models | CLI Auth |
| **Cursor** | Cursor-hosted models | CLI Auth |

Model pricing/availability changes frequently — `src/billing/pricing.ts` is the source of truth, not this table.

### Provider Failover Chain

Automatic fallback when providers fail:
```
epam [codemie/claude-opus] › Build a React app

⚠  Failover: codemie → Network error → switching to minimax/MiniMax-M3

📦 Session transferred to minimax/MiniMax-M3
   • 5 messages transferred
   • Full conversation history preserved

epam [minimax/MiniMax-M3] › Continue with authentication
```

### Slash Commands (38 Total)

Registered in `src/cli/repl/SlashCommands.ts` — 12 defined inline plus 26 more implemented as individual command modules under `src/cli/repl/commands/`.

#### Session / control
| Command | Description |
|---------|-------------|
| `/help` | Show available slash commands |
| `/clear` | Clear conversation history (keeps context.md) |
| `/top` | Scroll to top of session output |
| `/exit` | Exit the REPL |
| `/rewind` | Roll back to an earlier turn |
| `/resume` | Resume a previous session |
| `/stash` | Save/restore private context sessions |

#### Context / cost
| Command | Description |
|---------|-------------|
| `/context` | Show/edit `.epam/context.md` |
| `/memory` | View, edit, or clear project/global context memory |
| `/cost` | Show running session cost |
| `/compact` | Compress conversation history |
| `/add-dir` | Add a directory tree listing to the active context window |

#### Model / provider
| Command | Description |
|---------|-------------|
| `/model` | List or switch model for the current provider |
| `/provider` | List or switch providers, manage authentication |
| `/chain` | Inspect the provider failover chain |
| `/permissions` | Show/adjust tool approval settings |
| `/agent` | List or switch named agent personas |
| `/skills` | List and toggle agent tool capabilities for this session |

#### Orchestration / monitoring
| Command | Description |
|---------|-------------|
| `/orchestrate` | Launch and monitor multi-agent orchestration |
| `/plan` | Enter structured plan mode with branching strategy |
| `/status` | Show live dashboard: provider, budget, tools, model |
| `/tasks` | Show running agent task queue |
| `/debug` | Provider + tool state dump for power users |

#### Team collaboration
| Command | Description |
|---------|-------------|
| `/team` | Show team overview and status |
| `/members` | List and manage team members |
| `/invite` | Invite users to team via EPAM backend API |
| `/share` | Export session as portable bundle for team to import |
| `/handoff` | Transfer session ownership to team member |
| `/import` | Import a shared session bundle from a team member |
| `/user` | Show current user identity and switch provider accounts |
| `/remote` | Generate QR code for mobile continuation or manage remote sessions |

#### Outputs / tools
| Command | Description |
|---------|-------------|
| `/diff` | Show all file changes made this session |
| `/export` | Export session transcript to file |
| `/dashboard` | Open dashboard URLs in browser |
| `/review` | Instant inline code review of recent changes |
| `/fork` | Branch the session context for parallel exploration |
| `/mcp` | Toggle MCP servers and show status |
| `/mcp-query` | Query MCP sources manually (`@jira`, `@confluence`, etc.) |

### Agent Orchestration

Parallel multi-agent execution with phase gates and cost tracking:
- **ReAct agent loop** — Iterative reasoning with tool calls
- **Budget guardrails** — Cost thresholds, model downgrade, session tracking
- **Session handoff** — Automatic context preservation on failover
- **QA Testing Gates** — 7 QA gate agents in 3 cascading phases (SAST, spec compliance, code review, mutation testing, fuzz analysis, performance)
- **Self-Healing Reviewer Gates with Retry-on-Violation** — every automated write to `prd.json`/`profiles.json` (skill assessment, model assignment, spec-pass rewrites, TC writer) is validated by a deterministic or LLM reviewer; a violation gets up to 3 attempts with the specific issue fed back as a corrective note before falling back to a snapshot revert (or, for the TC writer, blocking just that one story instead of aborting the whole phase). Every outcome double-writes to a persistent, git-SHA-tagged history file so a prompt's violation rate can be tracked across runs, not just within one
- **Single-Authority Story Splitting** — openspec is the sole decision-maker on splitting oversized stories; a deterministic code-level guard drops any competing split proposal a second agent still emits, closing a real live collision (two agents independently splitting the same story into different children)
- **Container Sandbox Isolation** — `EPAM_SANDBOX=true` runs each agent invocation in a Docker/Podman container: vendor directories (`node_modules`, etc.) mounted genuinely read-only via a kernel-enforced bind mount (not same-UID-bypassable chmod locking), base image derived from the target project's own detected stack
- **Generic Role-Based Escalation** — watchdog timeout and retry-extension budget scale by a story's `agentRole` (e.g. `EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP`, `EPAM_ROLE_RETRY_EXTENSION_MAP`); model-ladder tier also escalates on low average FailureAnalyst diagnosis groundedness — all measured signals, not hardcoded per-project assumptions
- **LLM Observability (Langfuse)** — Every LLM call traced with tokens, cost, latency, and tool calls via self-hosted Langfuse at `http://localhost:3100`
- **GitIngest** — Codebase-to-LLM-context extraction for documentation pipelines

### Authentication

EPAM CLI v1 uses a **bridge model** for provider authentication (see [DEC-005](./.epam/decisions.jsonl) and [research note](./.epam/provider-auth-research.md)):

- **Device Flow** (RFC 8628) — For EPAM backend (`epam login`)
- **Browser PKCE** — For SSO providers (Codemie: `epam provider login codemie --browser`)
- **API Keys** — For direct provider access (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax: `epam provider login <provider>`)
- **CLI Auth** — For Codex, Copilot, Cursor (uses each tool's own CLI credentials: `epam provider login <codex|copilot|cursor>`)

**v1 Bridge Model:**
- User-managed API keys stored in OS credential manager (keychain/Credential Manager/libsecret)
- Manual entry via `epam provider login <provider>` or env vars (`EPAM_API_KEY_*`)
- No auto-provisioned brokered keys (deferred to v2+)

**Long-term Direction (v2+):**
- `epam login` provisions provider credentials centrally
- EPAM backend stores and refreshes provider tokens per user
- Workspace admins manage provider keys for entire team

### Dashboards

17 live dashboards at `http://localhost:8092` (`orchestrations/dashboards/`; see `DASHBOARD-MANIFEST.md` for the full per-dashboard data-source contract):
- **monitor.html** — Real-time orchestration status, running/complete story tracking, self-healing-aware activity framing
- **prd-viewer.html** — All stories with filters
- **phase-cost-monitor.html** — Cost tracking and variance
- **agent-profiles.html** — Agent profiles and skills
- **agent-activity.html** — Unified event timeline across all agents, with a running/done story-status summary (start/finish/elapsed)
- **agent-messages.html** — Inter-agent handoff/message log
- **quality-assurance.html** — QA testing gate verdicts per phase
- **quality-dashboard.html** — Aggregated quality trends
- **agents-orchestration.html** — Pipeline flow with gate steps
- **pipeline-stages.html** — Stage-by-stage pipeline breakdown
- **orchestration-plan.html** — Plan-mode output viewer
- **specification.html** — Spec diff (openspec/speckit collaboration)
- **cpa-details.html** — Cost/Plan/Analysis estimate detail
- **scorecard.html** — Run-level scorecard summary
- **swe-bench.html** — SWE-bench-style benchmark results
- **epam-cli-guide.html** — In-dashboard CLI guide
- **health.html** — Self-healing signals (analyst cycles, skill-note growth, dynamic tools) plus prompt-eval retry/revert/block outcomes for the reviewer-gated writes above, including a cross-run trend table and violation-type breakdown per step

### LLM Observability (Langfuse)

Self-hosted Langfuse captures every LLM call with full tracing:

```bash
# Start infrastructure (includes Langfuse + ClickHouse) — done automatically by
# orchestrations-installer/install.sh (or npx amsd-pipeline); by hand instead:
docker compose -f docker-compose.observability.yml up -d

# Enable tracing in your session
export LANGFUSE_SECRET_KEY=sk-lf-epam-dev
export LANGFUSE_PUBLIC_KEY=pk-lf-epam-dev

# Open dashboard
open http://localhost:3100   # dev@epam-cli.local / dev1234
```

Traces include: model, provider, token usage, cost (USD), latency, tool calls, stop reason.

### GitIngest (Codebase Context)

TypeScript wrapper around the `gitingest` Python CLI for extracting LLM-friendly text digests from repositories:

```bash
pip install gitingest   # prerequisite
```

Used programmatically via `src/tools/gitingest/GitIngest.ts` — supports full repo ingest, subdirectory scoping, and changed-file-only mode for documentation pipelines.

### Model Context Protocol (MCP)

Connect external tool servers to EPAM CLI via `.mcp.json`:

```json
{
  "servers": [
    {
      "name": "jira",
      "url": "http://localhost:8000/mcp",
      "transport": "http",
      "enabled": true
    },
    {
      "name": "confluence",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "enabled": true
    }
  ]
}
```

**Configuration:**
- `enabled` (optional, default `true`) — Set to `false` to disable a server without removing it from config
- `transport` — `http`, `sse`, or `stdio`
- `url` (required for http/sse) — Server endpoint
- `command` + `args` (required for stdio) — Spawned process

By default, `.mcp.json` ships with example servers disabled to avoid startup noise. Enable them by setting `enabled: true` after configuring a local server.

---

## Requirements

- Node.js `>=20`
- npm

## Install

No git commands, no manual clone — installs the full orchestration pipeline (self-clones, packages
the ref, provisions docker in isolation, starts the launch dashboard):

```bash
npx amsd-pipeline --dest ~/amsd-pipeline
```

Run `npx amsd-pipeline --help` for flags (`--dest`, `--ref`, `--uninstall`, `--no-docker`, ...).

Already working from a checkout of this repo, or want the CLI (`epam`) itself rather than the full
orchestration install:

```bash
git clone https://github.com/dune94/epam-cli.git
cd epam-cli
npm install
npm run build
```

Run with either binary alias:

```bash
node dist/epam.js --version
node dist/epam.js chat
# or, after npm link:
epam --version
epam chat
```

## Quick Start

1. Initialize project scaffolding:

```bash
epam init
```

2. Authenticate to EPAM backend (device flow by default):

```bash
epam login
# optional browser flow
epam login --browser
```

3. Start interactive chat:

```bash
epam chat
```

4. Run a one-shot task:

```bash
epam run "Summarize the current repo architecture"
# or via stdin
echo "Create a test plan" | epam run -
```

## Documentation

- [Technical Guide (Markdown)](./TECHNICAL-GUIDE.md) — in-depth architecture reference for the CLI, provider chain, orchestration scripts, dashboards, and deployment tooling.
- [Technical Guide (HTML)](./technical-guide.html) — formatted version of the same guide for quick browser review or dashboard embedding.

## Core Commands

Top-level commands currently registered in the CLI (`src/cli/commands/`):

- `chat` - interactive REPL session
- `run` - single non-interactive agent run
- `init` - initialize project scaffolding (free, local-only, no LLM calls)
- `new` - `new init`/`new generate`: full workspace scaffolding, with `generate` optionally deriving a PRD from a manifest via LLM calls
- `login`, `logout`, `whoami` - EPAM auth lifecycle
- `doctor` - health checks (runtime, config, auth, backend, provider credential status) — free, no LLM calls
- `health-check-claude`, `health-check-proxy` - **not** free despite the name; make a real, small billable LLM call through the Claude CLI / backend proxy respectively, to confirm end-to-end connectivity
- `models` - list available models
- `config` - show/get/set/path for resolved/global config
- `context` - show/init/edit `.epam/context.md`
- `keys` - BYOK key store (`anthropic`, `openai`, `gemini`)
- `provider` - provider credential flows (`anthropic`, `openai`, `gemini`, `openrouter`, `minimax`, `codemie`, `codex`, `copilot`, `cursor`)
- `history` - recent session IDs
- `report` - burn-up report from session history
- `replay` - replay previous sessions
- `profile` - save/load/list/delete agent profiles
- `consult` - queue one-turn profile consultation
- `decision` - ADR-style decision records (add/list/search)
- `sync` - push/pull/status for shared context + decisions
- `estimate` - story AI cost/time/token estimation (with optional CPA pass)
- `orchestrate` - phase orchestration via shell runner
- `phase` - phase approval + controlled phase execution
- `squad` - multi-agent squad execution
- `mcp` - run MCP server (`serve`)
- `import` - import shared session bundle or Redis share code

Use per-command help for full options:

```bash
epam <command> --help
```

## Interactive Slash Commands (`epam chat`)

The REPL supports built-in slash commands and tab completion — see the full 38-command table above (Slash Commands section) for the complete, current list. Use `/help` in REPL for live usage details.

## Authentication and Provider Credentials

There are two layers:

1. EPAM backend auth (`epam login`) for brokered EPAM flows.
2. Provider credentials for direct/bridge provider execution.

Provider credential command examples:

```bash
epam provider list
epam provider login anthropic
epam provider status anthropic
epam provider logout anthropic

# Codemie SSO
epam provider login codemie --url https://codemie.lab.epam.com

# Codex CLI bridge
epam provider login codex
```

## Configuration

Resolution order:

1. CLI flags
2. `EPAM_*` environment variables
3. `.epam/settings.json` (project)
4. `~/.epam/config.json` (global)
5. defaults

Common env overrides:

- `EPAM_BACKEND_URL`
- `EPAM_PROVIDER`
- `EPAM_MODEL`
- `EPAM_API_KEY_ANTHROPIC`
- `EPAM_API_KEY_OPENAI`
- `EPAM_API_KEY_GEMINI`
- `EPAM_DANGEROUS_SKIP_APPROVAL=1`
- `EPAM_MAX_ITERATIONS`
- `EPAM_BUDGET_WARNING_AT`
- `EPAM_BUDGET_HARD_LIMIT_AT`
- `EPAM_MAX_OUTPUT_TOKENS`
- `EPAM_SANDBOX=true` — run agent invocations in an isolated container (see Agent Orchestration above)

Langfuse observability (optional):

- `LANGFUSE_SECRET_KEY` — Langfuse secret key (enables tracing when set)
- `LANGFUSE_PUBLIC_KEY` — Langfuse public key
- `LANGFUSE_BASE_URL` — Langfuse server URL (default: `http://localhost:3100`)
- `LANGFUSE_ENABLED` — Set to `false` to explicitly disable even when keys are present

## Orchestration and PRD Workflows

The project includes orchestration scripts under `orchestrations/scripts/`.

Typical examples:

```bash
epam estimate --phase mvp_cli_control
epam orchestrate --phase mvp_cli_control --dry-run
epam phase approve --phase mvp_cli_control
epam phase run --phase mvp_cli_control --require-approval
```

### Specification Mode (OpenSpec/Speckit)

- `run-agent-orchestration.sh` now runs a specification pre-pass before CPA/estimates. `orchestrations/scripts/spec-mode-runner.js` snapshots the current `prd.json`, asks the coordinator agent which spec personas (OpenSpec, Speckit, both, or none) to launch, executes them, and applies any acceptance-criteria edits or story splits back into the PRD.
- Outputs land in `orchestrations/logs/`: `spec-baseline.json` (latest baseline), `spec-summary.json` (run metadata), `spec-phase.jsonl` (per-agent before/after fragments), and archived runs under `spec-runs/<run>/`. These files feed the new `orchestrations/dashboards/specification.html` dashboard so you can diff baseline vs current PRD per story.
- Run the pre-pass manually with `/orchestrate spec <phase>` (inside the REPL), `epam orchestrate spec <phase>` (non-interactive), or `npm run specification:run -- --phase <phase>` for CI smoke tests. Set `EPAM_SPEC_MODE=0` to skip the automation when replaying historical runs.
- Spec agents live in `orchestrations/agents/profiles.json` (`spec-coordinator-agent`, `openspec-agent`, `speckit-agent`); extend those profiles when rolling spec-aware workflows to a new project.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:coverage
```

## License

MIT
