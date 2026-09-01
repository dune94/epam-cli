#!/usr/bin/env bash
# ingest-jira-tickets.sh — Stage 0+1 of the Jira-first brownfield pipeline.
#
# Pulls tickets from Jira → runs AC gate → synthesizes PRD.
# On success, writes the synthesized PRD path to stdout.
# On insufficient ACs, exits 2 (caller must halt the run).
#
# Usage:
#   source .env
#   bash ingest-jira-tickets.sh \
#     --project SKY \
#    [--status "To Do"] \
#    [--out-prd /path/to/prd.json] \
#    [--dry-run]
#
# Env vars required:
#   JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT_KEY
#   NODE_BIN (default: node from PATH)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(dirname "$SCRIPT_DIR")"
export ORCH_DIR
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo 'node')}"
# Prefer Node 20 when available
# Resolved, never pinned: package.json declares the requirement (engines.node) and
# lib/node-bin.sh finds an interpreter that meets it. The path that was here was
# valid on one machine, for one nvm install, until that version was upgraded.
. "$(dirname "${BASH_SOURCE[0]}")/lib/node-bin.sh" 2>/dev/null || . "$(dirname "${BASH_SOURCE[0]}")/../lib/node-bin.sh"
NODE_BIN="$(resolve_node_bin)"
log()  { echo -e "${GREEN}[ingest]${NC} $*"; }
warn() { echo -e "${YELLOW}[ingest]${NC} $*"; }
err()  { echo -e "${RED}[ingest]${NC} $*" >&2; }

# ── Arg parsing ───────────────────────────────────────────────────────────
PROJECT_KEY="${JIRA_PROJECT_KEY:-SKY}"
JIRA_STATUS="To Do"
# NO default into a named project's PRD. This used to be travel-app-prd.json, so
# an ingest for ANY Jira project landed in the travel-app PRD unless the caller
# remembered --out-prd. Callers pass --out-prd; PRD_FILE is the env fallback.
OUT_PRD="${PRD_FILE:-}"
_out_prd_required() {
  [ -n "$OUT_PRD" ] && return 0
  err "no output PRD path: pass --out-prd, or export PRD_FILE."
  err "  (this used to default to a project-named PRD, so an ingest for ANY Jira"
  err "   project silently overwrote that one project's PRD)"
  exit 2
}
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)   PROJECT_KEY="$2"; shift 2 ;;
    --status)    JIRA_STATUS="$2"; shift 2 ;;
    --out-prd)   OUT_PRD="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    *) err "Unknown arg: $1"; exit 1 ;;
  esac
done

# Source main project .env so API keys reach ac-gate subprocess
REPO_ROOT_INGEST="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
load_env_file_safe "$REPO_ROOT_INGEST/.env"

TMPDIR_INGEST="$(mktemp -d /tmp/ingest-XXXXXX)"
ISSUES_JSON="$TMPDIR_INGEST/issues.json"
GATE_JSON="$TMPDIR_INGEST/ac-gate.json"
DRY_FLAG=""
[ "$DRY_RUN" = "1" ] && DRY_FLAG="--dry-run"

cleanup() { rm -rf "$TMPDIR_INGEST"; }
trap cleanup EXIT

# ── Validate Jira config ──────────────────────────────────────────────────
if [ -z "${JIRA_URL:-}" ] || [ -z "${JIRA_EMAIL:-}" ] || [ -z "${JIRA_TOKEN:-}" ]; then
  err "JIRA_URL, JIRA_EMAIL, and JIRA_TOKEN must be set."
  err "Run: source orchestrations/jira/.env"
  exit 1
fi

log "Pulling tickets from ${JIRA_URL} — project: ${PROJECT_KEY}, status: '${JIRA_STATUS}'"

# ── Step 1: Pull issues from Jira via jira-client.js ─────────────────────
"$NODE_BIN" "${SCRIPT_DIR}/lib/handlers/fetch-tracker-issues.js" \
  "${SCRIPT_DIR}" "${PROJECT_KEY}" "${JIRA_STATUS}" > "$ISSUES_JSON"

ISSUE_COUNT=$("$NODE_BIN" "${SCRIPT_DIR}/lib/handlers/json-array-length.js" "$ISSUES_JSON")
log "Found ${ISSUE_COUNT} issues."

if [ "$ISSUE_COUNT" = "0" ]; then
  err "No issues found in project ${PROJECT_KEY} with status '${JIRA_STATUS}'."
  exit 1
fi

# ── Step 1.5 [BROWNFIELD]: Codeline discovery ─────────────────────────────
# Greenfield path: JIRA_CODELINES is already declared in the project env file —
# this block is a complete no-op and the greenfield flow is unchanged.
#
# Brownfield path: EPAM_BROWNFIELD=1 + JIRA_CODELINE_ROOT set.  An LLM reads
# the pulled tickets and a filesystem manifest of local repos under
# JIRA_CODELINE_ROOT, then returns which repo(s) the tickets belong to.
# The result is exported as JIRA_CODELINES + JIRA_WORKTREE_<NAME> so the
# downstream synthesize-prd-from-jira.js step can build outputDirs without
# any hardcoded worktree paths in the project env file.
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "${JIRA_CODELINES:-}" ]; then
  if [ -z "${JIRA_CODELINE_ROOT:-}" ]; then
    err "EPAM_BROWNFIELD=1 requires JIRA_CODELINE_ROOT to point to the root of local repos."
    exit 1
  fi
  if [ ! -d "${JIRA_CODELINE_ROOT}" ]; then
    err "JIRA_CODELINE_ROOT does not exist: ${JIRA_CODELINE_ROOT}"
    exit 1
  fi
  log "Brownfield: running codeline discovery against ${JIRA_CODELINE_ROOT}..."
  DISCOVERY_JSON="$TMPDIR_INGEST/codeline-discovery.json"
  DISCOVERY_EXIT=0
  "$NODE_BIN" "${SCRIPT_DIR}/lib/codeline-discovery.js" \
    --issues "$ISSUES_JSON" \
    --root   "${JIRA_CODELINE_ROOT}" \
    --out    "$DISCOVERY_JSON" \
    $DRY_FLAG \
    2>&1 || DISCOVERY_EXIT=$?
  if [ "$DISCOVERY_EXIT" != "0" ]; then
    err "Codeline discovery failed (exit ${DISCOVERY_EXIT}). Cannot synthesize PRD."
    exit 1
  fi
  # PERSIST IT. Discovery's answer — which codelines exist and where each one lives — is
  # needed by every project-wide stage that follows: the detective sweep and the agent mint.
  # It was written only into this script's TMPDIR and exported as environment variables, and
  # ingest runs as a CHILD process, so both died at the closing brace. Live 2026-08-07: the
  # mint fell back to a single repository twice while three codelines were in scope, and the
  # ticket itself named all three. An artefact crosses a process boundary; an export does not.
  if [ -n "${LOG_DIR:-}" ] && [ -d "${LOG_DIR}" ]; then
    cp "$DISCOVERY_JSON" "${LOG_DIR}/codeline-discovery.json" 2>/dev/null \
      && log "Codeline discovery persisted → ${LOG_DIR}/codeline-discovery.json" \
      || warn "Could not persist codeline discovery to ${LOG_DIR} — later stages will see fewer codelines"
  fi
  # Export discovered codelines into the current shell so synthesize-prd-from-jira.js
  # inherits JIRA_CODELINES and JIRA_WORKTREE_<NAME> without any hardcoded env vars.
  _discovery_exports=$("$NODE_BIN" "${SCRIPT_DIR}/lib/handlers/codeline-discovery-exports.js" "$DISCOVERY_JSON")
  while IFS='=' read -r _key _val; do
    [ -z "$_key" ] && continue
    export "${_key}=${_val//\"/}"
  done <<< "$_discovery_exports"
  log "Codeline discovery complete: JIRA_CODELINES=${JIRA_CODELINES:-}"
fi

# ── Step 2: AC sufficiency gate ───────────────────────────────────────────
log "Running AC sufficiency gate..."
GATE_EXIT=0
# Use --out so JSON goes cleanly to file; all logs go to stderr (visible on terminal)
AC_GATE_DRY_RUN="${DRY_RUN}" \
  "$NODE_BIN" "${SCRIPT_DIR}/lib/ac-gate.js" \
    --issues "$ISSUES_JSON" \
    --out    "$GATE_JSON" \
    $DRY_FLAG \
    2>&1 || GATE_EXIT=$?

if [ "$GATE_EXIT" != "0" ] && [ "$GATE_EXIT" != "2" ]; then
  err "AC gate failed unexpectedly (exit ${GATE_EXIT})"
  exit 1
fi

# Show per-story verdicts
"$NODE_BIN" "${SCRIPT_DIR}/lib/handlers/ac-gate-verdicts.js" "$GATE_JSON" 2>/dev/null || true

INSUFFICIENT_COUNT=$("$NODE_BIN" "${SCRIPT_DIR}/lib/handlers/ac-gate-insufficient-count.js" "$GATE_JSON" 2>/dev/null || echo "0")

# Brownfield (AC/VC/TC design, 2026-07-24): a ticket with no/sparse ACs is NOT a
# human-halt condition — the acceptanceCriteria stay as the ticket's immutable
# intent (even empty), openspec-brownfield derives the VERIFICATION CRITERIA from
# the description, and SUFFICIENCY is decided by the code-graph-detective (no fix
# site + thin context → fail early, no human in the loop). Only halt on
# insufficient ACs in the NON-brownfield (greenfield) flow.
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && { [ "$GATE_EXIT" = "2" ] || [ "${INSUFFICIENT_COUNT:-0}" -gt "0" ]; }; then
  log "AC gate: ${INSUFFICIENT_COUNT} story/stories have sparse/no ACs — brownfield proceeds (ACs stay immutable; VCs derived from the description; the detective decides sufficiency). No human halt."
elif [ "$GATE_EXIT" = "2" ] || [ "$INSUFFICIENT_COUNT" -gt "0" ]; then
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  warn "  AC Gate: ${INSUFFICIENT_COUNT} story/stories have INSUFFICIENT ACs."
  warn "  Pipeline halted. Human approval required."
  warn ""
  # NOTHING WAS POSTED. This said permission-request comments had been posted to Jira and
  # to wait for a /approve-elaboration reply. ac-gate.js has no jira-client require and no
  # comment-posting path at all — deliberately, since this pipeline never writes to a client
  # system. So the message sent an operator to look for comments that do not exist, and to
  # wait for an approval nothing was ever going to receive.
  warn "  Nothing has been posted to Jira — this pipeline only reads client systems."
  warn "  Add the missing acceptance criteria to the ticket(s) above, then re-run."
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 2
fi

# ── Step 3: Synthesize PRD ────────────────────────────────────────────────
log "Synthesizing PRD from classified tickets..."
# Worktree paths are read from JIRA_WORKTREE_<CODELINE_UPPER> env vars by convention.
# No --be-dir/--fe-dir flags: synthesize-prd-from-jira.js discovers codelines from data.
# PRD template: synthesize-prd-from-jira.js keys it by story id and preserves each
# story's agentGroup/agentRole/effort, so it is what fixes lane TOPOLOGY. Without a
# --template it silently fell back to the built-in travel-app canonical for EVERY
# project. JIRA_PRD_TEMPLATE lets a project supply its own; unset keeps the previous
# default exactly, so existing projects are unaffected.
# Resolution order: the operator's explicit choice, then the PROJECT'S OWN canonical, then
# nothing — and nothing is now an ERROR: synthesize-prd-from-jira.js requires --template and
# has no built-in default, precisely so a run cannot inherit another project's identity.
#
# The middle step was missing, and no project set JIRA_PRD_TEMPLATE, so EVERY Jira-sourced
# run fell through to a built-in canonical belonging to one project and inherited its
# `project` block. Run 20260805T192100Z executed hello-dolly and produced
# project.name "skyscanner-app". Giving hello-dolly its own prd.canonical.json changed
# nothing, because nothing read it. A project's identity now comes from the directory that
# holds the project's facts, which every run already exports.
# NO PRD TEMPLATE. Synthesis used to fill a stored prd.canonical.json and spread the whole file
# into the result, so every value in it governed every run: metrolinx's carried a codeline scope
# frozen in by hand to unblock a launch, and because a declared scope makes discovery stand aside,
# discovery never ran. The same file had already been cleaned twice — another project's stack, and
# eight fabricated acceptance criteria.
#
# The PRD is INGESTED. Its work comes from the tracker and its identity from the project's own
# config; a stored third source is where one run's output becomes the next run's premise.
_synth_template_args=()

_out_prd_required
# PIPESTATUS[0], not the pipeline status. Without pipefail the status here is sed's —
# always 0 — so synthesize exiting 2 for a missing template was swallowed and the next line
# logged "PRD ready" for a file that was never written. Same trap this file guards against
# 70 lines above for the ingest call itself.
_synth_exit=0
"$NODE_BIN" "${SCRIPT_DIR}/synthesize-prd-from-jira.js" \
  --classifications "$GATE_JSON" \
  --out "$OUT_PRD" \
  "${_synth_template_args[@]}" \
  2>&1 | grep -E '^\[synthesize-prd\]|Error|error:' | sed 's/\[synthesize-prd\]/[ingest]/' >&2
_synth_exit="${PIPESTATUS[0]}"
# Exit 1, never synthesize's 2: this script already uses 2 for "insufficient ACs, human
# approval required", and a missing template reported as a ticket-quality problem sends the
# operator to fix the wrong thing.
if [ "$_synth_exit" != "0" ]; then
  err "PRD synthesis failed (exit ${_synth_exit}) — no PRD was written to ${OUT_PRD}"
  exit 1
fi
[ -s "$OUT_PRD" ] || { err "PRD synthesis reported success but wrote nothing to ${OUT_PRD}"; exit 1; }

log "PRD ready: ${OUT_PRD}"
echo "$OUT_PRD"
