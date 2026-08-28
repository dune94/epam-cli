# Plan v4 — CodeMie provisioning

**Nothing applied.** Supersedes v3. v3 was built on flags; the controls are environment
variables and settings keys, so the shape has changed.

## Principle

No `CLAUDE_CODE_*` name, model id, turn count or ttl appears in any pipeline script.
Scripts learn a **generic mechanism**: "a runner declares settings; pass whatever it declares."
Adding a knob later is a config edit, never a code edit.

Today the CLI branch (`claude.sh:10273`, `:10302`) passes only `--model`, a dead `--max-turns`
and permissions. Every other budget reaches only the `ai-run` path (`claude.sh:10219-10223`).
That asymmetry is the defect: `roster-specialiser` ran 1,486 turns in 44 minutes for $1.43
because nothing bounded the CLI path.

## The declaration (config only)

Added to `orchestrations/config/llm-defaults.json`, inherited by every project through the
resolver built this week. Left side = the lever. Right side = the setting name the ladder
already resolves. No values are literals in code.

```
runners:
  codemie-claude:
    env:
      CLAUDE_CODE_MAX_TURNS:           maxIterations
      CLAUDE_CODE_MAX_OUTPUT_TOKENS:   maxOutputTokens
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: autoCompressAt
      CLAUDE_CODE_PROMPT_CACHE_TTL:    promptCacheTtl
      CLAUDE_CODE_EFFORT_LEVEL:        reasoningEffort
      MAX_THINKING_TOKENS:             maxThinkingTokens
    flags:
      --base-url: baseUrl
      --timeout:  timeoutSeconds
```

`maxIterations`, `maxOutputTokens`, `autoCompressAt` and `reasoningEffort` are settings the
config ALREADY declares per model. They stop being inert on this path and start being enforced.
`promptCacheTtl` and `maxThinkingTokens` are new names, declared the same way.

## Ladders — declared once

| tier | enters at | chain |
|---|---|---|
| medium | haiku-4-5 | sonnet-4-6 -> sonnet-5 |
| high | haiku-4-5 | sonnet-4-6 -> sonnet-5 -> opus-5 |
| highest | sonnet-5 | opus-4-8 -> opus-5 |

Post-exhaustion fallback: `claude-sonnet-5`, per your decision.
Thinking: adaptive, held STABLE per model — a changing effort/thinking config invalidates the
prompt cache on every retry, which is the opposite of what you asked for.

## Step 0 — CodeMie access probe (before anything else)

A single script, `orchestrations/scripts/codemie-access-check.sh`. Not an app, not a story,
not the pipeline. It answers one question: can we reach CodeMie, and are the knobs honoured?

1. Assert `codemie-claude` is on PATH; record wrapper and Claude Code versions.
   FLAG the mismatch: Claude Code 2.1.245 installed, CodeMie verifies 2.1.218.
2. Resolve the model from the ladder in config. No model id in the script.
3. Run FIRST against MockServer via `--base-url`. Cost $0. Proves arg assembly and JSON shape.
4. Then ONE real call: a fixed trivial prompt, `CLAUDE_CODE_MAX_TURNS=1`, minimal output cap.
   Expected cost well under one cent. NOTHING runs until you approve this call.
5. Assert the reply parses as the `--output-format json` shape the pipeline expects.
6. Read `total_cost_usd` from that JSON and print it. Proves cost tracking works, which it
   does not for MiniMax today.
7. Prove enforcement, not just acceptance: re-run with a prompt needing several turns and
   `CLAUDE_CODE_MAX_TURNS=1`; assert it stops. A knob that is accepted but ignored is the
   exact failure this whole plan exists to prevent.
8. Assert cache: two consecutive calls with an identical prefix; assert the second reports
   cache-read tokens. Proves caching survives the CodeMie proxy hop — currently unverified.

Exit non-zero on any failure. This script becomes the pre-flight gate for the provider.

## Steps

1. Add `runners.codemie-claude` to `llm-defaults.json` (declaration above).
2. Add `promptCacheTtl` and `maxThinkingTokens` to the base, plus `modelOverrides` for
   haiku / sonnet-4-6 / sonnet-5 / opus-4-8 / opus-5. No Claude model has an entry today.
3. Add the CodeMie `ladders` and `ladderTierOrder` to the base.
4. Teach `claude.sh` to apply a runner's declared settings generically: read the map, resolve
   each name through the ladder, export the env and append the flags. One function, no literals.
5. DELETE the dead `--max-turns` flag build (`claude.sh:9290`) and the three hardcoded
   `STORY_MAX_TURNS=""` (lines 530/536/542). The flag no longer exists in Claude Code 2.1.245;
   the fork sets it to 10/30 and would fail outright.
6. Wire `invoke.py --cache-system`, built and plumbed but called by nobody, OR record
   explicitly that the SDK path stays unused. A built capability must be wired or retired.
7. Add `EPAM_PROVIDER_SET` so the whole current stack stays swappable, per your requirement:
   `config/llm-defaults.<set>.json` and `projects/<p>/config.<set>.env` both present, one env
   var selects. Nothing is copied over anything; nothing is lost.
8. Preserve the current stack as the `openrouter` set, verbatim.
9. Add `codemie-claude` to `providers.json` `known` — a live bug today: preflight rejects a
   PRD assigning it while two call sites accept it.
10. Point the runner at `claude.sh` (`run-agent-orchestration.sh:402`) and set
    `CLAUDE_CMD=codemie-claude`.
11. Delete the 1,602-line `codemie-claude.sh` fork, 10,712 lines behind its origin.
12. Correct `INSTRUCTIONS.md:92`, which calls that fork "an identical clone".
13. Update the 14 test files referencing the fork.
14. Run the mocked pipeline end to end. $0.
15. Only then, one live run — with the spend stated before it happens.

## Tests, written red first

- a runner's declared env reaches the child process, with the ladder's resolved values
- a knob absent from the declaration is NOT passed (over-inclusion is the untested direction)
- no `CLAUDE_CODE_*` literal, model id or turn count appears in any pipeline script
- every tier resolves a ladder, and every model in a tier has an escalation edge out
- `EPAM_PROVIDER_SET=openrouter` reproduces today's resolved settings byte for byte
- the access probe fails loudly when the wrapper is missing, unauthorised, or ignores a cap

## Order of spend

Steps 1-14 cost nothing. Step 0's real call is the only spend before step 15, and it is
one trivial call. I will state the amount and wait for your approval before either.

## Unverified — will not be asserted until the probe runs

- whether the CodeMie proxy preserves cache_control, so whether caching works at all
- whether `--max-budget-usd` survives the wrapper's arg forwarding
- whether the 2.1.245 / 2.1.218 version gap breaks anything
- whether `temperature` has any supported lever on this path; treated as lost
