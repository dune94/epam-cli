# EPAM CLI — AI Coding Assistant

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

---

## Requirements

- **Node.js** ≥ 20
- **At least one LLM API key** (or SSO for Codemie)

---

## Installation

```bash
npm install
npm run build
```

---

## Quick Start

### 1. Set API Keys

```bash
# Option A: Environment variables
export EPAM_API_KEY_ANTHROPIC=sk-ant-...
export EPAM_API_KEY_QWEN=sk-qwen-...

# Option B: CLI commands
node dist/epam.js keys set anthropic sk-ant-...
node dist/epam.js keys set qwen sk-qwen-...

# Option C: Provider login (SSO)
node dist/epam.js provider login codemie
```

### 2. Start Chat

```bash
# Interactive chat with default provider
node dist/epam.js chat

# Specific provider and model
node dist/epam.js chat --provider qwen --model qwen-max

# With failover chain
node dist/epam.js chat --chain codemie,qwen,codex
```

### 3. Use Slash Commands

```
epam [qwen/qwen-max] › /help
epam [qwen/qwen-max] › /status
epam [qwen/qwen-max] › /orchestrate estimate finops
epam [qwen/qwen-max] › /team
epam [qwen/qwen-max] › /share current
epam [qwen/qwen-max] › /export session-report.md
```

### 4. Tab Autocomplete

Type `/` then press **Tab** to see all commands:
```
epam [qwen/qwen-max] › /<TAB>
/dashboard  /debug  /diff  /export  /fork  /handoff  /invite  /mcp
/members  /orchestrate  /plan  /review  /share  /status  /tasks  /team
```

---

## Configuration

Priority order: **CLI flags** → `EPAM_*` env vars → `.epam/settings.json` → `~/.epam/config.json` → defaults

### Environment Variables

| Variable | Description |
|----------|-------------|
| `EPAM_API_KEY_ANTHROPIC` | Anthropic API key |
| `EPAM_API_KEY_OPENAI` | OpenAI API key |
| `EPAM_API_KEY_GEMINI` | Google Gemini API key |
| `EPAM_API_KEY_QWEN` | Qwen (DashScope) API key |
| `EPAM_PROVIDER` | Provider override (`claude`, `openai`, `gemini`, `qwen`, `codemie`, `codex`) |
| `EPAM_MODEL` | Model override |
| `EPAM_BACKEND_URL` | EPAM proxy backend URL |
| `EPAM_DANGEROUS_SKIP_APPROVAL` | Set to `1` to skip tool approval in CI |

### Provider Chain Configuration

```json
{
  "provider": "codemie",
  "llmChain": [
    { "provider": "codemie", "model": "claude-opus-4-6" },
    { "provider": "qwen", "model": "qwen-max" },
    { "provider": "codex", "model": "gpt-5-codex" }
  ],
  "budgetGuardrails": {
    "warningAt": 0.001,
    "hardLimitAt": 0.002,
    "onHardLimit": "downgrade"
  }
}
```

---

## Development

```bash
npm run dev          # Run from source (tsx)
npm run typecheck    # TypeScript check
npm test             # Run vitest (313 tests)
npm run build        # Bundle with tsup → dist/epam.js
npm run lint         # ESLint check
npm run format       # Prettier format
```

---

## Agent Orchestration

Multi-agent build system for phased story execution:

```bash
# Run infra-test phase (smoke test)
bash orchestrations/scripts/run-agent-orchestration.sh --phase infra_test

# Run implementation phase
bash orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Use different provider
CLAUDE_CMD=qwen bash orchestrations/scripts/run-agent-orchestration.sh --phase finops

# Estimate AI costs
bash orchestrations/scripts/estimate-stories.sh

# Apply estimates to prd.json
bash orchestrations/scripts/estimate-stories.sh --apply

# Deploy demo instance
bash scripts/deploy-demo.sh
```

### Phases

| Phase | Stories | Description |
|-------|---------|-------------|
| `infra_test` | 3 | Pipeline smoke tests (Claude, OpenCode, Codex) |
| `health_check` | 4 | CLI binary pre-flight checks |
| `finops` | 3 | Budget guardrails + burn-up reports |
| `agent_intelligence` | 5 | Agent profiles, /plan mode, decision records, MCP |
| `team_features` | 3 | Session replay, shared team memory |
| `multi_agent` | 3 | Parallel agent loops, squad execution |
| `enterprise` | 4 | Remote constraints, auditor agents, expertise marketplace |
| `rag_poc` | 2 | RAG asset discovery (keyword matching POC) |
| `provider_auth` | 4 | Multi-provider authentication flows |
| `mvp_cli_control` | 7 | Core CLI commands and control flow |

---

## Team Collaboration

### Share Session

```bash
epam [qwen/qwen-max] › /share current

📤 Share Session

Session to Share:
  ID: session-1772510000
  Messages: 15
  Turns: 8

✓ Session exported locally
✓ Session shared with team
  Team members can now view this session
```

### Handoff to Teammate

```bash
epam [qwen/qwen-max] › /handoff john@example.com

🔄 Session Handoff

Current Session:
  ID: session-1772510000
  Messages: 15
  Transferring To: john@example.com

✓ Session handoff initiated
  Target user receives notification
  Session appears in their queue
  They can continue from last message
```

### Invite Team Member

```bash
epam [qwen/qwen-max] › /invite jane@example.com admin

📧 Sending Invitation

Invitation Details:
  Email: jane@example.com
  Role: admin
  Team: Current Team

✓ Invitation would be sent
  Email notification sent
  Invitation expires in 7 days
```

---

## Dashboards

Live monitoring requires Docker:

```bash
# Start dashboard service
docker compose -f docker-compose.epam-cli.yml up agent-monitor -d

# Open in browser
open http://localhost:8092/monitor.html
open http://localhost:8092/prd-viewer.html
open http://localhost:8092/phase-cost-monitor.html
```

Or use slash command:
```
epam [qwen/qwen-max] › /dashboard all
```

---

## Stack

| Component | Technology |
|-----------|------------|
| **Language** | TypeScript (strict) |
| **Runtime** | Node.js 20 |
| **Bundler** | tsup (CJS) |
| **Testing** | vitest (313 tests) |
| **Linting** | ESLint + Prettier |

### Key Libraries

- **Commander.js** — CLI framework
- **Chalk** — Terminal colors
- **Zod** — Schema validation
- **Anthropic SDK** — Claude API
- **OpenAI SDK** — GPT API
- **Execa** — Process execution
- **Prompts** — Interactive prompts

---

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/unit/repl/NewCommands.test.ts

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

**Test Coverage:** 313/315 tests passing

---

## Deployment

### Demo Instance

```bash
# Deploy to demo directory
bash scripts/deploy-demo.sh

# Update demo instance
bash scripts/update-demo.sh

# Clean rebuild
cd /home/bjerome/projects/ai/epam-cli-demo
rm -rf dist node_modules
npm install
npm run build
```

---

## License

MIT

---

## Quick Reference

### Common Commands

```bash
# Start chat
node dist/epam.js chat

# Check status
node dist/epam.js doctor

# List models
node dist/epam.js models

# Set API key
node dist/epam.js keys set qwen sk-xxx

# Provider login
node dist/epam.js provider login codemie

# Run task
echo "Build React app" | node dist/epam.js run

# Estimate cost
node dist/epam.js estimate --phase finops

# Orchestrate phase
node dist/epam.js orchestrate execution finops
```

### Slash Commands Quick Reference

```
/orchestrate <estimate|execution|status> [phase]  # Multi-agent orchestration
/plan [show|create|branch]                        # Structured planning
/status                                           # Live session dashboard
/tasks                                            # Agent task queue
/debug [full|brief]                               # State dump

/team                                             # Team overview
/members [list|add]                               # Team members
/invite <email> [role]                            # Invite member
/share [session-id]                               # Share session
/handoff <user>                                   # Transfer ownership

/diff                                             # File changes
/export [filename]                                # Export transcript
/dashboard [monitor|prd|cost|all]                 # Open dashboards
/review [file|all]                                # Code review
/fork [name]                                      # Branch session
/mcp [list|connect|disconnect]                    # MCP servers
```
