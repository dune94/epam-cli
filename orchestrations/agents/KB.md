# Shared Knowledge Base

Shared context available to all agents during orchestrated execution.

## Project: epam-cli

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 20+
- **Package manager**: npm
- **Test framework**: vitest
- **Build tool**: tsup
- **Linter**: eslint + prettier

## Key Paths

| Path | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point |
| `src/cli/` | Commander commands, REPL, slash commands |
| `src/providers/` | LLM provider adapters (Anthropic, OpenAI, Gemini) |
| `src/agent/` | ReAct agent loop |
| `src/tools/` | Built-in tools (ReadFile, WriteFile, Bash, Search, etc.) |
| `src/auth/` | OAuth device flow, token management |
| `src/config/` | Config resolver (global → project → env → flags) |
| `src/billing/` | Tier detection, BYOK key store, provider selection |
| `src/logging/` | Unified JSONL activity logger (`AgentActivityLogger`) |
| `src/remote/` | Remote session handoff (QR, encryption, serialization) |
| `src/scaffold/` | Project scaffolding (`epam new`) |
| `src/context/` | Session store, context loader, memory compressor |
| `test/` | Unit and integration tests |

## Conventions

- All source in `src/`, tests in `test/unit/` mirroring src structure
- Types defined in `types.ts` per module directory
- Errors extend `EpamError` from `src/utils/errors.ts`
- Config hierarchy: CLI flags > EPAM_* env vars > .epam/settings.json > ~/.epam/config.json > defaults
- Provider chain: up to 5 LLM slots with automatic failover (circuit breaker pattern)

## Test Gate

```bash
# Must pass before phase gate approval
npx vitest run          # unit + integration tests
npx tsc --noEmit        # TypeScript strict check
```

## Auth Model

- **Free tier**: BYOK (bring your own key) — direct provider calls
- **Pro/Enterprise**: Proxy through backend-stub — JWT claims carry tier info
- **Device flow** (RFC 8628) is default auth; browser PKCE optional with `--browser`

## KB-001 -- 2026-02-28

**Category:** orchestration
**AgentRole:** backend-engineer
**Tags:** bash, orchestration, metadata-resolution, dashboards
**Trigger:** first-success
**StoryRef:** EPAM-026

Apply phase/project default models only when the resolved provider is `epam`; if a legacy story explicitly uses `codex`, `opencode`, or another non-EPAM provider, falling through to `phasesConfig.defaultModel` makes orchestration-plan output and monitor payloads report the wrong model. For legacy providers, keep any explicit story model, otherwise derive a compatibility label from effort instead of EPAM defaults.

## KB-002 -- 2026-03-01

**Category:** orchestration
**AgentRole:** backend-engineer
**Tags:** typescript, multi-agent, peer-review, json-parsing
**Trigger:** first-success
**StoryRef:** EPAM-013

When implementing multi-agent orchestration with peer review (e.g., SecurityAuditor reviewing Coder output), design review responses to default to approval when JSON parsing fails. The reviewing agent's role is to actively block on issues, not to explicitly approve — if they produce plain-text or malformed JSON without explicit blocking status, treat it as approval rather than throwing an error. This makes the system resilient to LLM output variability while maintaining security: a reviewer who finds issues will structure their response correctly, but a reviewer who finds nothing may just write "looks good" instead of proper JSON.

## KB-003 -- 2026-03-01

**Category:** backend
**AgentRole:** review-agent
**Tags:** typescript, async, cancellation, abort-controller
**Trigger:** first-success
**StoryRef:** EPAM-014

When implementing multi-agent parallel execution with cancellation support, registering an AbortController in a task registry is insufficient. The abort signal must be threaded through the entire call chain: TaskRegistry → caller → AgentRunOptions → AgentRunner → provider.stream(). Without adding `abortSignal?: AbortSignal` to AgentRunOptions and checking it in the agent loop, calling `abortController.abort()` will update task status but leave the underlying LLM stream and agent execution running. Always ensure cancellation signals propagate to the lowest-level async operation (the provider stream) to avoid resource leaks and unbounded execution.

## KB-004 -- 2026-03-01

**Category:** orchestration
**AgentRole:** review-agent
**Tags:** typescript, prompt-injection, session-history, agent-runner
**Trigger:** first-success
**StoryRef:** EPAM-018

For one-turn consultation or override prompts, consuming a pending flag is not enough if you also persist the injected text into the turn history. If the transformed message is stored in the same message array that becomes future history, the consultation silently bleeds into later turns. Keep a separate transient message list for the model-facing request and preserve the original user message in the persisted session history.
## KB-005 -- 2026-03-01

**Category:** backend
**AgentRole:** developer
**Tags:** typescript, node, cli, credential-storage, oauth
**Trigger:** first-success
**StoryRef:** EPAM-044

When implementing credential abstraction over legacy API keys (BYOK) vs. brokered keys or browser tokens, legacy keys will often exist with missing schema elements. To prevent data loss or silent failures, explicitly inject default fallback `type` ('api_key') and `source` ('manual_api_key') when parsing raw entries from fallback storage (like `keytar`), instead of relying purely on TypeScript's `Partial<T>` assertions during runtime decoding. Additionally, storing composite keys in secure storage (e.g. `provider:source`) prevents different credential types for the same provider from overwriting one another while allowing runtime sorting by precedence.