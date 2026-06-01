---
name: example-memory
description: Example project memory file showing syntax and structure
metadata:
  type: project
---

# Project Context

This EPAM CLI project is an AI-powered coding assistant that supports multiple LLM providers (Anthropic, OpenAI, Gemini).

## Key Architecture Decisions

- Agent loop uses ReAct pattern (Reason + Act)
- Provider selection: free tier → BYOK direct, pro/enterprise → ProxyProvider
- Activity logging: unified JSONL format in `src/logging/AgentActivityLogger.ts`

## Development Notes

- Always use Node 20: `~/.nvm/versions/node/v20.20.0/bin/node` or current fnm node
- Run tests: `node ./node_modules/.bin/vitest run`
- TypeScript check: `npx tsc --noEmit`

## Import Example

You can import other files using @path syntax:
@shared-patterns.md

This would import the contents of `shared-patterns.md` from the same directory.
