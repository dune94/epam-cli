# Plan — move the ladders onto CodeMie, and delete the 1,602-line fork

**Nothing in this plan is applied.** Numbers below are verified, not estimated.

## What the live CodeMie deployment actually offers

`codemie models list` against your profile returns **40 models**. Relevant ones:

| family | ids |
|---|---|
| Haiku | `claude-haiku-4-5-20251001` *(the only Haiku)* |
| Sonnet | `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-sonnet-4-5-20250929`, `-vertex` variants |
| Opus | `claude-opus-4-6-20260205`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5` |
| Kimi | **`moonshotai.kimi-k2.5`** |
| others | gemini-3.x, gpt-4.1/5.x, deepseek-v4-pro |

**Two findings that change your brief:**

1. **`codemie-kimi` exists as a wrapper AND Kimi exists as a model — they are different things.**
   `moonshotai.kimi-k2.5` is a model in the catalogue, reachable through `codemie-claude`.
   Separately, `codemie-kimi` is an installed binary wrapping **Kimi Code — Moonshot's own agent**,
   not Claude Code. Also installed: `codemie-codex`, `codemie-gemini`, `codemie-opencode`.
   So there are two ways to reach Kimi, and they are not equivalent: one swaps the MODEL under the
   Claude Code agent, the other swaps the AGENT itself. See "Which Kimi" below.
2. **Fable is not in the catalogue.** Nothing named `fable` is offered today. Keeping it "for
   later" is right; it cannot be planned in until it appears.

## The fork deletes to one line

`codemie-claude.sh` exists *only* because the binary differs. `run-agent-orchestration.sh:402`:

```sh
codemie-claude) CLAUDE_SH="$SCRIPT_DIR/codemie-claude.sh" ;;
```

`claude.sh` already takes the binary from `CLAUDE_CMD`. So the fork is replaced by pointing that
case at the maintained script and setting the command:

```sh
codemie-claude) CLAUDE_SH="$SCRIPT_DIR/claude.sh"; CLAUDE_CMD="codemie-claude" ;;
```

**−1,602 lines, +1.** And it closes a real hazard: the fork is 10,712 lines behind `claude.sh`,
missing the tool-policy reads, the codeline-keyed KB, `agent-io`, `agent-ladder`, `story-guards`,
`prompt-budget` and the baseline-ref fix. `orchestrations/INSTRUCTIONS.md:92` still calls it "an
identical clone except CLAUDE_CMD" — false, and dangerous to anyone who believes it.

## Proposed ladders — config only, in each project's `llm-settings.json`

| tier | startModel | chain |
|---|---|---|
| medium | `moonshotai.kimi-k2.5` | → `claude-haiku-4-5-20251001` → `claude-sonnet-4-6` |
| high | `claude-haiku-4-5-20251001` | → `claude-sonnet-4-6` → `claude-opus-4-6-20260205` |
| highest | `claude-haiku-4-5-20251001` | → `claude-sonnet-4-6` → `claude-opus-4-6-20260205` |

As you specified: Haiku → Sonnet → Opus for both high and highest.

**One thing to decide.** High and highest identical means the `top` ladder position stops meaning
anything — 25 of 39 seams sit on `top`, and they would run exactly as the 12 on `mid` do. If that
is intentional (one escalation path, position only affects *where you enter*), the start models
should differ: e.g. high starts Haiku, highest starts **Sonnet**. Otherwise the two tiers are one
tier with two names.

**Escalation completeness is mandatory** — an existing regression guard enforces it, and it caught
me dropping edges last time. Every model that can *enter* a tier needs a path *out*: the Claude
family, the Kimi entry, and any legacy id still reachable through routing.

## Provider routing — one line per project

```
EPAM_MODEL_PROVIDER_MAP="claude-*=codemie-claude|moonshotai.*=codemie-claude"
```

replacing today's qwen/minimax map. `ai-run.sh:103,179` already dispatches `codemie-claude`, so
no code change.

## Change inventory

| # | file | kind | change |
|---|---|---|---|
| 1 | `run-agent-orchestration.sh:402` | code | point the case at `claude.sh`, set `CLAUDE_CMD` |
| 2 | `orchestrations/scripts/codemie-claude.sh` | delete | −1,602 lines |
| 3 | `projects/*/llm-settings.json` | config | three ladders + `modelOverrides` for the new models |
| 4 | `projects/*/config.env` | config | provider map; `EPAM_ORCHESTRATION_PROVIDER`/`ORCH_GATE_PROVIDER` → `codemie-claude` |
| 5 | `orchestrations/config/providers.json` | config | add `codemie-claude` to `known` |
| 6 | `test/…` (14 files) | test | retarget assertions from the fork to `claude.sh` |

**Item 5 is a live bug today**, independent of this plan: `known` is
`[qwen, openai, anthropic, claude, gemini, codex, cursor, opencode, minimax]` — no codemie. So
preflight rejects a PRD assigning it while two call sites accept it.

## Model overrides — required, not optional

Overrides match by substring and **none exist for any Claude model**. Without them the new models
run with no `maxIterations`, `autoCompressAt`, `temperature` or `reasoningEffort`. Three entries:
`claude-haiku`, `claude-sonnet`, `claude-opus`. Values need measuring, not guessing — the current
ones were tuned per model, and `autoCompressAt` must sit near the context ceiling because
compaction destroys the cacheable prefix.

## Risks

- **Model ids are deployment-specific.** They live in project config, which is correct — but a
  different CodeMie deployment may offer different ids. Nothing should hardcode them in engine code.
- ~~No base-URL lever~~ — **CORRECTED. Every codemie wrapper takes `--base-url <url>`**, along with
  `--model`, `--api-key`, `--timeout`, `--jwt-token`, `--reasoning-effort` and `--task <prompt>`.
  So the MockServer rehearsal is NOT lost: `ai-run.sh` can pass `--base-url` the same way it
  already passes `--model`. That is the single most important correction to this plan — the free
  rehearsal survives the provider switch, and it needs one flag, not a new env var.
- **`src/providers/codemie/CodemieProvider.ts` is broken** — it `fetch()`es the *model name* as a
  URL and assumes an OpenAI response shape where the real API is Anthropic Messages. Out of scope
  here, but it should not be relied on; it has no test proving it can make a call.
- **14 test files** reference the fork, including one pinning it by content hash.

## Which Kimi — a real choice, not a detail

| option | what it means | cost |
|---|---|---|
| **model swap**: `moonshotai.kimi-k2.5` via `codemie-claude` | Claude Code stays the agent; only the model changes | **zero extra work** — it is just a ladder entry |
| **agent swap**: `codemie-kimi` | Kimi Code becomes the agent — a different tool loop, different tool names, different output shape | a new dispatch arm in `ai-run.sh`, a new wrapper path, and every seam's output contract re-verified against it |

For "medium tier starts on Kimi", the **model swap** delivers it for free. The agent swap is a
much larger change and would need its own evaluation — the pipeline's contracts are written
against Claude Code's tool vocabulary.

My recommendation: take the model swap now; treat `codemie-kimi` as a separate question.

## Open questions for you

1. High and highest identical, or highest starts at Sonnet?
2. Sonnet `4-6` or `sonnet-5`; Opus `4-6-20260205` or `opus-4-8`/`opus-5`? Newer exists.
3. Roll out to metrolinx only, or mock3 and skyscanner too?
4. ~~base-URL lever~~ — resolved: `--base-url` already exists on the wrapper.
5. Kimi as a MODEL under Claude Code (free), or Kimi as the AGENT via `codemie-kimi` (large)?
