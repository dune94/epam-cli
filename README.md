# EPAM CLI — AI Coding Assistant

A multi-LLM AI coding assistant CLI with agent orchestration, provider failover chain, OAuth authentication, and enterprise features.

## Features

- **Multi-provider support** — Claude (Anthropic), OpenAI GPT-4o, Google Gemini, Codex, OpenCode
- **Agent orchestration** — parallel multi-agent execution with phase gates and cost tracking
- **ReAct agent loop** — iterative reasoning with tool calls (ReadFile, WriteFile, Bash, ListFiles, Search, FetchUrl)
- **Interactive REPL** — slash commands (`/plan`, `/context`, `/model`, `/compact`, `/clear`)
- **Auth** — Device flow (RFC 8628) + browser PKCE; keytar keychain with encrypted file fallback
- **Budget guardrails** — cost thresholds, model downgrade, session tracking
- **Provider failover chain** — automatic fallback across models on error or budget limits
- **Dashboards** — live orchestration monitor at `http://localhost:8092`

## Requirements

- Node.js ≥ 20
- At least one LLM API key

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Interactive chat
EPAM_API_KEY_ANTHROPIC=sk-ant-... node dist/epam.js chat

# Non-interactive (pipe a task)
echo "list all TypeScript files" | node dist/epam.js run

# Auth (device flow)
node dist/epam.js login

# Environment check
node dist/epam.js doctor
```

## Configuration

Priority order: CLI flags → `EPAM_*` env vars → `.epam/settings.json` → `~/.epam/config.json` → defaults.

| Env var | Description |
|---------|-------------|
| `EPAM_API_KEY_ANTHROPIC` | Anthropic API key |
| `EPAM_API_KEY_OPENAI` | OpenAI API key |
| `EPAM_API_KEY_GEMINI` | Google Gemini API key |
| `EPAM_PROVIDER` | Provider override (`claude`, `openai`, `gemini`) |
| `EPAM_MODEL` | Model override |
| `EPAM_BACKEND_URL` | EPAM proxy backend URL |
| `EPAM_DANGEROUS_SKIP_APPROVAL` | Set to `1` to skip tool approval in CI |

## Development

```bash
npm run dev          # Run from source (tsx)
npm run typecheck    # TypeScript check
npm test             # Run vitest (42 tests)
npm run build        # Bundle with tsup → dist/epam.js
```

## Agent Orchestration

A multi-agent build system for orchestrating LLM coding agents across phased story execution.

```bash
# Run the infra-test phase first (smoke test the pipeline)
bash orchestrations/scripts/run-agent-orchestration.sh --phase infra_test

# Run a full implementation phase
bash orchestrations/scripts/run-agent-orchestration.sh --phase finops

# With a different provider
CLAUDE_CMD=opencode bash orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Estimate AI cost for all stories
bash orchestrations/scripts/estimate-stories.sh

# Write estimates to prd.json
bash orchestrations/scripts/estimate-stories.sh --apply

# View live dashboards (requires Docker)
docker compose -f docker-compose.epam-cli.yml up agent-monitor -d
# Open: http://localhost:8092
```

### Phases

| Phase | Stories | Description |
|-------|---------|-------------|
| `infra_test` | 3 | Orchestration pipeline smoke tests (Claude, OpenCode, Codex) |
| `health_check` | 4 | LLM CLI binary pre-flight checks |
| `finops` | 3 | Budget guardrails + burn-up reports |
| `agent_intelligence` | 5 | Agent profiles, /plan mode, decision records, MCP server |
| `team_features` | 3 | Session replay, shared team memory |
| `multi_agent` | 3 | Parallel agent loops, squad execution |
| `enterprise` | 4 | Remote constraints, auditor agents, expertise marketplace |
| `rag_poc` | 2 | RAG asset discovery (keyword matching POC) |

## Stack

- **Language**: TypeScript (strict)
- **Runtime**: Node.js 20
- **Bundler**: tsup (CJS)
- **Testing**: vitest
- **Key libs**: Commander.js, Chalk, Zod, Anthropic SDK, OpenAI SDK, Keytar

## License

MIT
