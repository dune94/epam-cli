# EPAM CLI

A multi-LLM AI coding assistant CLI with agent orchestration, provider failover chain, OAuth authentication, team collaboration, and enterprise features.

## ✨ New Features (2026)

- **16 Slash Commands** — `/orchestrate`, `/status`, `/team`, `/share`, `/handoff`, `/diff`, `/export`, `/dashboard`, and more
- **Tab Autocomplete** — Type `/` + Tab for command completion
- **Session Handoff** — Automatic context transfer on provider failover
- **Team Collaboration** — Share sessions, invite members, transfer ownership
- **Live Dashboards** — Real-time orchestration monitoring at `http://localhost:8092`

---

## Features

### Multi-Provider Support

| Provider | Models | Auth |
|----------|--------|------|
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | API Key |
| **OpenAI** | gpt-4o, gpt-4o-mini | API Key |
| **Google** | gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash | API Key |
| **Qwen** | qwen-max, qwen-plus, qwen-turbo, qwen-2.5-72b | API Key |
| **Codemie** | claude-sonnet-4-5 | SSO OAuth |
| **Codex** | gpt-5-codex | CLI Auth |

### Provider Failover Chain

Automatic fallback when providers fail:
```
epam [codemie/claude-opus] › Build a React app

⚠  Failover: codemie → Network error → switching to qwen/qwen-max

📦 Session transferred to qwen/qwen-max
   • 5 messages transferred
   • Full conversation history preserved

epam [qwen/qwen-max] › Continue with authentication
```

### Slash Commands (16 Total)

#### Orchestration
| Command | Description |
|---------|-------------|
| `/orchestrate` | Launch multi-agent orchestration (`estimate`, `execution`, `status`) |
| `/plan` | Structured plan mode with branching strategy |

#### Monitoring
| Command | Description |
|---------|-------------|
| `/status` | Live dashboard: provider, budget, tools, model |
| `/tasks` | Show agent task queue |
| `/debug` | Provider + tool state dump |

#### Team Collaboration
| Command | Description |
|---------|-------------|
| `/team` | Team overview and status |
| `/members` | List/manage team members |
| `/invite` | Invite users via EPAM API |
| `/share` | Share session with team |
| `/handoff` | Transfer session ownership |

#### Productivity
| Command | Description |
|---------|-------------|
| `/diff` | Show session file changes |
| `/export` | Export session transcript |
| `/dashboard` | Open dashboard URLs |
| `/review` | Inline code review |
| `/fork` | Branch session context |
| `/mcp` | Toggle MCP servers |

### Agent Orchestration

Parallel multi-agent execution with phase gates and cost tracking:
- **ReAct agent loop** — Iterative reasoning with tool calls
- **Budget guardrails** — Cost thresholds, model downgrade, session tracking
- **Session handoff** — Automatic context preservation on failover
- **QA Testing Gates** — 7 QA gate agents in 3 cascading phases (SAST, spec compliance, code review, mutation testing, fuzz analysis, performance)

### Authentication

- **Device Flow** (RFC 8628) — For EPAM backend
- **Browser PKCE** — For SSO providers (Codemie)
- **API Keys** — For direct provider access
- **CLI Auth** — For Codex (uses codex CLI credentials)

### Dashboards

Live monitoring at `http://localhost:8092`:
- **monitor.html** — Real-time orchestration status
- **prd-viewer.html** — All stories with filters
- **phase-cost-monitor.html** — Cost tracking and variance
- **agent-profiles.html** — Agent profiles and skills
- **quality-assurance.html** — QA testing gate verdicts per phase
- **agents-orchestration.html** — Pipeline flow with gate steps
- **specification.html** — Spec diff (openspec/speckit collaboration)

---

## Requirements

- Node.js `>=20`
- npm

## Install

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

Top-level commands currently registered in the CLI:

- `chat` - interactive REPL session
- `run` - single non-interactive agent run
- `login`, `logout`, `whoami` - EPAM auth lifecycle
- `doctor` - health checks (runtime, config, auth, backend, provider credential status)
- `models` - list available models
- `config` - show/get/set/path for resolved/global config
- `context` - show/init/edit `.epam/context.md`
- `keys` - BYOK key store (`anthropic`, `openai`, `gemini`)
- `provider` - provider credential flows (`anthropic`, `openai`, `gemini`, `codemie`, `codex`)
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

The REPL supports built-in slash commands and tab completion.

Common commands include:

- Session/control: `/help`, `/clear`, `/top`, `/exit`
- Context/cost: `/context`, `/cost`, `/compact`, `/rewind`, `/resume`
- Model/provider: `/model`, `/provider`, `/chain`, `/permissions`
- Team/workflow: `/plan`, `/orchestrate`, `/tasks`, `/status`, `/debug`
- Collaboration: `/team`, `/members`, `/invite`, `/share`, `/handoff`, `/import`
- Outputs/tools: `/diff`, `/export`, `/dashboard`, `/review`, `/mcp`, `/mcp-query`
- Persona/config: `/agent`, `/skills`, `/stash`, `/user`

Use `/help` in REPL for the complete live list and usage.

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
