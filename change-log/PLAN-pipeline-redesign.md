# Trunk redesign — making drift IMPOSSIBLE, not merely tidy

**Scope: the trunk.** The 17 scripts a run actually executes, 39,676 lines.
Not the 347-file estate — the main line.

| script | lines |
|---|---|
| claude.sh | 12,055 |
| run-agent-orchestration.sh | 10,980 |
| spec-mode-runner.js | 9,642 |
| mint-agents-step.js | 1,265 |
| contextualize-stories.sh | 1,292 |
| team-lead-review.sh | 1,014 |
| brownfield-repro-test-writer.sh | 769 |
| ai-run.sh | 667 |
| code-review-cycle.sh | 428 |
| check-phase-gate.sh | 327 |
| ingest-jira-tickets.sh | 247 |
| brownfield-repro-test-gate.sh | 241 |
| control-plane.js | 233 |
| post-impl-tc-writer.sh | 216 |
| vc-coverage-check.sh | 167 |
| resolve-codeline-scope.sh | 95 |
| load-phase-graph.sh | 38 |

Three scripts are **82%** of it: claude.sh, run-agent-orchestration.sh, spec-mode-runner.js.

**Nothing here is applied.**

---

## 1. THE FINDING THAT DEFINES THE PLAN

Duplicated functions in the trunk, and how many are genuinely DIFFERENT
(whitespace and comments normalised out — the first count I took was inflated by indentation,
and one "defect" turned out to be two identical 3-line wrappers):

| function | copies | REAL versions |
|---|---|---|
| `log` | 11 | **11** — no two alike |
| `warning` | 7 | **7** |
| `success` | 7 | **7** |
| `error` | 7 | **7** |
| `info` | 3 | **3** |
| `_run_project_verification` | 3 | 2 |
| `run_pre_phase_assessment` | 2 | 2 |
| `_provider_for_model` | 2 | 2 |
| `run_review_prompt` | 2 | 2 |
| `load_env_file` | 2 | 1 — correctly delegating, NOT a defect |

**Every duplicated function in the trunk has drifted except one.** Eleven copies of `log`,
eleven behaviours.

And one of them is a live defect: `_run_project_verification` in claude.sh omits the
`${AUTOMATION_DIR:-$(dirname ...)}` fallback the other copies carry. With that variable unset,
claude.sh returns 2 — "plugin missing" — where the others self-heal.

---

## 2. WHY THE COPIES EXIST — and why deduplication alone cannot fix it

These copies were not written at once. They accreted, one script at a time, each author adding
the four lines they needed rather than finding the shared one.

`lib/env-file.sh` proves the pressure: the hardened shared loader EXISTS, and two trunk scripts
still declare their own wrapper around it.

**The cause is the shape of the code.** `implement_story()`, measured:

| | |
|---|---|
| lines | 1,797 — larger than ai-run.sh entire |
| local variables in ONE scope | **116** |
| if-blocks | 109 |
| loops | 3 |
| deepest nesting | ~10 levels (40 spaces) |
| functions it calls | almost none: 5 `jq_vals`, 4 `update_monitor_status` |

It is not orchestrating anything. It does everything inline.

**116 locals in one scope means its conceptual phases share 116 mutable variables as their
interface.** Nothing can be lifted out without knowing which of them it touches — so reuse is
impossible and COPYING IS THE ONLY AVAILABLE MOVE. That is the mechanism that produced eleven
versions of `log`.

So: deduplicate today, and the same pressure reproduces it tomorrow. **Splitting into functions
with real boundaries is not cleanup — it is the only thing that removes the cause.**

## 3. THE TWO MECHANISMS, IN ORDER OF IMPORTANCE

### 3.1 PRIMARY — decomposition into functions with declared boundaries

A function small enough to read is a function whose behaviour can be reused rather than
retyped. The target is not a line count; it is that **each unit names what it consumes and what
it produces**, so a caller can use it without reading it.

The 116 shared locals are the work. Each extracted unit takes parameters and returns a value
instead of mutating a scope 1,797 lines wide.

### 3.2 SECONDARY — make a second copy fail to load

Once there is one home, bash can forbid a second. `readonly -f` makes a function immutable and
a redefinition FAILS — verified:

```
$ log() { echo SHARED; }; readonly -f log
$ log() { echo LOCAL; }
bash: log: readonly function          # rc=1, SHARED survives
```

A script declaring its own dies at load, in the author's face, before any run. That is an
architectural guarantee rather than a guard reporting drift after it shipped.

**Ordering is not optional.** Locking before the copies are removed breaks every trunk script at
once. Remove, prove, THEN lock — the rule `load_env_file` broke by adding the shared version
without removing the copies.

**JS and Python have no `readonly -f`.** There the guarantee is weaker and saying so matters: a
scanner test asserting no trunk file defines what the shared module already exports. That is a
guard, not a guarantee.

## 4. THE STEPS

Each is independently valuable, independently revertible, measured against the existing
baselines. Decomposition LEADS, because every other step is easier inside smaller units.

**Step 1 — decompose the giants, one function at a time.**
`implement_story()` (1,797), `run_failure_analyst()` (860), `build_implementation_prompt()`
(724). Not a rewrite: extract ONE unit, give it parameters and a return value, prove behaviour
unchanged, repeat. The 116 shared locals are the measure of progress — each extraction should
reduce them.

Start with the pieces that have the FEWEST dependencies on those locals; they are the ones that
can move without a redesign of the whole scope.

**Step 2 — the shared trunk library.** One implementation of `log` / `info` / `warning` /
`error` / `success`, one spelling per idea. The 11 bodies genuinely differ in prefix, colour and
stream — those are BEHAVIOUR, and flattening them silently would change what a run prints. They
must be reconciled deliberately.

**Step 3 — remove the copies, one script at a time.** 35 definitions across 11 scripts. Each:
delete, source the library, prove output unchanged.

**Step 4 — LOCK.** `readonly -f`. From here a twelfth copy cannot be written.

**Step 5 — the drifted logic.** `_run_project_verification` first: its claude.sh copy is the
broken one. Then `run_pre_phase_assessment`, `_provider_for_model`, `run_review_prompt`.

**Step 6 — declare the phase contract.** 31 exported variables, 85 distinct `EPAM_*` reads, 73
`LOG_DIR` artefacts — none declared, so none checkable. That is how "declared in one place,
different when it arrives" became this month's defect class.

## 5. WHAT MUST NOT BREAK

- **Both stacks stay executable.** Every step re-runs the baseline diff for all four projects on
  BOTH sets. A model or provider resolved differently is a behaviour change, not a cleanup.
- **The guards run after every step** — 21 files, ~280 tests.
- **Nothing lands while the CodeMie stack is unproven.** It has still never run. Two unproven
  things at once means a failure cannot be attributed to either.
- **Move, prove, delete, lock — in that order, never any other.**

---

## 6. WHAT THIS PLAN DOES NOT CLAIM

- No effort estimate. Step 1 is the largest and least predictable; steps 2-5 are mechanical; step 6 is design.
- Step 6 may find the phase contract cannot be declared as it stands. That is a finding that
  should STOP the step, not be worked around.
- Step 1 may find `implement_story()` does not decompose cleanly in bash. 116 locals in one
  scope may not survive extraction. If so the honest answer is that it belongs in the TypeScript
  engine — not six 300-line bash functions pretending to be a design.
- The JS and Python halves get a GUARD, not a guarantee. Stated plainly rather than implied.
