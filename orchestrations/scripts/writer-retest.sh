#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# WRITER RETEST — replay just the story-writer step against KNOWN inputs.
#
# Named/formalized 2026-08-01, after a live incident: a full Metrolinx tier3
# run (AMSD-2041) went all the way through review and got CHANGES REQUESTED
# for specific, already-diagnosed reasons (wrong SDK config key, missing
# tests, a sibling codeline's writer refusing to touch an in-scope file). To
# iterate on the fix, re-running the ENTIRE pipeline (spec pass, CPA,
# skill-assessment, TC-writer, all 6 testing gates) every time is expensive
# and irrelevant — none of that changed. What's actually being tested is the
# writer step alone, against the SAME manifest, profiles, and verification
# criteria the full run already produced.
#
# "Given" means given: this script does NOT run spec-pass/CPA/TC-writer to
# derive the manifest, agent profile, or VCs — those must already be present
# in the PRD_FILE you pass in (technicalNotes.files = manifest,
# agentRole + orchestrations/agents/profiles.json = profiles,
# testCriteria.facts = VCs).
#
# The PRD you pass in MUST come from a real pipeline run. Do NOT hand-author
# acceptanceCriteria for a retest. On 2026-08-03 a retest PRD was written by an
# assistant session with six invented ACs that encoded the answer; the writer
# "succeeded" on all three codelines and the result was reported as pipeline
# validation. It validated nothing — the fixture contained the solution. That PRD
# (writer-only-prd.json) has been deleted; recover it from git history only as
# evidence of the failure, never as an input.
#
# What it skips (all real, already-completed pipeline steps for THIS story):
#   Step 1  Specification pass   (EPAM_SPEC_MODE=0)
#   Step 2  CPA pre-pass         (SKIP_CPA=1)
#   Step 3  Skill assessment     (SKIP_SKILL_ASSESSMENT=1)
#   Step 5  Regression guard     (SKIP_REGRESSION_GUARD=true)
#   Step 10 TC writer gate       (SKIP_TC_WRITER=1)
#   Steps 22a-f  6 testing gates (SKIP_TESTING_GATES=true)
#
# What it KEEPS (the actual signal this test exists to produce):
#   Step 8/13-17  writer invocation (main-branch or worktree, per agentGroup)
#   Step 19-21    pre-review/lint/team-lead review — real pass/fail evidence
#                 on whether the retest actually fixed the diagnosed defects.
#
# JIRA_PIPELINE=0: uses PRD_FILE exactly as given, no Jira re-ingest, no
# codeline-discovery re-run — the codeline scope is whatever the PRD's
# story.codelines/outputDirs already declare.
#
# This script does NOT reset/clean the target codeline(s). Any leftover dirty
# state from a prior attempt is your responsibility to handle first (see
# CLAUDE.md's confirm-before-destructive-git-ops rule — this deliberately
# does not do it silently on a client repo).
#
# Usage:
#   source .env && source orchestrations/jira/<project>.env && \
#   bash orchestrations/scripts/writer-retest.sh <PRD_FILE> [--project NAME]
#
# Env (same names/defaults as the tier3-*-run.sh it borrows plumbing from):
#   REQUIRED: MINIMAX_API_KEY or OPENROUTER_API_KEY (whichever the profile needs)
#   EPAM_PROJECT_CONFIG_DIR   default: orchestrations/projects/<--project>
#   AGENT_PROFILES_FILE       default: orchestrations/agents/profiles.json
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PRD_FILE="${1:?Usage: writer-retest.sh <PRD_FILE> [--project NAME]}"
shift || true
PROJECT_NAME="metrolinx"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_NAME="${2:?}"; shift 2 ;;
    *) echo "[writer-retest] unknown option '$1'" >&2; exit 2 ;;
  esac
done

[ -f "$PRD_FILE" ] || { echo "[writer-retest] PRD_FILE not found: $PRD_FILE" >&2; exit 1; }
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$PRD_FILE" 2>/dev/null; then
  echo "[writer-retest] PRD_FILE is not valid JSON: $PRD_FILE" >&2
  exit 1
fi

export EPAM_PROJECT_CONFIG_DIR="${EPAM_PROJECT_CONFIG_DIR:-$REPO_ROOT/orchestrations/projects/$PROJECT_NAME}"

# Auto-source the project's own config.env (real settings: TZ, SEMBLE_ENABLED,
# JIRA_BASELINE_BRANCH, model routing, etc.) — found live 2026-08-01: relying on
# the CALLER to remember to source this lost TZ=UTC, producing a false
# "date formatting regression" on unrelated tests. Same pattern tier3-*-run.sh
# already uses. Caller-exported values still win where config.env uses `:-`.
_CONFIG_ENV="$EPAM_PROJECT_CONFIG_DIR/config.env"
if [ -f "$_CONFIG_ENV" ]; then
  echo "[writer-retest] Sourcing project config: $_CONFIG_ENV"
  set -a
  # shellcheck disable=SC1090
  source "$_CONFIG_ENV"
  set +a
else
  echo "[writer-retest] WARNING: no config.env found at $_CONFIG_ENV — proceeding without project-specific settings (TZ, SEMBLE_ENABLED, etc. may be wrong)" >&2
fi

# Restore profiles.json from its clean canonical source before every run — otherwise
# wrong self-heal guidance accumulated by a prior run (agents append lessons to this
# file live) silently persists and can contradict a fix this retest is meant to prove.
# Every tier3-*-run.sh launcher already does this; writer-retest.sh must too.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$REPO_ROOT/orchestrations/agents/profiles.json"
  echo "[writer-retest] profiles.json restored from canonical original"
else
  echo "[writer-retest] WARNING: profiles.json.original not found — skipping profiles restore" >&2
fi

export AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$REPO_ROOT/orchestrations/agents/profiles.json}"
export PRD_FILE
export EPAM_BROWNFIELD=1
export JIRA_PIPELINE=0          # use PRD_FILE as-is — no Jira re-ingest, no codeline re-discovery
export EPAM_SPEC_MODE=0         # Step 1  — already known-good, skip
export SKIP_CPA=1               # Step 2  — already known-good, skip
export SKIP_SKILL_ASSESSMENT=1  # Step 3/18 — already known-good, skip
export SKIP_REGRESSION_GUARD=true  # Step 5 — not relevant to a targeted retest
export SKIP_TC_WRITER=1         # Step 10 — VCs are given in the PRD already
export SKIP_TESTING_GATES=true  # Steps 22a-f — not what this test measures
export EPAM_MULTI_CODELINE_STORIES="${EPAM_MULTI_CODELINE_STORIES:-1}"

echo "[writer-retest] PRD:              $PRD_FILE"
echo "[writer-retest] Profiles:         $AGENT_PROFILES_FILE"
echo "[writer-retest] Project config:   $EPAM_PROJECT_CONFIG_DIR"
echo "[writer-retest] Skipping:         spec-pass, CPA, skill-assessment, regression-guard, TC-writer, 6 testing gates"
echo "[writer-retest] Keeping:          writer invocation + pre-review/lint/team-lead review"
echo ""

cd "$REPO_ROOT"
bash orchestrations/scripts/run-agent-orchestration.sh --phase core --reset
