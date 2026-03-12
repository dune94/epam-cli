# Project Instructions

## Guardrails
- Never force-push to main, master, or release branches
- Never commit .env files, API keys, or credentials to version control
- Run the full test suite before submitting changes: `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run`
- Never log PII (email, phone, name, address, payment data) to any monitoring or logging system
- Confirm before deleting files or directories; prefer reversible operations

## Node.js Version — CRITICAL
- System node is v14.17.0 (too old). Always use Node 20:
  - **Run**: `~/.nvm/versions/node/v20.20.0/bin/node`
  - **Build**: `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup`
  - **Test**: `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run`
  - **Dev**: `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsx src/index.ts`
  - **TypeScript check only**: `npx tsc --noEmit` (works with system node)

## Architecture
- Entry: `src/index.ts` → `src/cli/index.ts` (Commander) → `commands/`
- Agent loop: ReAct style in `src/agent/AgentRunner.ts`
- Provider selection: `src/billing/ProviderSelector.ts` — free tier uses BYOK direct; pro/enterprise uses ProxyProvider
- BYOK routing: When API key is set (env var or credential store), all commands (chat, run, new) bypass proxy
- Remote sessions: `src/remote/` — QR-based session handoff to mobile via AES-256-GCM encryption
- Project scaffolding: `src/scaffold/` — `epam new init` / `epam new generate` for orchestration workspace setup
- Activity logging: `src/logging/AgentActivityLogger.ts` — unified JSONL emitter for all agent events
- Config priority: CLI flags > `EPAM_*` env vars > `.epam/settings.json` > `~/.epam/config.json` > defaults

## Key Env Vars
- `EPAM_API_KEY_ANTHROPIC`, `EPAM_API_KEY_OPENAI`, `EPAM_API_KEY_GEMINI`
- `EPAM_PROVIDER`, `EPAM_MODEL`, `EPAM_BACKEND_URL`
- `EPAM_DANGEROUS_SKIP_APPROVAL=1` — skip tool approval prompts (CI/scripts only)
- `SKIP_TESTING_GATES=true` — bypass QA testing gates (Steps 4.2–4.4) in orchestration pipeline

## Tool Safety Classification
- ReadFile, ListFiles, Search, FetchUrl — safe, no approval needed
- WriteFile — requires review approval
- Bash — dangerous, always requires explicit approval unless `EPAM_DANGEROUS_SKIP_APPROVAL=1`

## Testing
- All 42 tests must pass before any PR: `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run`
- TypeScript must be clean: `npx tsc --noEmit`
- Do not add tests for internal implementation details — test public behavior and contract

## RAG & MCP Architecture Reference
- When developing RAG stories in the `RAG Poc` stage, use the `/home/bjerome/projects/ai/codemie` project as a KEY reference.
- `codemie` demonstrates a "Live RAG" architecture using MCP (Model Context Protocol) servers (Jira, Confluence, GitHub) rather than stale vector databases.
- This dynamic, tool-based context ingestion is a key differentiator for the `epam-cli` project.
