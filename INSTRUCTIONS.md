# EPAM CLI Project Instructions

This file provides concrete working guidance for AI assistants contributing to `epam-cli`.

## Project Context

`epam-cli` is a TypeScript Node.js CLI for AI-assisted engineering workflows, including:

- Interactive chat and non-interactive runs
- Provider/auth flows (EPAM login + provider credential bridges)
- Cost/reporting and session history
- Phase orchestration and PRD-driven execution scripts
- Team collaboration flows (share/import/handoff/sync)

## Tech Stack

- Language: TypeScript
- Runtime: Node.js 20+
- CLI framework: Commander
- Build tool: tsup
- Testing: Vitest
- Lint/format: ESLint + Prettier

## Key Directories

- `src/`: CLI commands, REPL, providers, auth, orchestration glue, observability, context/session logic
- `test/`: unit and integration tests
- `orchestrations/`: orchestration scripts, dashboards, PRD workflow artifacts
- `dist/`: built CLI output (`dist/epam.js`)
- `.epam/`: local project runtime state (settings, context, sessions, profiles)

## Coding Standards

### Style

- Keep changes minimal and focused on the requested behavior
- Follow existing TypeScript and Commander patterns used in neighboring files
- Prefer clear function boundaries and explicit types over implicit `any`
- Add comments only for non-obvious logic

### Patterns

- For new CLI capabilities, wire commands through `src/cli/index.ts`
- Reuse existing services (AuthManager, ConfigResolver, ProviderChain, SessionStore) instead of duplicating logic
- Keep user-facing output actionable and deterministic
- Preserve backward compatibility for existing command flags/options when possible

### Testing

- Add/update Vitest coverage for behavior changes
- For CLI behavior changes, include at least one command-path test or integration-style assertion
- Run these before handoff when feasible:
  - `npm run typecheck`
  - `npm run test`

## Operational Guardrails

- Do not claim support for commands or providers that are not implemented in code
- Do not hardcode secrets, tokens, or environment-specific credentials
- Avoid breaking existing `.epam` project file formats unless explicitly requested
- Keep documentation aligned with actual command implementations

## Out of Scope (Unless Explicitly Requested)

- Large-scale refactors unrelated to the requested change
- Dependency/toolchain migrations
- Removing existing tests without replacement
- Modifying orchestration PRD content (`orchestrations/prd.json`) for unrelated work
