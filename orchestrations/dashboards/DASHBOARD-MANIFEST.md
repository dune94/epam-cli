# Dashboard Manifest

One entry per dashboard in `orchestrations/dashboards/`: what it's for, exactly
what files it reads, and known caveats. **This file is the source of truth for
"what should this dashboard show" — check it before assuming a dashboard's
data contract, and update it whenever a dashboard's sources change.** Built
2026-07-13 after several rounds of dashboards silently reading stale, wrong,
or dead files (see the "Recurring failure pattern" section below) — the goal
is to stop re-deriving each dashboard's actual data flow from scratch every
session.

## How data reaches these pages

All 17 dashboards are served by nginx (`agent-monitor` container, port 8092)
from `orchestrations/dashboards/live/` (the Eleventy build output). Three
categories of data source:

1. **Docker directory mounts**, set up by `pre-run-reset.sh --prd <path>
   [--log-dir <path>]` and consumed via `nginx.conf` aliases:
   - `/prd-dir` → the active PRD's parent directory → `GET /prd.json`
   - `/profiles-dir` → `orchestrations/agents/` → `GET /profiles.json`
   - `/logs-dir` → the active run's `LOG_DIR` (which is **`orchestrations/logs`
     for in-repo runs, but the TARGET PROJECT's own directory for
     external-project runs** like `tier3-*-run.sh`, e.g.
     `/home/.../skyscanner-app`) → `GET /logs/*`
   All three are **directory** mounts, not file mounts — see "Recurring
   failure pattern" below for why that distinction is load-bearing.
2. **`build-info.json`** — a computed snapshot written by
   `dashboards/build/snapshot.js` (the Eleventy watcher), polled client-side
   by every page that includes `<script src="runtime/build-info.js">`.
   Consumed via `window.EPAMBuildInfo.getLatest()` or the `buildinfo:update`
   window event. snapshot.js reads the SAME sources as above but as a plain
   Node process (no Docker) — its own path resolution mirrors the mounts:
   `PATHS.prd` reads `.active-prd-path` (written by `pre-run-reset.sh`, same
   invocation that sets up `/prd-dir`), `PATHS.agentStatus`/`phaseCost`/
   `agentActivity` prefer `EPAM_PROJECT_OUTPUT_DIR` when set, else fall back
   to `orchestrations/logs` via the `dashboards/logs` symlink.
3. **Static files copied into `live/`** at Eleventy build time (`build-info.json`
   itself, `swe-bench-results.json`) — regenerated on the watcher's own
   interval, not tied to a specific run.

## Recurring failure pattern (read this before debugging a "stale dashboard")

Found live 2026-07-13, three separate times, in three different mechanisms:
Docker single-file bind mounts, a plain symlink, and `snapshot.js`'s own
hardcoded paths. All three share the same shape: **the orchestration pipeline
always writes JSON/JSONL files via atomic tmp-file + rename** (`jq ... > tmp
&& mv tmp file`, `fs.writeFileSync(tmp); fs.renameSync(tmp, file)` — the
correct, corruption-safe pattern, used throughout this codebase). Every
`rename()` creates a **new inode** at that path. A mechanism that resolved a
specific inode once (a Docker single-file bind mount, or a value computed
once at process start) silently keeps serving the OLD content forever after
the first rewrite — no error, no crash, just wrong data. The fix is always
the same: point at a **directory**, not a file (Docker), or **re-resolve the
path on every read**, not once at process start (snapshot.js). If a dashboard
looks frozen or wrong, suspect this class of bug before anything else.

---

## Dashboards

### monitor.html — Execution Monitor (flagship/showcase)
**Purpose:** the primary "what did this run actually do" narrative page —
verdict, elapsed time, cost/agent breakdown, self-healing activity, pipeline
step timeline, and per-story deliverables (commit SHA, file count, branch).
**Sources:** `prd.json`, `logs/agent-status.json`, `logs/step-status.json`,
`logs/phase-cost.jsonl`, `logs/agent-activity.jsonl`, `build-info.json`
(for `metrics.selfHealing`, `metrics.promptEvals`, `metrics.storyCommits`).
**Caveats:**
- Provider/Model filter dropdowns and story badge colors are derived
  dynamically from whatever `aiProvider`/`model` values the current PRD
  actually contains (hashed to a fixed 6-slot color palette) — **never
  hardcode a provider/model list here again**; found live 2026-07-13 that the
  old hardcoded `claude/opencode/codex` + `haiku/sonnet/opus` list matched
  none of the providers/models a real run actually used.
- Story "commit" info requires `build-info.json`'s `metrics.storyCommits`,
  which requires the project directory to be a real git repo with commits
  matching `"<id>: story complete (<N> file(s))"` — empty for PRD-only
  preview/dry-run states.
- `agent-status.json`'s `startedAt` is reset to `null` by every
  `pre-run-reset.sh` call — hero "Elapsed" falls back to the earliest
  `phase-cost.jsonl` timestamp when `startedAt` is unset.
- Branch name in story commit info will be `master`/whatever the single
  checked-out branch is unless the run used worktree lanes (`3a`/`3b`
  primary/independent) — this run didn't, so it's untested for the
  actual-worktree-branch case.

### prd-viewer.html — PRD Viewer
**Purpose:** browse every story's full detail — description, acceptance
criteria, test criteria, technical notes, spec-pass lineage, metadata.
**Sources:** `prd.json` only.
**Caveats:** Model badge (`modelInfo()`) is provider-aware but falls back to a
hashed generic-palette label+color for any provider/model not in its small
named set (opencode/codex/qwen+deepseek/openai/4 specific Claude model IDs) —
same no-hardcoding principle as monitor.html. Test Criteria section (added
2026-07-13) only renders when `testCriteria` has real content (facts/
sourceFiles/mockStrategy/bannedPatterns) — silent for non-test stories, which
correctly carry an all-empty stub.

### health.html — Self-Healing & Prompt Evals
**Purpose:** cross-cutting pipeline health signals — self-heal cycles, skill
notes learned, dynamic tools synthesized, and (added 2026-07-13) prompt-eval
retry/violation rates for the guarded steps (0.5, 0.9, AC-review, TC-writer),
both per-run and as a cross-run trend.
**Sources:** `build-info.json` (`metrics.selfHealing`, `metrics.promptEvals`
including `.history` for the cross-run trend).
**Caveats:** the cross-run trend reads
`orchestrations/logs/guarded-step-retries-history.jsonl` — an ENGINE-side
persistent file (not per-run, never wiped by `pre-run-reset.sh` or project
teardown) — via `snapshot.js`'s `summarizeGuardedStepHistory()`. This is
deliberately NOT reset between runs; don't "fix" it by clearing it.

### quality-assurance.html — QA Gates (current run)
**Purpose:** per-phase verdicts for the 6 QA gate agents (SAST, spec-validator,
review-ranger, mutant-hunter, fuzz-weaver, perf-sentinel) for the CURRENT run
only.
**Sources:** `logs/testing-gates.jsonl` (`GATES_URL`).
**Caveats:** this file is in `pre-run-reset.sh`'s `CLEARABLE_LOGS` list — wiped
(archived first) at the start of every run, so this page only ever shows the
current/most-recent run, never history. See `quality-dashboard.html` below for
the historical counterpart.

### quality-dashboard.html — Quality Trend (STALE, needs real generator)
**Purpose (as originally built):** an overall cross-run quality summary.
**Current state:** its only data source, `logs/quality-summary.json`, is a
frozen file from 2026-03-01 whose own `source` field points at
`orchestrations/prd.json` — a dead file (see below). **Nothing in this
codebase generates `quality-summary.json` anymore** — confirmed via full
repo search 2026-07-13. This page is effectively dead/showing 4+ month old
data. Pending: replace with a real cross-run testing-gates trend (mirrors the
already-built `guarded-step-retries-history.jsonl` pattern) — tracked as a
follow-up, not yet implemented as of this manifest's creation.

### phase-cost-monitor.html — Cost Tracking
**Purpose:** cost/variance tracking for the current run.
**Sources:** `prd.json`, `logs/phase-cost.jsonl`, `logs/agent-activity.jsonl`.
**Caveats:** same per-run (not cross-run) scope as quality-assurance.html —
`phase-cost.jsonl` is also in `CLEARABLE_LOGS`.

### agent-activity.html — Activity Log
**Purpose:** raw activity feed viewer.
**Sources:** `logs/agent-activity.jsonl` (via a generic `fetchJsonl(path)` helper).
**Caveats:** none known beyond the general CLEARABLE_LOGS per-run scope.

### agent-messages.html — Inter-Agent Messages
**Purpose:** browse agent-to-agent message files.
**Sources:** `logs/agent-messages.jsonl`, `logs/messages/inbox/<agent>/`,
`logs/messages/outbox/`.
**Caveats:** the `logs/messages/` subpaths are served correctly by the
`location ^~ /logs/ { alias /logs-dir/; }` nginx block (added 2026-07-13) —
alias with a trailing slash on both sides handles subdirectories.

### agent-profiles.html — Agent Profile Roster
**Purpose:** view/audit agent profiles (persona prompts) and their audit log.
**Sources:** `profiles.json` (fetched as raw text via `fetchText`), `prd.json`,
`logs/profiles-audit.jsonl` (`AUDIT_LOG_PATH`).
**Caveats:** none known.

### specification.html — Spec Diff
**Purpose:** openspec/speckit collaboration diff — before/after AC changes,
split lineage, readiness scores, grooming/dedup reports.
**Sources:** `prd.json` (`CURRENT_URL`), `prd-baseline.json` or
`logs/spec-baseline.json` (`BASELINE_CANDIDATES`, first that loads),
`logs/spec-phase.jsonl` (`SPEC_LOG_URL`).
**Caveats:** `logs/readiness-scores.jsonl`, `logs/grooming-report.json`,
`logs/dedup-report.json` are referenced but **none of the three exist, and
nothing generates them** — confirmed 2026-07-13. Gracefully caught
(`.catch(() => [])` / `.catch(() => null)`), so the page doesn't break, but
those sections are permanently empty placeholders for a feature that was
designed but never wired up. `prd-baseline.json` (the first baseline
candidate) also doesn't exist at the docroot root — falls through to
`logs/spec-baseline.json`, which does.

### orchestration-plan.html — Plan
**Purpose:** plan-mode diff/summary viewer.
**Sources:** `logs/spec-summary.json`, plus generic `${url}` fetches.
**Caveats:** not fully audited this session — verify sources before deep
changes.

### scorecard.html — Scorecard
**Purpose:** historical run scoring (this dashboard already had its own
cross-run "historical runs" concept before this session's guarded-step-retry
history work — see it as precedent, not something to duplicate).
**Sources:** `logs/phase-cost.jsonl`, `logs/testing-gates.jsonl`,
`logs/cpa-review.jsonl` (all via `fetchJSONL(path)`).
**Caveats:** `cpa-review.jsonl` is explicitly preserved (never cleared) by
`pre-run-reset.sh` — "accumulate over time" — this is intentional and correct.

### swe-bench.html — SWE-bench Evaluation
**Purpose:** SWE-bench results dashboard.
**Sources:** `swe-bench-results.json` — a static file copied into `live/` at
Eleventy build time, confirmed actively regenerated by the watcher (fresh
timestamp verified 2026-07-13), not a stale one-time copy.
**Caveats:** none known.

### agents-orchestration.html, cpa-details.html, epam-cli-guide.html, pipeline-stages.html
**Purpose:** static reference/documentation pages (pipeline architecture
diagram, estimation/CPA system explainer, CLI user guide, pipeline stage
reference).
**Sources:** none — no `fetch()` calls in any of the four; pure static content.
**Caveats:** none — these never go stale because they never read live data.
If one of these ever needs live data, that's a deliberate scope change, not a
bug to fix.

---

## Last verified: 2026-07-13
Verified by direct inspection of each file's `fetch()` calls and cross-checked
against real files on disk (not assumed from filenames). Re-verify this file
whenever a dashboard's sources change, or before trusting an old entry that
predates a later architecture change (e.g. the `/logs-dir` mount didn't exist
before 2026-07-13 — anything written about dashboard data sources before that
date should be treated as suspect).
