#!/usr/bin/env bash
# tier3-run.sh — launch ANY project's multi-codeline run. The project is an argument.
#
# WHY THIS EXISTS. A project declares everything a run needs in its own config.env: the codeline
# root, the scope bound on the destructive reset, the provisioning mode, its models and ladders.
# Nothing generic ever loaded that file. The launcher that works names its project twice by
# hardcoded path, so a project without a launcher of its own ran with NONE of its data applied —
# no codeline root, so scope resolution no-ops and a multi-codeline project collapses to one lane;
# no scope bound, so the reset has none; no provisioning mode, which the mint refuses to default.
#
# 25 of that launcher's 588 lines name its project. The rest was generic work waiting to be copied
# again for the next one. This is that work, with the name taken out.
#
# Usage:
#   tier3-run.sh --project <name> [--phase <id>] [--yes] [--describe] [-- <orch args>]
#   EPAM_PROJECT_CONFIG_DIR=/path/to/project tier3-run.sh [...]
#
#   --project    a directory under EPAM_PROJECTS_DIR (default orchestrations/projects)
#   --describe   resolve and load, print what a run WOULD use, spend nothing, exit 0
#   --yes        skip the launch confirmation
#
# Exit 0 = the run completed (or --describe resolved cleanly).
# Exit 1 = it could not be launched. Nothing is guessed: an unnamed or missing project is refused.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Overridable so a test can point at a disposable estate instead of the real one.
PROJECTS_DIR="${EPAM_PROJECTS_DIR:-$REPO_ROOT/orchestrations/projects}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3]${NC} $*"; }
success() { echo -e "${GREEN}[tier3] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3] ✗${NC} $*" >&2; exit 1; }

PROJECT_NAME=""
PHASE_ARG=""
DESCRIBE=0
ASSUME_YES=0
ORCH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT_NAME="$2"; shift 2 ;;
    --phase)    PHASE_ARG="$2"; shift 2 ;;
    --describe) DESCRIBE=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --)         shift; ORCH_ARGS+=("$@"); break ;;
    *)          fail "unknown argument: $1" ;;
  esac
done

# ── Resolve the project ───────────────────────────────────────────────────────
# Two ways in, and no third. A default here would launch a project nobody asked for, against a
# client codeline, which is the one mistake this file must never make.
if [ -n "$PROJECT_NAME" ]; then
  PROJECT_DIR="$PROJECTS_DIR/$PROJECT_NAME"
  [ -d "$PROJECT_DIR" ] || fail "no project '$PROJECT_NAME' — looked in $PROJECTS_DIR"
elif [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
  PROJECT_DIR="$EPAM_PROJECT_CONFIG_DIR"
  [ -d "$PROJECT_DIR" ] || fail "EPAM_PROJECT_CONFIG_DIR does not exist: $PROJECT_DIR"
  PROJECT_NAME="$(basename "$PROJECT_DIR")"
else
  fail "no project named. Pass --project <name>, or export EPAM_PROJECT_CONFIG_DIR."
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# ── Load the project's data ───────────────────────────────────────────────────
# PRESERVE, so a caller's explicit export outranks the file. An operator overriding a value for
# one run must not have it silently reverted by the project's declaration — that turns a
# deliberate override into an invisible no-op.
#
# .env first (credentials), then the project's own config: same order the working launcher uses.
# shellcheck source=lib/env-file.sh
[ -f "$SCRIPT_DIR/lib/env-file.sh" ] && . "$SCRIPT_DIR/lib/env-file.sh"
if ! command -v load_env_file_safe >/dev/null 2>&1; then
  # NOT SILENT. Without the loader the project's data never arrives, and the run proceeds looking
  # normal while doing none of what the project declared.
  fail "lib/env-file.sh did not provide load_env_file_safe — refusing to launch with no project data"
fi

for _env in "$REPO_ROOT/.env" "$PROJECT_DIR/.env" "$PROJECT_DIR/config.env"; do
  [ -f "$_env" ] && load_env_file_safe "$_env" preserve
done

export EPAM_PROJECT_CONFIG_DIR="$PROJECT_DIR"
export PROJECT_NAME

# A project may name its own PRD; otherwise it is the one beside its config.
export PRD_FILE="${PRD_FILE:-$PROJECT_DIR/prd.json}"

# ── Describe and stop ─────────────────────────────────────────────────────────
# A launcher that can only be exercised by launching cannot be tested, and an untested launcher is
# where a project's data silently fails to arrive.
if [ "$DESCRIBE" = "1" ]; then
  echo "project:            $PROJECT_NAME"
  echo "config dir:         $EPAM_PROJECT_CONFIG_DIR"
  echo "prd:                $PRD_FILE"
  echo "codeline root:      ${JIRA_CODELINE_ROOT:-<none declared>}"
  echo "codeline scope:     ${EPAM_ONLY_CODELINES:-<all>}"
  echo "provisioning mode:  ${EPAM_PROMPT_PROVISION_MODE:-<none declared>}"
  echo "brownfield:         ${EPAM_BROWNFIELD:-0}"
  echo "jira pipeline:      ${JIRA_PIPELINE:-0}"
  echo "phase:              ${PHASE_ARG:-<all declared phases>}"
  exit 0
fi

[ -f "$PRD_FILE" ] || fail "no PRD at $PRD_FILE"

# ── Pre-flight, before anything is spent ──────────────────────────────────────
info "Pre-flight for '$PROJECT_NAME'..."
bash "$SCRIPT_DIR/preflight-check.sh" || fail "pre-flight failed — not launching"
# NO PRD-INTEGRITY GATE HERE. I added one and it blocked every authored PRD, because it checks
# fields LATER STEPS populate: project.outputDir comes from scope resolution, aiProvider from the
# PRD model coordinator, and the scaffold phase from the mint. No working launcher runs this gate
# at launch — it is invoked with --phase from inside the pipeline, after those steps. Running it
# here was a deviation that turned a healthy project into a refusal.

# ── Confirm ───────────────────────────────────────────────────────────────────
# Every launch is approved. A run writes to client repositories and spends money; a launcher that
# starts without a human saying so is the one that starts by accident.
if [ "$ASSUME_YES" != "1" ]; then
  echo
  echo "  project:   $PROJECT_NAME"
  echo "  codelines: ${EPAM_ONLY_CODELINES:-<all discovered>}"
  echo "  root:      ${JIRA_CODELINE_ROOT:-<none>}"
  echo "  phase:     ${PHASE_ARG:-<all>}"
  echo
  read -r -p "Launch this run? [y/N] " _reply
  case "$_reply" in y|Y|yes|YES) ;; *) fail "not launched" ;; esac
fi

# ── Run ───────────────────────────────────────────────────────────────────────
# The orchestrator owns codeline routing: it resolves scope when the project declared none, counts
# the codelines and fans out one lane each. This launcher's job is to make sure it has the
# project's data when it does.
info "Launching '$PROJECT_NAME'..."
bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
  ${PHASE_ARG:+--phase "$PHASE_ARG"} \
  ${ORCH_ARGS[0]+"${ORCH_ARGS[@]}"}
_exit=$?

[ "$_exit" = "0" ] && success "'$PROJECT_NAME' completed" || fail "'$PROJECT_NAME' failed (exit $_exit)"
exit "$_exit"
