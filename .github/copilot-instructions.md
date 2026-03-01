# Copilot Instructions

## Node.js Version — CRITICAL

System node is v14 (too old). Always use Node 20 for all commands:

| Task | Command |
|------|---------|
| Build | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup` |
| Test | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run` |
| Single test | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run test/unit/billing/` |
| Watch tests | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest` |
| Dev | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsx src/index.ts` |
| TypeScript check | `npx tsc --noEmit` (works with system node) |
| Lint | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/eslint src --ext .ts` |

All 42 tests must pass before any PR. TypeScript must be clean (`npx tsc --noEmit`).

## Architecture

**Entry point flow:** `src/index.ts` → `src/cli/index.ts` (Commander) → `src/cli/commands/*.ts`

**Agent loop:** `src/agent/AgentRunner.ts` runs a ReAct-style loop: send messages to provider → receive tool calls → execute via `Executor` → append results → repeat until `end_turn`. Auto-compresses history when estimated tokens exceed `autoCompressAt` threshold.

**Provider layer:** `src/providers/ProviderChain.ts` manages an ordered list of `ProviderSlot`s (provider + model pairs). On error or budget exhaustion, it automatically fails over to the next slot. Supported providers: `AnthropicProvider`, `OpenAIProvider`, `GeminiProvider`, `ProxyProvider` (enterprise backend).

**Billing/tiers:** `src/billing/TierDetector.ts` reads the JWT access token to determine `free | pro | enterprise`. Free tier = BYOK direct API keys; pro/enterprise = routed through `ProxyProvider`. `BudgetGuard.ts` tracks session cost and triggers `warning | downgrade | pause` actions.

**Config resolution priority:** CLI flags → `EPAM_*` env vars → `.epam/settings.json` → `~/.epam/config.json` → defaults. The resolved config type is `ResolvedConfig` in `src/config/types.ts`.

**Tools:** Defined in `src/tools/`. Each tool implements the `Tool` interface with a `permission` field: `safe` (auto-execute), `review` (requires user approval), `dangerous` (always prompts unless `EPAM_DANGEROUS_SKIP_APPROVAL=1`). Tools are registered into `ToolRegistry` and passed to `AgentRunner`.

**MCP:** `src/mcp/McpClient.ts` connects to external MCP servers defined in `.mcp.json`. MCP tools are namespaced as `server/toolName` in the registry.

**REPL:** `src/cli/repl/Repl.ts` handles interactive chat. Slash commands (`/plan`, `/model`, `/context`, `/compact`, `/clear`) are parsed by `SlashCommands.ts`.

## Key Conventions

**Adding a new tool:** Implement the `Tool` interface from `src/tools/types.ts` (requires `name`, `description`, `permission`, `definition`, `execute()`). Register it in the appropriate command setup. Set `permission` correctly — never mark a write or shell tool as `safe`.

**Adding a new provider:** Implement `LLMProvider` from `src/providers/types.ts`. Providers must handle both streaming and non-streaming via the `stream` flag on `ProviderRequest`. Add to `ProviderChain`'s provider builder.

**Tests live in `test/`**, mirroring `src/` structure under `test/unit/`. Integration tests are in `test/integration/`. Test files match `**/*.test.ts`. Do not test internal implementation details — test public behavior and contracts.

**Import extensions:** All internal imports use `.js` extensions (e.g., `import { foo } from './bar.js'`) even though the source is TypeScript. This is required for ESM compatibility in the CJS bundle.

**Logging:** Use `logger` from `src/utils/logger.js` (pino-based). Never `console.log` in library code. Never log PII (email, phone, name, payment data).

## Key Env Vars

| Variable | Purpose |
|----------|---------|
| `EPAM_API_KEY_ANTHROPIC` | Anthropic API key |
| `EPAM_API_KEY_OPENAI` | OpenAI API key |
| `EPAM_API_KEY_GEMINI` | Google Gemini API key |
| `EPAM_PROVIDER` | Provider override (`claude`, `openai`, `gemini`) |
| `EPAM_MODEL` | Model override |
| `EPAM_BACKEND_URL` | EPAM enterprise proxy backend URL |
| `EPAM_DANGEROUS_SKIP_APPROVAL=1` | Skip tool approval prompts (CI/scripts only) |

## Guardrails

- Never force-push to `main`, `master`, or release branches
- Never commit `.env` files, API keys, or credentials
- Confirm before deleting files or directories; prefer reversible operations
