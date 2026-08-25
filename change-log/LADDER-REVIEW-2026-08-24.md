# Ladder review — all 39 seams

**Nothing here is applied.** This is analysis for your decision, per the freeze.

## The headline problem

**32 of 39 seams sit on `top`.** `base` has 3, `mid` has 4. A tier that holds 82% of the pipeline
is not a choice — it is the default, and the other two tiers are the exceptions. Every argument
about which model belongs where is moot while almost everything lands on the same rung.

Two consequences already visible in the runs:

1. **Escalation headroom is one step.** A `top` seam that fails escalates once (`glm→kimi-k3`) and
   then logs *"at the top of its declared chain, retrying the same rung"*. Retrying the same model
   on the same prompt is the same gamble — which is exactly what `roster-specialiser` and
   `project-roster-review` did before the timeout fix.
2. **The QA gates are the volume.** 8 gates × every story × every iteration, all on `top`, all
   `high` effort, most at 900s. That is the largest cost driver in the pipeline and it is
   uniformly set to the most expensive tier.

## The self-contradicting seams — start here

Four seams declare a **cheaper reasoning effort** while sitting on the **most expensive ladder**.
Someone wanted a cheap call and left the ladder alone:

| seam | ladder | effort | stage |
|---|---|---|---|
| `ac-elaboration` | top | **medium** | pre-pause-1 |
| `tc-writer` | top | **medium** | pre-pause-2 |
| `cpa-inference` | base | medium | *(consistent)* |
| `prd-model-coordinator` | mid | medium | *(consistent)* |

`ac-elaboration` and `tc-writer` are text transformations with narrow outputs and no tool use.
They are the clearest candidates to move down.

## Stage-by-stage

### 1. Pre-pause-1 (12)

| seam | now | assessment |
|---|---|---|
| `ac-classification` | base/low | **correct** — narrow classification |
| `ac-elaboration` | top/medium | **→ mid.** No tools, text-in text-out, and it already asks for medium effort |
| `role-assigner` | top/high | **→ mid.** Small input, structured output (story→role). It answered correctly under a *table* format — this is not hard reasoning |
| `agent-mint` | top/high | **keep top.** Designs the team; now reads the whole roster; consequence is every downstream agent's identity |
| `codeline-discovery` | top/high | **keep top** — but its 300s timeout is the lowest of any `top` seam and it timed out in the last run. Worth raising to match peers |
| `estate-survey` | top/high | **keep top** — tool-driven, reads repositories |
| `survey-review` | top/high | **keep top** — falsifies with tools |
| `roster-review` | top/high | **keep top** — falsifies briefs with tools |
| `roster-specialiser` | top/high | **keep top** — largest single artefact in the pipeline (57 personas) |
| `project-roster-review` | top/high | **keep top** — reviews all 57 |
| `prompt-builder` | **mid**/high | **→ top.** It authors the instructions every other agent executes. Highest blast radius of any pre-pause-1 seam and it is on the middle tier |
| `prompt-review` | mid/high | keep mid — it judges one prompt at a time |

### 2. Pre-pause-2, spec stage (13)

| seam | now | assessment |
|---|---|---|
| `cpa-inference` | base/medium | correct |
| `prd-change-summarizer` | base/high | correct — summarisation |
| `ticket-links` | mid/medium | correct |
| `prd-model-coordinator` | mid/medium | correct |
| `tc-writer` | top/**medium** | **→ mid** — see above |
| `phase-assessment` | top/high | **→ mid.** Augments profiles with skills; not long-horizon |
| `codeline-bridge-agent` | top/high | **→ mid.** Extracts an exported surface — mechanical, bounded |
| `spec-agent` | top/high | **keep top** — authors the specification |
| `spec-coordinator` | top/high | **keep top** — assigns and reviews spec work |
| `code-graph-detective` | top/high | **keep top** — tool-driven investigation |
| `guard-vocabulary` | top/high | **keep top** — its output is *enforced* by a deterministic guard |
| `vc-coverage` | top/high | **keep top** — judge; a false pass ships untested work |
| `prd-change-reviewer` | top/high | **keep top** — gate on a PRD mutation |

### 3. Writer + heal (6)

| seam | now | assessment |
|---|---|---|
| `story-writer` | top/high | **keep top** — the core task; if anything gets the best model, this does |
| `team-lead-review` | top/high | **keep top** — judges the change |
| `repro-test-writer` | top/high | **keep top** — writes the failing test that defines "fixed" |
| `code-review-cycle` | top/high | **review.** Runs per iteration, so volume is high; cost scales with retries |
| `agent-failure-analyst` | top/high | **contradicts your own design rule** — see below |
| `impl-failure-analyst` | top/high | **same** |

**The analysts should not be fixed at `top` at all.** Your standing principle is that the judge
and the healer run on *the rung that produced the work*, passed as a parameter by the producer. A
hard-coded `top` means an M2.7 writer's failure is diagnosed by glm-5.3 — a different model
reasoning about a failure it would not have made. That is an architectural mismatch, not a tuning
question.

### 4. QA gates (8) — all top, all high, mostly 900s

| seam | assessment |
|---|---|
| `qa-gate:spec-validator` | **keep top** — decides whether criteria are met |
| `qa-gate:review-ranger` | **keep top** — catches what team-lead review misses |
| `qa-gate:mutant-hunter` | **keep top** — reasons about whether tests would *fail* |
| `qa-gate:sast` | **→ mid.** Pattern-driven security scan |
| `qa-gate:perf-sentinel` | **→ mid.** Bounded assessment, 16384 output |
| `qa-gate:fuzz-weaver` | **→ mid.** Input generation, bounded |
| `qa-gate:e2e` | **→ mid.** Routing check for one route |
| `qa-gate:runtime-boundary` | **keep top** — "can this execute in its runtime" is a real reasoning task |

This is where the money is. Moving four gates to `mid` changes the per-story cost of every
iteration of every story.

## If applied, the distribution becomes

| ladder | now | proposed |
|---|---|---|
| base | 3 | 3 |
| mid | 4 | **12** |
| top | 32 | **24** |

Still top-heavy, but `top` becomes a decision rather than a default.

## On the model swap you specified

| tier | start | chain | status |
|---|---|---|---|
| medium | `MiniMax-M2.7-highspeed` | → M3 → `glm-5.3` | **live-tested, both models respond** |
| high | `MiniMax-M3` | → `glm-5.2` → `kimi-k3` | unchanged |
| highest | `z-ai/glm-5.3` | → `kimi-k3` | **live-tested** |

**One gap that blocks this:** `modelOverrides` has entries for `MiniMax-M2.5`, `M3`, `glm-5.2`,
`kimi-k2.5`, `kimi-k3` — and **none for `MiniMax-M2.7-highspeed` or `glm-5.3`**. Overrides are
matched by substring, so both new models would fall through to defaults and inherit **no**
`maxIterations`, `autoCompressAt`, `temperature` or `reasoningEffort`.

That is directly your convergence question. Current values:

| model | maxIterations | effort | autoCompressAt | temp |
|---|---|---|---|---|
| MiniMax-M2.5 | 45 | medium | 64,000 | 0.2 |
| MiniMax-M3 | 120 | high | 180,000 | 0.2 |
| glm-5.2 | 120 | high | 180,000 | 0.9 |
| kimi-k2.5 | 60 | medium | 128,000 | 1.0 |
| kimi-k3 | 150 | max | 400,000 | 1.0 |

**M2.5's 45 iterations is the outlier** and it is the one being replaced. M2.7 is documented as
stronger on multi-file and long-horizon work than M2.5 — that work needs *more* iterations to
converge, not 45. A like-for-like copy of the M2.5 override onto M2.7 would cap the better model
at the weaker one's budget.

**A measured caution on glm-5.3:** vendor benchmarks report it reaching higher scores with ~22%
*fewer* output tokens on hard tasks. My own probe found the opposite on a trivial task — 118
completion tokens against 5.2's 31. Both can be true: reasoning models spend more on easy work and
less on long-horizon work. It argues for 5.3 on `top` (long-horizon) and against it on `base`.
