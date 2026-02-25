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
