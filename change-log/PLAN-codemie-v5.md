# Plan v5 — CodeMie provisioning, provider-set swap, and the openrouter -> openrouter rename

**Nothing applied.** Supersedes v4. Adds the swap mechanism to testing as a first-class
deliverable, and adds the rename. One correction to v4 is marked below.

## Principle

No `CLAUDE_CODE_*` name, model id, turn count or ttl appears in any pipeline script. Scripts
learn a mechanism: "a runner declares settings; pass whatever it declares." A new knob is a
config edit, never a code edit.

---

# PHASE A — Access probe  *** COMPLETE — RUN 2026-08-25, $0.1009 ***

Connectivity is PROVEN. Measured, not asserted. Nothing was changed to get this.

| check | result | evidence |
|---|---|---|
| Backend reachable | PASS | `codemie doctor`: provider operational, SSO valid 20h, `claude-sonnet-4-6` available. $0 |
| Routing goes through CodeMie | PASS | Falsified: a bogus `--base-url` fails at "Proxy setup failed: SSO credentials not found" BEFORE any API call. $0 |
| A model call completes | PASS | `"result":"OK"`, exit 0, valid JSON. $0.037899 |
| JSON shape parses | PASS | `--output-format json` returns the shape the pipeline expects |
| Cost tracking works | PASS | `total_cost_usd` reported and accurate — MiniMax reports zero today |
| **Cache survives the proxy** | **PASS** | 2nd call, identical prefix: `cache_read_input_tokens` 6305, cost $0.037899 -> $0.0019605. **19.3x cheaper**. Writes `ephemeral_1h` — the 1-HOUR TTL IS ALREADY DEFAULT |
| **MAX_TURNS is ENFORCED** | **PASS** | `CLAUDE_CODE_MAX_TURNS=1` on multi-turn work: `subtype: error_max_turns`, `terminal_reason: max_turns`, `is_error: true`, exit 1. It HALTED. $0.06108 |

Measured limits for `claude-sonnet-4-6`: contextWindow 200000, maxOutputTokens 32000.

## FINDING A — `-s` is MANDATORY, not cosmetic

Without `-s`, the 2.1.245 / 2.1.218 version gap opens an INTERACTIVE MENU and exits 13.
No API call is made; the process simply waits for a keypress that never comes.

**In the pipeline this is a hang, not a failure.** A run would sit there until its timeout.
This alone would have killed the first live run, and no amount of config review would have
found it — only executing the binary did.

Consequences for the plan:
- `-s` joins the runner's declared flags in B1. It is a correctness requirement.
- The access probe becomes a PRE-FLIGHT GATE that must run before every CodeMie run, because
  a `codemie install claude` or a Claude Code auto-update re-opens this prompt at any time.
- Resolving the version gap (`codemie install claude --supported`) is a SEPARATE decision.
  Do not silently downgrade a working Claude Code without asking.

## FINDING B — `--base-url` is an SSO PROFILE SELECTOR, not a redirect

It looks up stored CodeMie credentials for whatever URL is passed. Pointing it at MockServer
fails exactly as the bogus URL did. **The step A3 mock leg does not work as designed.**

The free rehearsal is NOT lost — the insight is that a mocked run needs no CodeMie at all:

- a mocked run authenticates against nothing, so it should not use the SSO wrapper
- point PLAIN `claude` at MockServer via `ANTHROPIC_BASE_URL`, bypassing the wrapper entirely
- `CLAUDE_CMD` already comes from config, so this is a THIRD provider set — `mock` — selected
  by `EPAM_PROVIDER_SET`, with no script change at all

MUST BE PROVEN BEFORE IT IS RELIED ON. Unverified today:
- whether plain `claude` honours `ANTHROPIC_BASE_URL` against MockServer without credentials
- whether MockServer's SSE framing satisfies Claude Code's stream parser (it satisfied the
  epam-run path, which is a DIFFERENT parser — do not assume it transfers)

Until both are proven, treat the CodeMie path as having NO free rehearsal. Say so plainly
rather than planning around a capability that may not exist.

## FINDING C — RESOLVED: the CodeMie path CAN be rehearsed for $0

Proven 2026-08-25, and it overturns FINDING B's consequence. Both open questions answered YES:

1. **plain `claude` honours `ANTHROPIC_BASE_URL` and reaches MockServer** — `POST /v1/messages`
   received, confirmed in MockServer's own request log
2. **MockServer's SSE framing satisfies Claude Code's stream parser** — served a minimal valid
   Messages stream (message_start / content_block_delta / message_stop) and Claude Code returned
   `is_error:false`, `result:"OK"`, `stop_reason:"end_turn"`, RC=0

So a mocked run needs no CodeMie, no SSO and no spend. `--base-url` remains unusable (it selects
an SSO profile — FINDING B stands), but the WRAPPER is not needed for a mock: point plain
`claude` at MockServer and it answers.

### The trap that made this look impossible for hours

Every nested `claude` returned exit 0 with ZERO bytes and MockServer received nothing — and
`claude --version` behaved the same, which is why it read as an environment block rather than a
defect. It was neither. Two separate mistakes of mine:

- **stdio**: the invocation must be DETACHED (`setsid`, stdio to files). Run inline it is silent.
- **`--tools` is VARIADIC**: `--tools "" "say OK"` swallowed the prompt as a tool NAME, so
  Claude Code refused with "Input must be provided". The prompt must arrive on STDIN.

Neither is discoverable by reading. Both cost an hour of concluding the wrong thing.

### What this unlocks
- A3's mock leg is viable after all, via `ANTHROPIC_BASE_URL` rather than `--base-url`
- the `mock` provider set becomes real config work, not a hypothesis
- the CodeMie stack can be exercised end to end BEFORE any money is spent — which is exactly
  the order this plan wants: verify before the run, never via it

## FINDING D — Claude Code auto-updates, and the version gap widens by itself

Claude Code moved 2.1.245 -> 2.1.246 DURING this session. CodeMie verifies 2.1.218.

The gap is not static and no one has to act for it to grow. It is the gap that opens an
INTERACTIVE MENU and exits 13 — a HANG in a pipeline, not a failure. So:
- `-s` in the runner's alwaysFlags is not belt-and-braces, it is the only thing standing between
  a silent auto-update and a hung run
- the installer (F2) must PIN the version or disable auto-update, not merely check it once
- the access probe must be a PRE-FLIGHT GATE on every run, because the binary can change
  between runs without anyone touching the config

# PHASE B — Config declarations (NO CODE, NO EXCEPTIONS)

## THE INVARIANT

Every value below lives in JSON. No model id, turn count, effort level, ttl, compaction
threshold or `CLAUDE_CODE_*` name appears in ANY pipeline script. Scripts learn a mechanism:
"read the declaration, resolve it, pass it." A new knob is a config edit, full stop.

This is enforced by a SCANNER TEST, not by discipline (B5). If it can be grepped out of a
script, the suite fails.

## Ladder: medium — 14 seams

| rung | model | ctx | maxOut | MAX_TURNS | effort |
|---|---|---|---|---|---|
| 0 | claude-haiku-4-5-20251001 | 200k | — | 40 | medium |
| 1 | claude-sonnet-5 | 200k | 64k | 120 | high |

Ceiling is Sonnet-5. A `mid` seam never reaches Opus.

## Ladder: high

| rung | model | ctx | maxOut | MAX_TURNS | effort |
|---|---|---|---|---|---|
| 0 | claude-haiku-4-5-20251001 | 200k | — | 40 | medium |
| 1 | claude-sonnet-5 | 200k | 64k | 250 | high |
| 2 | claude-opus-5 | 200k | — | 300 | high |

Same entry as medium, higher ceiling.

## Ladder: highest — 25 seams

| rung | model | ctx | maxOut | MAX_TURNS | effort |
|---|---|---|---|---|---|
| 0 | claude-sonnet-5 | 200k | 64k | 250 | high |
| 1 | claude-opus-4-8 | 200k | — | 250 | high |
| 2 | claude-opus-5 | 200k | — | 300 | xhigh |

Skips Haiku — these 25 seams would waste a rung on it.

## claude-sonnet-4-6 IS DROPPED — confirmed 2026-08-25

Measured, not preferred: Sonnet-5 gives 64000 maxOutputTokens against Sonnet-4-6's 32000,
at slightly LOWER cost for an identical call ($0.034544 vs $0.037899). Keeping it would mean
escalating FROM the better model TO the worse one.

## `[1m]` variants are NOT used

Proven available and entitled (`claude-sonnet-5[1m]` returned contextWindow 1000000) at no
premium — $0.034556 vs $0.034544, which is noise. Not used because:
- inputs peak at 25.9k, 13% of the standard 200k window. It buys nothing today.
- `AUTO_COMPACT_WINDOW` derives from the model window. At 200k runaway context self-limits
  through compaction; at 1M it runs five times further first. After a 1,486-turn runaway,
  the smaller window is a SAFETY NET, not a limitation.
Reach for `[1m]` deliberately (a GitIngest whole-codebase pass), never as a default.

## B1 — the complete declaration, `orchestrations/config/llm-defaults.json`

Per-RUNG settings live in the ladder because the same model carries different budgets on
different ladders (sonnet-5 is 120 turns on medium, 250 on high). Per-MODEL intrinsics live
in modelOverrides. Nothing is duplicated; nothing is in a script.

```json
{
  "ladderTierOrder": ["medium", "high", "highest"],

  "ladders": {
    "medium": {
      "startModel": "claude-haiku-4-5-20251001",
      "modelLadder": ["claude-sonnet-5"],
      "rungs": [
        { "rung": 0, "maxIterations": 40,  "reasoningEffort": "medium" },
        { "rung": 1, "maxIterations": 120, "reasoningEffort": "high" }
      ]
    },
    "high": {
      "startModel": "claude-haiku-4-5-20251001",
      "modelLadder": ["claude-sonnet-5", "claude-opus-5"],
      "rungs": [
        { "rung": 0, "maxIterations": 40,  "reasoningEffort": "medium" },
        { "rung": 1, "maxIterations": 250, "reasoningEffort": "high" },
        { "rung": 2, "maxIterations": 300, "reasoningEffort": "high" }
      ]
    },
    "highest": {
      "startModel": "claude-sonnet-5",
      "modelLadder": ["claude-opus-4-8", "claude-opus-5"],
      "rungs": [
        { "rung": 0, "maxIterations": 250, "reasoningEffort": "high" },
        { "rung": 1, "maxIterations": 250, "reasoningEffort": "high" },
        { "rung": 2, "maxIterations": 300, "reasoningEffort": "xhigh" }
      ]
    }
  },

  "modelOverrides": {
    "claude-haiku-4-5": {
      "matchOn": "model", "matchSubstring": "claude-haiku-4-5",
      "thinking": "adaptive", "promptCacheTtl": "1h",
      "autoCompressAt": 150000, "maxOutputTokens": 32000
    },
    "claude-sonnet-5": {
      "matchOn": "model", "matchSubstring": "claude-sonnet-5",
      "thinking": "adaptive", "promptCacheTtl": "1h",
      "autoCompressAt": 150000, "maxOutputTokens": 64000
    },
    "claude-opus-4-8": {
      "matchOn": "model", "matchSubstring": "claude-opus-4-8",
      "thinking": "adaptive", "promptCacheTtl": "1h",
      "autoCompressAt": 150000, "maxOutputTokens": 64000
    },
    "claude-opus-5": {
      "matchOn": "model", "matchSubstring": "claude-opus-5",
      "thinking": "adaptive", "promptCacheTtl": "1h",
      "autoCompressAt": 150000, "maxOutputTokens": 64000
    }
  },

  "finalFallback": { "model": "claude-sonnet-5", "provider": "codemie-claude" },

  "runners": {
    "codemie-claude": {
      "alwaysFlags": ["-s"],
      "env": {
        "CLAUDE_CODE_MAX_TURNS":           "maxIterations",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS":   "maxOutputTokens",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "autoCompressAt",
        "CLAUDE_CODE_PROMPT_CACHE_TTL":    "promptCacheTtl",
        "CLAUDE_CODE_EFFORT_LEVEL":        "reasoningEffort",
        "MAX_THINKING_TOKENS":             "maxThinkingTokens"
      },
      "flags": { "--timeout": "timeoutSeconds" }
    }
  }
}
```

NOTES ON SPECIFIC VALUES, so none of them look arbitrary later:
- `maxOutputTokens` is the model's MEASURED ceiling (probe: sonnet-4-6 32000, sonnet-5 64000).
  Opus values are ASSUMED equal to sonnet-5 and MUST be measured before use — see B4.
- `autoCompressAt` 150000 against a 200000 window is an OVERFLOW GUARD near the ceiling, not
  a token-saving device: compaction destroys the cacheable prefix. Observed input p90 is 19k,
  so it should never fire.
- `promptCacheTtl` "1h" is already the measured default. Declaring it makes it explicit and
  survives an upstream default change.
- `-s` is in `alwaysFlags` because of FINDING A: without it the wrapper BLOCKS on a prompt.
  It is a correctness requirement, not a preference.
- `--base-url` is deliberately ABSENT: FINDING B shows it selects an SSO profile rather than
  redirecting. Declaring it would break the run.

## B2 — projects declare only their differences  *** CORRECTED 2026-08-25 ***

THERE ARE FOUR PROJECTS, NOT THREE. Established by the C-T1 baseline capture, and every
earlier "three projects" statement in this plan was wrong — including the scope decision.

| project | llm-settings.json | config.env | today's ladder source |
|---|---|---|---|
| metrolinx | YES | YES | its own `ladders` block |
| mock3 | YES | YES | its own `ladders` block |
| hello-dolly | YES | **NO** | its own `ladders` block |
| skyscanner | **NO** | YES | resolves to `{}` — ladders come from config.env PINS ALONE |

TWO CONSEQUENCES THAT CHANGE THE WORK:

1. **skyscanner is structurally unlike the others.** It has no settings file at all, so
   "delete its ladders block so it inherits" is meaningless — there is nothing to delete.
   It inherits automatically the moment the base declares ladders, which means the base
   silently becomes its ladder source. That is a BEHAVIOUR CHANGE for skyscanner, not a
   no-op, and its config.env pins may then conflict with the inherited chain. It needs its
   own before/after check, not the same one as metrolinx.

2. **hello-dolly has no config.env**, so it never receives a provider map, gate provider or
   fallback. It cannot follow the `config.<set>.env` half of the swap mechanism. Decide
   explicitly: give it a config.env, or exclude it from the provider sets and say so.

NEITHER was visible from reading the config. Only resolving all four exposed it.

## B3 — no value has two homes

Anything a script needs is read from this file. `EPAM_*` operator overrides still outrank it,
unchanged — that is an operator escape hatch, not a second source of truth.

## B4 — Opus MEASURED 2026-08-25 ($0.0550). Assumptions CONFIRMED.

| model | context | maxOutputTokens | verdict |
|---|---|---|---|
| claude-opus-4-8 | 200000 | 64000 | as assumed |
| claude-opus-5 | 200000 | 64000 | as assumed |

No change to the B1 JSON.

CORRECTION WORTH KEEPING: raw `total_cost_usd` made Opus look CHEAPER than Sonnet
($0.02248 vs $0.034544). That was an ARTIFACT — each model receives a different system
prompt size, so the probes were not comparable. Normalised per written token:

| model | cache-write tokens | $/M written | implied base |
|---|---|---|---|
| claude-sonnet-4-6 | 6305 | 6.01 | ~$3.00/M |
| claude-sonnet-5 | 8586 | 4.02 | ~$2.01/M |
| claude-opus-4-8 | 2214 | 10.15 | ~$5.07/M |
| claude-opus-5 | 3221 | 10.11 | ~$5.06/M |

Opus is ~2.5x Sonnet-5 per token, as expected. NEVER compare `total_cost_usd` across models
on a trivial prompt — it measures prompt size, not price.

This also STRENGTHENS the sonnet-4-6 removal: sonnet-5 is ~33% cheaper per token AND has
double the output ceiling.

CAVEAT: `total_cost_usd` is computed CLIENT-SIDE by Claude Code from its own price table.
Through the CodeMie proxy this may not be what EPAM actually bills. Ratios are sound for
relative reasoning; the absolute figures are not an invoice. Real billed cost must come from
CodeMie's own analytics before any cost claim is made to anyone.

## B6 — FINISH THE LADDER MIGRATION. This is unfinished work, not new scope.

The ladder design came AFTER skyscanner. metrolinx, mock3 and hello-dolly were migrated to
declarative `llm-settings.json`. **skyscanner was not, and the code that made the old
mechanism work was left in place**, so nothing ever failed and the drift stayed invisible.

Evidence:

| project | real per-tier pins in config.env |
|---|---|
| metrolinx | none (an empty `EPAM_MODEL_LADDER=` only) |
| mock3 | none (same) |
| hello-dolly | no config.env at all |
| **skyscanner** | **3 — medium and high pinned to MiniMax/glm chains** |

What skyscanner actually has today, and none of it is deliberate:
- chains for medium and high, pinned in config.env
- NO `highest` tier at all — the 25 seams that resolve there have nothing declared
- NO `startModel` for any tier, because `startModel` lives in the settings file it lacks.
  Its own config.env:30 comment says removing the pins "hands the decision back to the
  ladder" — but the ladder has no start to hand it to.

### The guard is right; the committed pin is not

`model-ladders.sh`: `[ -n "${!_var:-}" ] && continue` — "an ALREADY-SET chain is an operator
override and outranks the declaration". Correct for an operator overriding AT LAUNCH. Wrong
as a home for a committed declaration: that is two homes for one value, which is the exact
condition the inheritance work exists to end.

### B6 steps

1. Give skyscanner an `llm-settings.json` declaring medium, high AND highest, with a
   `startModel` per tier — its current chains, moved verbatim, nothing redesigned.
2. Delete the three `EPAM_MODEL_LADDER_*` pins from its config.env.
3. Prove equivalence BEFORE and AFTER against the C-T1 baseline: `env-skyscanner.txt` must
   still resolve the same medium and high chains. `highest` and the `_START` values are
   ADDITIONS — they are the gap being closed, and must be reviewed as changes, not slipped in.
4. Ship a test: NO project may pin `EPAM_MODEL_LADDER_<TIER>` in a committed config.env.
   The runtime operator override stays; the committed second home does not.

### Why this blocks the CodeMie work

Without it, skyscanner gets PARTIAL inheritance when the base declares Claude ladders:
medium and high stay on MiniMax because the pins outrank the base, while highest — unpinned —
becomes Claude. One project, two stacks, and it LOOKS configured. That is worse than either
outcome and would not surface until a `highest` seam ran.

## B5 — the scanner test (this is what actually enforces the invariant)

Ships as a test, runs in the suite:
- NO model id matching the CodeMie catalogue appears in any `orchestrations/scripts/**`
- NO `CLAUDE_CODE_*` or `MAX_THINKING_TOKENS` literal appears in any pipeline script
- NO bare turn count, ttl or effort literal appears where a setting is resolved
- every setting NAMED in `runners.*.env` RESOLVES for every model in every ladder — a
  declaration pointing at a setting nobody defines is a silent no-op, which is the exact
  shape of the defect this plan exists to remove
- every rung index in `rungs[]` has a model in `startModel` + `modelLadder`, and vice versa

# PHASE C — The swap mechanism (your requirement: nothing is lost)

C1. Preserve today's stack VERBATIM as the `openrouter` set:
    `config/llm-defaults.openrouter.json` + `projects/<p>/config.openrouter.env`.
C2. Add the CodeMie set alongside: `llm-defaults.codemie.json` + `config.codemie.env`.
C3. `EPAM_PROVIDER_SET` selects. Both sets always present; nothing is copied over anything.
    NOTE: `EPAM_LLM_DEFAULTS_FILE` ALREADY exists in the resolver as the base selector, so
    half of this is built. The new part is selecting the project `config.env` to match.
C4. The three provider-dependent surfaces must ALL move together or the swap is partial —
    which is worse than either state:
      - base settings   (llm-defaults)
      - project values  (provider map, gate provider, fallback)
      - EPAM_ORCHESTRATION_PROVIDER  (already config-driven, no script hardcodes it)

## C0 — HOT SWAP IS THE REQUIREMENT, NOT A NICE-TO-HAVE

Stated 2026-08-25: if CodeMie tokens run out mid-programme, the openrouter stack must be
back ON THE AIR IN SECONDS. That sets hard constraints on the design:

- ONE command. Set `EPAM_PROVIDER_SET=openrouter`, relaunch. Nothing else.
- NO build step. A swap that needs `tsup` is not a hot swap.
- NO test run. The suite must already have proven the swap; an incident is not the time.
- NO git operation. No commit, no tag, no checkout, no stash. Explicitly ruled out —
  and it would have failed anyway, since `projects/*/config.env` is GITIGNORED and a tag
  would never have captured it.
- NO file is copied over another. Both sets live on disk permanently, side by side, so
  there is no half-written state to recover from if the swap is interrupted.
- The baseline in `change-log/baseline-openrouter-2026-08-25/` is the proof of correctness:
  after swapping back, those checksums must match.

## C-tests — the swap is tested, not assumed

C-T1. `EPAM_PROVIDER_SET=openrouter` reproduces TODAY's resolved settings BYTE FOR BYTE, for
      every project and every tier. This is the gate. Captured before any change lands.
C-T2. `EPAM_PROVIDER_SET=codemie` resolves the Claude ladders for every project.
C-T3. Round trip: openrouter -> codemie -> openrouter returns to the byte-identical baseline.
      Proves the swap is reversible, not just forward-working.
C-T4. A half-swap is REFUSED, not tolerated: a set naming a provider whose `config.<set>.env`
      is missing must abort with a named error, never fall through to a default.
C-T5. An unknown `EPAM_PROVIDER_SET` aborts loudly; it must never silently pick a default.
C-T6. Every value the pipeline reads from a set exists in BOTH sets — a scanner test, so a
      value added to one and forgotten in the other fails the suite rather than a run.
C-T7. Unset `EPAM_PROVIDER_SET` behaves exactly as today (openrouter). No forced migration.
C-T8. The swap path invokes NO build, NO test run and NO git command — asserted by scanning
      the swap path itself, so a later "convenience" addition fails the suite.
C-T9. skyscanner SPECIFICALLY — CORRECTED: its config.env pins OUTRANK the base (the
      override guard), so it does NOT wholly inherit. It gets PARTIAL inheritance: medium and
      high stay MiniMax/glm, highest becomes Claude. Assert the partial state is impossible —
      either B6 has run and the pins are gone, or the suite fails.
C-T10. hello-dolly is EXCLUDED from the provider sets — RESOLVED 2026-08-25.
      Evidence: it is a TEST FIXTURE. It has runs/, seed/ and prd.authored.json, and every
      reference to it outside test/ is a COMMENT recording a past incident — no production
      code names it. It has no config.env because no operator launches it; tests drive it.
      It keeps its own llm-settings.json ladders, which outrank the base, so it stays on
      MiniMax/glm under either set and mock e2e tests keep their fixed stack. Assert the
      exclusion so it is a decision on the record, not an omission nobody noticed.

---

# PHASE D — Wiring (the only code changes)

D1. Teach `claude.sh` to apply a runner's declared settings generically: read the map,
    resolve each name through the ladder, export env and append flags. One function, no
    literals. MUST be inert when no declaration exists — that is what protects the other path.
D2. DELETE the dead `--max-turns` flag build (`claude.sh:9290`) and the three hardcoded
    `STORY_MAX_TURNS=""` (530/536/542). That flag does not exist in Claude Code 2.1.245.
D3. Wire `invoke.py --cache-system` — built, plumbed, called by nobody — or retire the SDK
    path explicitly. A built capability is wired or removed, never left dormant.
D4. Add `codemie-claude` to `providers.json` `known`. Live bug today: preflight rejects a PRD
    assigning it while two call sites accept it.
D5. Repoint `run-agent-orchestration.sh:402` from the fork to `claude.sh`.
    *** CORRECTION TO v4: v4 also said "set CLAUDE_CMD=codemie-claude". That was WRONG — it
    would hardcode a provider choice in a script and break the swap. CLAUDE_CMD keeps coming
    from config via EPAM_ORCHESTRATION_PROVIDER. Only the wrapper mapping changes. ***
D6. Delete `orchestrations/scripts/codemie-claude.sh` — 1,602 lines, 10,712 behind its origin,
    and it sets STORY_MAX_TURNS=10/30, which would FAIL on the installed Claude Code.
D7. Correct `INSTRUCTIONS.md:92`, which calls that fork "an identical clone".
D8. Update the test files referencing the fork.

## D-tests

- a runner's declared env reaches the child process with the ladder's resolved values
- a knob ABSENT from the declaration is NOT passed (over-inclusion — the direction presence
  tests cannot catch)
- no `CLAUDE_CODE_*` literal, model id or turn count appears in any pipeline script
- every tier resolves a ladder; every model in a tier has an escalation edge out
- with no `runners` declaration, the openrouter path's child env is UNCHANGED

---

# PHASE E-PROV — Retire the standalone provider variables

**Agreed 2026-08-25.** Not optional — "it needs to be done". Timing is "when it makes sense",
so it is sequenced rather than deferred.

## The rule that replaces them

> The SET declares the runner. The LADDER declares the model. The MAP derives the provider
> from the model.

No standalone provider variable anywhere. Each of the three below is a SECOND source for a
decision something else already makes, and two sources for one decision is how a value silently
disagrees with itself.

## The three, and why each goes

| variable | what it does today | why it goes |
|---|---|---|
| `ORCH_GATE_PROVIDER` | passed DIRECTLY on gate calls (`vc-coverage-check.sh:114` sends `--provider $ORCH_GATE_PROVIDER --model $_vcc_model`) | the MODEL comes from the ladder and the PROVIDER from an env var — two independent sources. `resolve_model_provider()` exists at claude.sh:6752 and this gate never calls it. It agrees with the map today only by COINCIDENCE: the codemie overlay happens to set a matching value |
| `SPEC_MODE_PROVIDER` | a routing override — "skip MiniMax entirely" | routing is exactly what `EPAM_MODEL_PROVIDER_MAP` expresses. A bypass AROUND the map is not an override, it is a competing map |
| `EPAM_ORCHESTRATION_PROVIDER` | selects the WRAPPER at run-agent-orchestration.sh:401, and is ai-run.sh's default provider | superseded by the SET's `runners` declaration, NOT by the ladder — this runs before any story, seam or model exists, so there is no ladder to ask |

## IF ONE SURVIVES, IT IS RENAMED

Operator instruction: "if one var stays it needs to be named properly, current name is stupid."

The only candidate is the wrapper selector, and its name is wrong on its own terms: it does not
name a PROVIDER, it names which RUNNER executes. `EPAM_ORCHESTRATION_PROVIDER` describes neither
what it selects nor when. The replacement name is an OPERATOR DECISION and must be asked, not
invented — that is the rule this whole audit produced.

## Order matters, and getting it backwards breaks live runs

DERIVATION FIRST, REMOVAL SECOND. `ai-run.sh` currently FAILS with "no provider configured" when
neither `AI_PROVIDER` nor `EPAM_ORCHESTRATION_PROVIDER` is set. Removing the key before
derivation is wired everywhere turns that into a hard stop on every live path.

1. wire `resolve_model_provider()` into every call site that HAS a model in hand
2. prove each one derives the same provider it was passed — before removing anything
3. move the spec-mode routing decision into the map
4. derive the wrapper from the set's `runners` declaration
5. only then remove the keys, and rename any that survive
6. re-run BOTH baselines: a provider resolved differently is a behaviour change, not a cleanup

## Scope, measured

`ORCH_GATE_PROVIDER` 49 files, `EPAM_ORCHESTRATION_PROVIDER` 32, `SPEC_MODE_PROVIDER` 25 —
mostly tests and launchers rather than engine code, but not a small change. It should not land
while the CodeMie stack is still unproven on a real run: two unproven things at once means a
failure cannot be attributed.

# PHASE E — Remove DashScope, then rename openrouter -> openrouter

`OpenRouterProvider` is dual-mode: OpenRouter or DashScope (`OpenRouterProvider.ts:169`). DashScope is
NEVER configured — no `DASHSCOPE_API_KEY` in any env file; `OPENROUTER_API_KEY` is set. Every
model routed to it (`glm-*`, `kimi-*`, `deepseek/*`, `z-ai/*`) is an OpenRouter model. The
name is wrong. There is already a `test/unit/providers/openrouter-sticky-session.test.ts`
testing this provider — the codebase has been working around the name.

## Three meanings, only one renames

Approximate, from a classified sweep of 669 matching lines (excluding node_modules, .git,
logs, cassettes, backups). Categories overlap; these are indicative, not exact — the precise
per-token list is produced in E1 before any edit.

| meaning | example | action |
|---|---|---|
| PROVIDER identifier | `OpenRouterProvider` 124, `providers/openrouter` 40, `EPAM_openrouter_MODEL_OVERRIDE` 9, `ORCH_GATE_PROVIDER=openrouter` 7, `SPEC_MODE_PROVIDER=openrouter` 6, `EPAM_ORCHESTRATION_PROVIDER=openrouter` 6, `EPAM_FINAL_FALLBACK_PROVIDER=openrouter` 3, `EPAM_API_KEY_openrouter` 3 | **RENAME** |

## E0 — Remove DashScope first (it makes the rename honest)

DashScope is Alibaba Cloud's own API for OpenRouter models. It is the reason the class is called
`OpenRouterProvider`. It is DEAD: no `DASHSCOPE_API_KEY` in any env file, and every model routed
here (`glm-*`, `kimi-*`, `deepseek/*`, `z-ai/*`) is an OpenRouter model, not a OpenRouter one.

Scope — 23 references, 4 real files (verified, not estimated):

| file | what goes |
|---|---|
| `src/config/EnvVarOverrides.ts` | the `DASHSCOPE_API_KEY` / `openrouter_API_KEY` fallbacks in the key chain :92 |
| `orchestrations/scripts/claude.sh` | `DASHSCOPE_API_KEY` passed to the child :10228 |
| `test/unit/providers/openrouter-sticky-session.test.ts` | the "DashScope mode sends neither" case :76 |

TWO THINGS THIS MUST NOT BREAK — both are tested before the deletion, not after:

1. `config.baseURL` MUST still win. `OpenRouterProvider.ts:169` is
   `config.baseURL || (openRouterMode ? OPENROUTER : DASHSCOPE)`. Removing the mode must
   leave `config.baseURL` taking precedence — the MockServer replay depends on it through
   `OPENROUTER_BASE_URL`. Lose that and every free rehearsal dies silently.
2. `openRouterMode` currently GATES two live features: the sticky-session header/body pair
   and `EPAM_OPENROUTER_EXACTO`. Deleting the flag makes both unconditional. That is the
   intended end state, but it is a behaviour change and needs its own test — it is not a
   no-op cleanup.

E0 tests:
- a request with `config.baseURL` set still targets that URL (the MockServer contract)
- with no `baseURL`, the provider targets OpenRouter
- the sticky-session header is sent on every request now that the mode gate is gone
- no `DASHSCOPE_*` or `openrouter_API_KEY` symbol remains anywhere in `src/` or `orchestrations/`
- an operator with only `DASHSCOPE_API_KEY` set gets a NAMED error, never a silent
  unauthenticated call

E1. Build the classifier FIRST and ship it as a test — the same "fix the class, not the site"
    method. It prints every site with its category. Reviewed before a single edit.
E2. Rename the provider identifier `openrouter` -> `openrouter` in code, config and PRD values.
    `OpenRouterProvider`, and the test files to match.
E4. Rename env vars: `EPAM_API_KEY_openrouter` -> `EPAM_API_KEY_OPENROUTER` (which ALREADY exists
    and is already read at `OpenRouterProvider.ts:727` — so this is a convergence, not a new name),
    `EPAM_openrouter_MODEL_OVERRIDE` -> `EPAM_OPENROUTER_MODEL_OVERRIDE`.
E5. (answered by E0 — DashScope is removed, not documented as dormant)
E6. Accept the old identifier for one release with a loud deprecation, so an operator's
    existing `config.env` does not silently resolve to nothing. A silent miss here picks the
    WRONG PROVIDER mid-run.

## E-tests

- the classifier finds ZERO provider-identifier sites left after the rename
- every `openrouter*` MODEL id still resolves and routes correctly — the negative assertion
- the `openrouter` CLI path is untouched
- a config using the OLD identifier still works AND warns
- `EPAM_PROVIDER_SET=openrouter` STILL reproduces the byte-identical baseline after the
  rename (C-T1 re-run — the rename must not move behaviour)

---

# Order, and what it costs

| phase | cost | gate |
|---|---|---|
| A (probe) | $0 mocked, then ONE trivial real call | stated and approved first |
| B (config) | $0 | |
| C (swap + tests) | $0 | C-T1 baseline captured BEFORE any change |
| D (wiring) | $0 | |
| E (rename) | $0 | C-T1 re-run after |
| mocked pipeline | $0 | |
| live run | stated before it happens | your approval |

Everything except A4 and the live run is free.

# Recommended sequencing

C-T1 FIRST — capture the byte-identical baseline before anything changes. Then A (does
CodeMie even work), then B/C/D, then E last. E is a rename: it should move no behaviour,
and it is provable only against a baseline captured while the old names still exist.

# PHASE G — `pipeline --jira AMSD-1234`. One parameter, everything else derived.

**Requested 2026-08-25.** One flag. No project, no phase, no provider, no mode.

## Everything else is DERIVED, and it already can be

`orchestrations/projects/metrolinx/config.env` declares `JIRA_PROJECT_KEY=AMSD`. So the
ticket's own prefix resolves the project by SCANNING the declarations — no prefix-to-project
map in any script, and onboarding a project stays a config edit.

| what | derived from |
|---|---|
| project / codeline | the ticket prefix, matched against each project's declared `JIRA_PROJECT_KEY` |
| provider set | `EPAM_PROVIDER_SET`, else the registry's `defaultSet` |
| deployment mode | what the installer provisioned (F5) |
| the ladders, budgets, prompts | the project's own declarations, as today |
| the launcher | `run-agent-orchestration.sh` — ALWAYS the tested one, never hand-rolled |

Ambiguity is an ERROR listing the real candidates. Two projects claiming one prefix, or none
claiming it, must stop the run — guessing here starts a paid run against the wrong codeline.

## It must SET the JQL, not inherit a pinned one

`JIRA_JQL="issue = AMSD-1919"` is pinned in config today, so changing ticket means EDITING
CONFIG before every run — and forgetting to means silently running the previous ticket. The
script derives the JQL from its argument and overrides the pin. That is the whole point of a
one-parameter launcher.

## It is a WRAPPER. It resolves, checks, reports, asks, delegates — and runs nothing itself.

The value is not the shorter command; it is that every way a run can fail BEFORE it starts is
caught here, named, and made actionable. Today those failures surface as a stack trace, a
hang, or worse — a paid run that proceeds on the wrong thing.

### Every precondition it checks, and what it says

| condition | today | the wrapper |
|---|---|---|
| no `.env` | scripts read empty values and continue | names the file and what it must contain |
| missing API key / SSO expired | discovered mid-run, after spending | checks BEFORE asking to launch; for CodeMie, reports SSO expiry (measured: 20h) and the refresh command |
| Node 20 absent / nvm path moved | a cryptic failure | names the expected interpreter and the path it looked in |
| `jq` absent | `model-ladders.sh` exports NO ladders and returns 1 | names it — this one has bitten this machine before |
| Docker absent | FOUR hard preflight failures, run aborts | resolves the deployment mode (F5) and reports what is degraded |
| unknown ticket prefix | — | lists the declared `JIRA_PROJECT_KEY`s |
| prefix claimed twice | — | names both projects, picks NEITHER |
| unknown `EPAM_PROVIDER_SET` | the resolver throws | catches it and lists the declared sets |
| leftover run state | a run starts on the previous run's state | reports it and points at the pre-run reset |
| no free rehearsal in this mode | discovered when the bill arrives | says so BEFORE asking to launch |

### The rules that keep a convenience from becoming a hazard

- **It REPORTS; it does not REPAIR.** A wrapper that silently installs a missing dependency,
  writes a credential, or clears state has changed the run the operator thought they approved.
  Every finding names the fix; the operator runs it.
- **It does not weaken the real preflight.** It runs the SAME `preflight-check.sh`, and a
  required-service failure still fails. Its own checks are EARLIER and FRIENDLIER, never
  a substitute — a second, laxer gate is how a gate stops meaning anything.
- **Every failure exits non-zero with ONE actionable line.** No stack trace, no partial launch.
- **It reports ALL findings, not the first.** Fixing one blocker only to hit the next is the
  experience this exists to remove.
- **A check it cannot perform is reported as UNKNOWN, never as passed.** Absence of evidence
  is the failure mode this whole plan keeps finding.

## What it must NOT quietly do

- **NOT skip the launch gate.** A one-flag launcher that starts a paid run is exactly the
  shape that spends money without the operator seeing what they approved. It PRINTS the
  resolved parameters — project, ticket, provider set, models, mode, what is degraded — and
  WAITS for a yes.
- **NOT hide the spend.** If the mode has no free rehearsal (F5: no Docker means no
  MockServer), it says so BEFORE asking.
- **NOT re-implement the pipeline.** It resolves, prints, asks, and delegates. Every line of
  orchestration logic in it is a line that will drift from the launcher that is tested.
- **NOT name a project, prefix, model or phase.** The scanner test covers it like any other
  script.

## G tests

- a ticket whose prefix matches ONE project resolves that project — asserted by EXECUTION
- EACH precondition above fails with a NAMED, actionable message — one test per row, driven by
  removing that precondition, not by reading the script
- ALL findings are reported in one pass, not just the first
- it never repairs: with a dependency missing, nothing is installed, written or cleared
- with Docker absent and the mode standalone, it reaches the launch prompt and names the
  degradations; with the mode full, it refuses
- a prefix matching NONE fails, listing the declared keys
- a prefix matching TWO fails, naming both — never picks one
- the derived JQL targets the GIVEN ticket, not the pinned one
- it refuses to launch without an explicit yes
- it delegates to `run-agent-orchestration.sh` and adds no orchestration of its own
- no project, prefix, model or phase literal appears in it

## Sequencing

After F. The one-parameter launcher is a FRONT DOOR onto a working install; building it before
the installers and the deployment modes exist would mean deriving a mode nothing provisions.

# Verified by the probe — no longer open

- the CodeMie proxy DOES preserve caching: 19.3x cheaper on a repeat prefix, 1h TTL default
- `--max-budget-usd` DOES survive the wrapper's arg forwarding, and the cap is enforced
- `CLAUDE_CODE_MAX_TURNS` IS enforced, not merely accepted
- the 2.1.245 / 2.1.218 gap DOES break things — see FINDING A

# PHASE F — Two installers, one per provider set, each WITH or WITHOUT Docker

**Requested 2026-08-25.** One installer for CodeMie, one for openrouter/minimax. They are the
other half of the hot-swap requirement: a set you cannot INSTALL is not a set you can swap to.

## The rule they must obey

An installer PROVISIONS a provider set; it does not DECLARE one. Every model id, ladder, key
name and endpoint is read from the set's config. An installer that names a model has become a
second home for a declaration — the exact defect B6 removed. The B5 scanner covers installers.

## F1 — shared skeleton (both installers)

Same phases, different payload, so neither drifts from the other:

1. **Preconditions** — Node 20 at the declared path, `jq`, `git`. Node and jq have BOTH gone
   missing on this machine before (nvm path lost, jq needing re-download after reboot), so
   the installer REPAIRS rather than reports.
2. **Provider provisioning** — the set-specific part (F2 / F3).
3. **Credential check** — verify presence and validity. NEVER write, echo or commit a key.
4. **Config selection** — set `EPAM_PROVIDER_SET`, confirm the resolver returns that set's
   ladders for every project.
5. **Gate** — run the set's access probe. EXIT NON-ZERO if it fails. An installer that
   "succeeds" onto a stack that cannot answer is worse than one that fails.

## F2 — CodeMie installer

Grounded in what the Phase A probe actually found, not in expectation:

- install/verify the `codemie` CLI and `codemie-claude` wrapper
- **PIN Claude Code to the CodeMie-verified version.** 2.1.245 is installed, CodeMie verifies
  2.1.218. FINDING A: the gap opens an INTERACTIVE MENU and exits 13 — in a pipeline that is
  a HANG, not a failure. The installer must resolve this deliberately (pin, or accept-and-
  document), never leave it to be discovered mid-run.
- run `codemie profile status`; SSO expires (measured: 20h), so the installer must report the
  expiry and the refresh command, and the pre-flight gate must re-check it every run
- assert `-s` is in the runner's `alwaysFlags` — without it every invocation can block
- run the access probe: connectivity, JSON shape, `total_cost_usd` present, `MAX_TURNS`
  ENFORCED (halt-or-honour), cache read on a repeat prefix
- **NOT `--base-url`.** FINDING B: it selects an SSO profile, it does not redirect.

## F3 — openrouter/minimax installer

- verify `OPENROUTER_API_KEY` / `MINIMAX_API_KEY` are present and valid
- provision `jq`, Node 20, and the epam CLI build the `ai-run` path needs
- select the `openrouter` set and assert it reproduces the C-T1 baseline BYTE-IDENTICAL
  (`change-log/baseline-openrouter-2026-08-25/MANIFEST.md5`). The installer is the natural
  place to prove the swap target is intact, because that is exactly when it matters.
- its access probe is the mocked pipeline, which costs $0 — this set HAS a free rehearsal,
  and the CodeMie set may not (see FINDING B)

## F5 — WITH and WITHOUT Docker. Without it, the pipeline must NOT fall over.

**Requested 2026-08-25.** Each installer offers both. This is not a packaging preference: today
a Docker-less machine cannot run the pipeline AT ALL.

### What was verified, not assumed

`preflight-check.sh` HARD-FAILS on four Docker-backed services:

| check | line | today |
|---|---|---|
| nginx serves `/logs/healing-events.jsonl` | 6c | `fail` |
| `build-info.json` has `metrics.selfHealing` | 6d | `fail` |
| langfuse serving | observability loop | `fail` |
| grafana serving | observability loop | `fail` |

The observability loop states the consequence in its own comment: "a run aborts at the tier
launcher's own preflight when these are down". So Docker is not optional today — it is a
silent hard dependency discovered only at launch.

### The shape — a mode is DECLARED, never branched on

Same rule as the provider sets: no script names a mode or a service. A declaration says which
services a mode REQUIRES and which it can do without:

```
deployment modes:
  full        requires: dashboard, langfuse, grafana, mockserver
  standalone  requires: (none)   degraded: dashboard, langfuse, grafana, mockserver
```

`preflight` fails only on a mode's REQUIRED services. A degraded service is REPORTED — loudly,
once, naming what is lost — and the run proceeds.

### What is genuinely lost without Docker, stated plainly

- **Langfuse tracing** — and with it the recorded-run library the mocked rehearsal reads
- **The dashboard** — no human-visible "what is running now"
- **MockServer** — so THE FREE REHEARSAL IS GONE. On a standalone install every run is a paid
  run. That is the fact an operator most needs told before they start, not after.
- **Cost/observability evidence.** Observability is priority #2 and real cost tracking is
  priority #1; a mode that quietly drops both would be the worst kind of convenience.

None of these stop the pipeline producing work. All of them must be announced at launch.

### F5 steps

1. Declare the modes and each service's requirement level in config — one file, no service
   name in any script.
2. Make `preflight` read that declaration instead of its current fixed list. Required missing
   -> fail. Degraded missing -> WARN, naming exactly what the run loses.
3. Make the tracing, dashboard and cassette paths tolerate absence — verified by RUNNING them
   with the services down, never by reading the code.
4. Each installer takes the mode as an argument and provisions accordingly.
5. A standalone install must print, at the end, the list of capabilities it does NOT have.

### F5 tests

- with every service down and mode=standalone, preflight EXITS 0 and names each degradation
- with mode=full and a service down, preflight FAILS — the strict path is not weakened
- a service is never named in a script — only in the declaration (scanner test)
- the pipeline COMPLETES a mocked-free run with langfuse and the dashboard absent, asserted by
  EXECUTION
- a standalone run states it has no free rehearsal BEFORE any paid call

### The trap to avoid

Making preflight lenient is easy and wrong. If a required service silently becomes optional,
the checks stop being a gate at all — the same fail-open as a missing ladder tier reported to
stderr and continued past. The mode must be DECLARED by the operator, and the strict mode must
stay strict.

## F4 — what the installers must NOT do

- NOT write credentials to any tracked file
- NOT commit, tag, or touch git — same rule as the hot swap
- NOT install BOTH sets' providers as a side effect; each installs its own
- NOT be a prerequisite for the hot swap. **The swap assumes both are ALREADY installed.**
  Installing during an incident is not a hot swap — that is the whole point of C0.

## F-tests

- each installer is IDEMPOTENT: running it twice changes nothing the second time
- each FAILS LOUDLY on a missing precondition — never a partial install reported as success
- neither contains a model id, ladder, endpoint or key literal (B5 scanner)
- the CodeMie installer FAILS when the Claude Code version gap would open the blocking prompt
- the openrouter installer FAILS if the C-T1 baseline no longer reproduces
- after either, `EPAM_PROVIDER_SET` resolves that set's ladders for every project

## Sequencing

Phase F comes AFTER C and D. An installer provisions a mechanism that must already exist and
be tested; building it first would encode the design before it is settled.

# OPEN DEFECT found during B6 — a missing tier FAILS OPEN

`seam-invocation.js:402` documents it in its own words, from a live incident:

> "Live on hello-dolly: twenty seams asked for HIGHEST, the project declared only high and
>  medium, and all twenty ran with no escalation chain because the miss below is reported
>  and then continued past."

The mechanism is still there. When a position cannot be resolved, the code writes a warning
to stderr and carries on; `if (rungs)` then simply skips, so the seam runs with NO LADDER.
A warning nobody reads is not a gate.

This is why skyscanner's missing `highest` was invisible for as long as it existed, and why
change 30 closed a gap rather than fixed a failure — nothing was ever failing loudly.

NOT CHANGED, and deliberately so: making it fail closed could halt runs that currently limp,
which is a behaviour change needing its own decision. Raised, not fixed. Two options when it
is taken up:
  a. fail closed — a seam whose declared position resolves to nothing HALTS
  b. keep open but make it loud — record the miss as a run artefact, not a stderr line
     nobody reads, so it surfaces in the run report

# Still unverified — will not be asserted

- whether `total_cost_usd` matches what CodeMie/EPAM actually bills (client-side estimate)

- whether plain `claude` + `ANTHROPIC_BASE_URL` reaches MockServer without credentials
- whether MockServer's SSE framing satisfies Claude Code's stream parser
- whether `temperature` has any supported lever on this path; treated as lost
- whether the other declared knobs (`AUTO_COMPACT_WINDOW`, `PROMPT_CACHE_TTL`,
  `EFFORT_LEVEL`, `MAX_THINKING_TOKENS`) are ENFORCED. Only MAX_TURNS was proven.
  Each gets the same halt-or-honour test before it is trusted — an accepted-but-ignored
  knob is the exact failure this plan exists to prevent.
