# Estimation Model — AI Agent Execution Forecasting

## Purpose

Predict four metrics per story before orchestration runs:

| Output | Unit | Stored in prd.json as |
|--------|------|-----------------------|
| AI execution time | minutes | `estimatedAiMinutes` |
| Cost | USD | `estimatedCost` |
| Tokens | count | `estimatedTokens` |
| Turns | count | `estimatedTurns` |

Human-scale `estimatedHours` remain as-is (developer effort baseline). The AI estimates
are derived from those hours plus a complexity index, then refined by historical actuals.

---

## Input Signals

### 1. Story Metadata (from prd.json)

| Signal | Field | Weight | Rationale |
|--------|-------|--------|-----------|
| Human effort | `estimatedHours` | Baseline | Primary scaling factor |
| Priority | `priority` | 1.0–1.3x | High/critical stories tend to need more careful output |
| Effort tier | `effort` | model select | low→Haiku, medium→Sonnet, high→Opus |
| Dependency count | `dependencies.length` | +5% per dep | More context loading, coordination overhead |
| Required skills | `technicalNotes.requiredSkills.length` | +3% per skill | Breadth increases prompt complexity |
| Story type | `storyType` | 0.3x for review | Reviews are shorter than implementation |

### 2. Codebase Signals (computed at estimation time)

| Signal | How measured | Weight |
|--------|-------------|--------|
| Lines of code | `wc -l` on `technicalNotes.files[]` | +2% per 100 LOC above 200 |
| File count | `technicalNotes.files.length` | +5% per file above 2 |
| Import depth | Count unique imports in target files | Proxy for coupling complexity |

These are computed by the estimation script at runtime, not stored in prd.json.

### 3. Historical Actuals (from phase-cost.jsonl)

After phase 1 completes, real data becomes available:

| Signal | Source | Usage |
|--------|--------|-------|
| Avg minutes per human-hour by role | `elapsed_minutes / forecast_hours` | Replaces baseline ratio |
| Avg tokens per story by effort | `task_tokens_in + task_tokens_out` | Replaces token estimate |
| Avg cost per token by model | `task_cost_usd / total_tokens` | Replaces pricing table rate |
| Avg turns per story | Not yet tracked — see Turns section | Future input |

Historical data takes precedence over the formula when available. The estimation script
checks `phase-cost.jsonl` first and only falls back to the formula for stories without
comparable actuals.

### 4. Error/Retry Likelihood

| Risk factor | Detection | Multiplier |
|-------------|-----------|------------|
| Test-gated story | `storyType === 'review'` or story has `testFor` | 1.0x (reviews are simpler) |
| Touches >3 files | `technicalNotes.files.length > 3` | 1.15x |
| External dependencies | requiredSkills includes HTTP, MCP, SSE | 1.20x |
| First story in phase | No prior stories in same phase completed | 1.10x (cold start, no cache) |
| High-complexity skills | agent-orchestration, multi-agent, parallel-async | 1.25x |

These multiply the base estimate. A story touching 4 files with MCP integration gets
`1.15 * 1.20 = 1.38x` applied to the base.

---

## Complexity Index

The complexity index `C` combines all signals into a single multiplier:

```
C = priority_weight
  * story_type_weight
  * (1 + 0.05 * max(0, dep_count - 1))
  * (1 + 0.03 * max(0, skill_count - 2))
  * (1 + 0.02 * max(0, (total_loc - 200) / 100))
  * (1 + 0.05 * max(0, file_count - 2))
  * error_retry_multiplier
```

Where:
- `priority_weight`: low=1.0, medium=1.0, high=1.1, critical=1.3
- `story_type_weight`: implementation=1.0, review=0.3, health_check=0.15
- `error_retry_multiplier`: product of applicable risk factors from table above

---

## Estimation Formulas

### AI Execution Time

```
base_minutes = estimatedHours * HUMAN_TO_AI_RATIO[effort] * 60
estimated_ai_minutes = base_minutes * C
```

`HUMAN_TO_AI_RATIO` is per effort tier — low-effort stories convert faster, high-effort
stories take proportionally longer due to deeper reasoning and error-retry overhead:

| Effort | Cold start | Rationale |
|--------|-----------|-----------|
| Low    | 0.05      | Simple tasks, few tool calls |
| Medium | 0.08      | Standard implementation cycle |
| High   | 0.12      | Multi-file coordination, complex reasoning |

- **Calibrated** (after phase 1): computed per tier from actuals as
  `avg(elapsed_minutes) / avg(forecast_hours * 60)` for stories in the same effort band.

### Tokens

```
file_factor     = 1 + 0.1 * max(0, file_count - 1)
context_growth  = 1 + 0.12 * ln(turns)
estimated_tokens = estimated_ai_minutes * TOKENS_PER_MINUTE * file_factor * context_growth
```

The `context_growth` factor accounts for super-linear token consumption in multi-turn
conversations. Each turn replays growing conversation history, so total tokens grow
logarithmically with turn count:

| Turns | context_growth | Effect |
|-------|---------------|--------|
| 1     | 1.00x         | Single-shot, no accumulation |
| 10    | 1.28x         | Moderate history replay |
| 30    | 1.41x         | Significant context load |
| 60    | 1.49x         | Near steady-state |

`TOKENS_PER_MINUTE` by model tier:
- Haiku (low effort): 8,000 tok/min (fast, short context)
- Sonnet (medium): 12,000 tok/min (moderate context)
- Opus (high): 18,000 tok/min (deep reasoning, large context windows)

### Input/Output Token Split

The split between input and output tokens varies by story type because different
task types have fundamentally different I/O profiles:

| Story Type     | Input | Output | Rationale |
|---------------|-------|--------|-----------|
| implementation | 75%   | 25%    | Code generation produces substantial output |
| review         | 92%   | 8%     | Mostly reading/analysis, minimal generation |
| health_check   | 90%   | 10%    | Validation with brief status reports |

This matters for cost: output tokens are 5x more expensive than input tokens.

### Turns

```
estimated_turns = ceil(estimated_ai_minutes / AVG_MINUTES_PER_TURN)
```

`AVG_MINUTES_PER_TURN` by effort:
- Low: 0.5 min/turn (simple validation, few tool calls)
- Medium: 1.0 min/turn (implementation with read-edit-test cycles)
- High: 1.5 min/turn (complex reasoning, plan mode, multi-file edits)

### Cost

```
input_tokens  = estimated_tokens * INPUT_RATIO[storyType]
output_tokens = estimated_tokens * OUTPUT_RATIO[storyType]
cache_tokens  = input_tokens * cache_hit_ratio

uncached_input = input_tokens - cache_tokens
cached_input   = cache_tokens

cost = (uncached_input / 1M) * model_input_rate
     + (cached_input / 1M)   * model_cached_rate
     + (output_tokens / 1M)  * model_output_rate
```

Multiply by `error_retry_multiplier` to account for potential retries.

### Uncertainty Ranges

Every point estimate is accompanied by a range (low–high):

```
range_factor = 0.15 + 0.03 * ln(C * turns + 1)    # capped at 0.50
estimate_low  = estimate * (1 - range_factor)
estimate_high = estimate * (1 + range_factor * 1.5)
```

The range widens for stories with higher complexity or more turns.
JSON output includes `range.minutesLow`, `range.minutesHigh`,
`range.costLow`, `range.costHigh` per story.

---

## Cache Hit Model

Prompt caching reduces input token cost by ~90% on cache hits. The hit ratio depends on
story position within a phase:

| Position in phase | Expected cache hit ratio | Rationale |
|-------------------|--------------------------|-----------|
| 1st story | 0.00 | Cold cache — system prompt + KB + profile cached for first time |
| 2nd story | 0.40 | System prompt + KB cached, but new story context |
| 3rd story | 0.55 | Accumulating shared context |
| 4th+ story | 0.65 | Steady state — system prompt, KB, phase context all cached |
| Same-role consecutive | +0.10 bonus | Profile and role-specific context reused |
| File overlap >50% | +0.15 bonus | Stories sharing most target files reuse file-level cache |
| File overlap >0%  | +0.08 bonus | Partial file overlap still provides some cache benefit |

All bonuses are cumulative but capped at 0.85 (prompt changes prevent 100% cache hits).

The estimation script computes `cache_hit_ratio` per story based on its ordinal position
within the phase's story list in `implementationOrder`, plus file-overlap analysis
between adjacent stories using `technicalNotes.files`.

After phase 1 completes, the ratio is recalibrated using actual
`cache_read_input_tokens / task_tokens_in` from `phase-cost.jsonl`.

---

## Model Pricing Table

Rates used for cost estimation (USD per 1M tokens):

| Model | Input | Cached Input | Output | Effort Tier |
|-------|-------|-------------|--------|-------------|
| claude-opus-4-6 | $15.00 | $1.50 | $75.00 | high |
| claude-sonnet-4-6 | $3.00 | $0.30 | $15.00 | medium |
| claude-haiku-4-5 | $0.80 | $0.08 | $4.00 | low |
| gpt-4o (OpenCode) | $2.50 | — | $10.00 | medium |
| o3 (Codex) | $0.00* | — | $0.00* | low |

*Codex does not report cost; tracked as $0 in phase-cost.jsonl.

---

## Refinement Loop

The estimation model improves as orchestration phases complete:

```
Phase 1 completes
    ↓
phase-cost.jsonl has actuals for N stories
    ↓
estimate-stories.sh --refine reads actuals
    ↓
Computes per-role, per-model, per-effort averages
    ↓
Replaces formula constants with empirical values:
  - HUMAN_TO_AI_RATIO ← actual ratio
  - TOKENS_PER_MINUTE ← actual tokens / actual minutes
  - cache_hit_ratio   ← actual cache_read / actual tokens_in
  - AVG_MINUTES_PER_TURN ← actual minutes / estimated turns (when tracked)
    ↓
Re-estimates remaining stories with calibrated model
    ↓
Writes estimatedCost, estimatedTokens, estimatedTurns, estimatedAiMinutes to prd.json
```

---

## Script Usage

```bash
# First run (no historical data — uses formula defaults)
bash orchestrations/scripts/estimate-stories.sh

# After phase 1+ completes (uses actuals to refine)
bash orchestrations/scripts/estimate-stories.sh --refine

# Write estimates back to prd.json
bash orchestrations/scripts/estimate-stories.sh --refine --apply

# Show estimates without writing
bash orchestrations/scripts/estimate-stories.sh --dry-run
```

Output per story:
```
EPAM-001  Budget Guardrails
  Human hours:    6h
  AI minutes:     28.4 min  (C=1.10, ratio=0.08)
  Tokens:         340,800   (in: 272,640 / out: 68,160)
  Cache:          40% hit   (position: 2nd in finops)
  Turns:          28        (1.0 min/turn, medium effort)
  Cost:           $2.84     (Sonnet 4.6, cached input: $0.08)
```

---

## Tracking Gaps — Status

| Gap | Status | Notes |
|-----|--------|-------|
| Turn count | **Fixed** | `task_turns` field added to phase-cost.jsonl; parsed from Claude CLI JSON output |
| Cache tokens | **Fixed** | `cache_read_tokens` and `cache_create_tokens` stored as separate fields |
| `forecast_cost_usd` | Open | Populate from estimation script output |
| Codex cost | Open | Use o3 pricing when available, or track tokens only |
| Codebase LOC | **Fixed** | `estimate-stories.sh` computes at runtime from `technicalNotes.files` |
| Per-tier H2A ratio | **Fixed** | `HUMAN_TO_AI_RATIO` now per effort tier (low/med/high), calibrated separately |
| Super-linear tokens | **Fixed** | Context accumulation factor `1 + 0.12 * ln(turns)` applied |
| Per-storyType IO split | **Fixed** | Implementation 75/25, review 92/8, health_check 90/10 |
| File-overlap cache | **Fixed** | Adjacent stories sharing >50% files get +0.15 cache bonus |
| CPA codebase grounding | **Fixed** | File snippets (first 30 lines, up to 3 files) included in CPA inference |
| Uncertainty ranges | **Fixed** | Range (low–high) computed for minutes and cost per story |
