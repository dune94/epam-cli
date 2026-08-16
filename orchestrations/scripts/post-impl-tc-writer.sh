#!/usr/bin/env bash
# post-impl-tc-writer.sh — TC (test criteria) generation gate.
#
# Runs after all impl stories in a phase complete, before any test stories start.
# Reads actual source files and writes testCriteria to prd.json for each pending
# test story. ACs are never modified — TCs are additive only.
#
# Usage:
#   bash post-impl-tc-writer.sh --prd <path> --phase <phase> --output-dir <dir>
#
# Skip:
#   SKIP_TC_WRITER=1  — bypass entirely (CI fast path)
#
# Exit 0 = TCs written or nothing to do.
# Exit 1 = TC generation failed and test stories exist — blocks pipeline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# EVERY ENTRY POINT READS THE LADDER DECLARATION ITSELF.
#
# lib/model-ladders.sh exists so that "what a tier contains" is declared once and read the same
# way everywhere. Only claude.sh, run-agent-orchestration.sh and detective-rerun.sh ever called
# it, so this script resolved its model ONLY from environment its parent happened to export. Run
# standalone — a replay, a retest, a test harness — nothing set EPAM_MODEL_LADDER_<TIER>,
# seam_ladder_export set no EPAM_MODEL, and this seam skipped its work while exiting 0.
#
# export_model_ladders leaves an already-set value alone, so calling it here changes nothing when
# the orchestrator has already exported the chain, and supplies it when nobody has.
_ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
if [ -f "$_ml_lib" ]; then
    # shellcheck source=lib/model-ladders.sh
    . "$_ml_lib" || true
    command -v export_model_ladders >/dev/null 2>&1 \
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json}" || true
fi
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "tc-writer"

source "$SCRIPT_DIR/lib/flags.sh"

# Files this run PRODUCED supersede the files it DECLARED.
#
# technicalNotes.files is a PREDICTION written during the spec pass; the manifest
# is a RECORD of what the run actually wrote. This script runs AFTER
# implementation, so the record is authoritative — and the reproducing test is
# created by a later agent, so it can never appear in a prediction made earlier.
_TCW_MANIFEST="${LOG_DIR:-$(dirname "$0")/../logs}/story-outputs-${PHASE:-core}.txt"
export _TCW_MANIFEST
PRD_FILE=""
PHASE=""
OUTPUT_DIR=""
STORY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --prd)        PRD_FILE="$2";    shift 2 ;;
    --phase)      PHASE="$2";       shift 2 ;;
    --output-dir) OUTPUT_DIR="$2";  shift 2 ;;
    # Optional: scope the gate to a single story instead of every test story
    # in the phase. Root cause this fixes (found live, 2026-07-08): the
    # inline per-story call site in run-agent-orchestration.sh's Step 1 loop
    # invokes this script right before ONE specific story runs — but without
    # scoping, it also processes every OTHER test story in the phase whose
    # impl hasn't run yet, gets a correct null/"source doesn't exist" reply
    # for them, and that unrelated null hard-failed the whole gate (and thus
    # aborted the phase) even though the one story the caller actually cared
    # about (e.g. SKY-002-test) was fine. When set, only that one story is
    # considered "needed" and only that one story is checked for success.
    --story)      STORY="$2";       shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if is_truthy "${SKIP_TC_WRITER:-}"; then
  echo "  [tc-writer] SKIP_TC_WRITER=1 — skipping gate"
  exit 0
fi

if [[ -z "$PRD_FILE" || ! -f "$PRD_FILE" ]]; then
  echo "  [tc-writer] ERROR: PRD not found: $PRD_FILE" >&2; exit 1
fi
if [[ -z "$PHASE" ]]; then
  echo "  [tc-writer] ERROR: --phase required" >&2; exit 1
fi
if [[ -z "$OUTPUT_DIR" || ! -d "$OUTPUT_DIR" ]]; then
  echo "  [tc-writer] ERROR: --output-dir not found: $OUTPUT_DIR" >&2; exit 1
fi

# ── Load tc-writer-agent profile ───────────────────────────────────────────────
PROFILES_FILE="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
TC_WRITER_PROFILE=""
if [ -f "$PROFILES_FILE" ]; then
  TC_WRITER_PROFILE=$(jq -r '."tc-writer-agent" // ""' "$PROFILES_FILE" 2>/dev/null || echo "")
fi
[ -z "$TC_WRITER_PROFILE" ] && TC_WRITER_PROFILE="You are the TC writer agent. Your job is to generate testCriteria JSON for test stories by reading actual implementation source files."

# ── Find test stories in this phase that need TCs ──────────────────────────────
TC_NEEDED=$(python3 "$SCRIPT_DIR/lib/handlers/tc-stories-needing-criteria.py" "$PRD_FILE" "$PHASE" "$STORY"
)

if [[ -z "$TC_NEEDED" ]]; then
  echo "  [tc-writer] No test stories need TCs in phase '$PHASE' — skipping"
  exit 0
fi

TC_COUNT=$(echo "$TC_NEEDED" | grep -c '[^[:space:]]')
echo ""
echo "  [tc-writer] Phase '$PHASE': $TC_COUNT test story/stories need TCs"
echo "$TC_NEEDED" | while read -r sid; do [ -n "$sid" ] && echo "    - $sid"; done

# ── Build the epam prompt ──────────────────────────────────────────────────────
TC_OUT_FILE="${SCRIPT_DIR}/../logs/tc-${PHASE}.json"
mkdir -p "$(dirname "$TC_OUT_FILE")"

# Build story context for the prompt
STORY_CONTEXT=$(python3 "$SCRIPT_DIR/lib/handlers/tc-story-context.py" "$OUTPUT_DIR" "$PRD_FILE" "$PHASE" "$STORY"
)

# RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
_tpl_vals=$(mktemp "${TMPDIR:-/tmp}/tc-writer-vals-XXXXXX.json")
jq -n --arg story_context "$STORY_CONTEXT" \
      --arg tc_out_file "$TC_OUT_FILE" \
      --arg tc_writer_profile "$TC_WRITER_PROFILE" \
      '{"__STORY_CONTEXT__":$story_context,"__TC_OUT_FILE__":$tc_out_file,"__TC_WRITER_PROFILE__":$tc_writer_profile}' > "$_tpl_vals" 2>/dev/null
if ! TC_PROMPT=$(render_engine_prompt tc-writer "$_tpl_vals"); then
    echo "[tc-writer] cannot render its prompt — refusing to run with no instructions" >&2
    rm -f "$_tpl_vals"; exit 1
fi
rm -f "$_tpl_vals"

# ── Run the TC writer agent ────────────────────────────────────────────────────
LOG_FILE="${SCRIPT_DIR}/../logs/tc-writer-${PHASE}.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "  [tc-writer] Invoking TC writer agent..."

# Resolve epam binary and keys
EPAM_BIN="${EPAM_BIN:-epam}"
# TC_WRITER_MODEL is set nowhere, so this default was the model the TC writer
# ACTUALLY ran on — the discontinued k2. Now the pipeline workhorse.
# THE SEAM DECIDES — see seam_ladder_export above, which sets EPAM_MODEL from this seam's
# declared tier. A literal here made that declaration decorative.
TC_MODEL="${TC_WRITER_MODEL:-${EPAM_MODEL:-}}"
TC_PROVIDER="${TC_WRITER_PROVIDER:-qwen}"

set +e
# `epam run` has no --cwd flag (Commander rejects it as unknown, always exit 1) —
# it operates on process.cwd() for its file tools, so change directory in a
# subshell instead of passing a nonexistent option.
(
  cd "$OUTPUT_DIR" && \
  EPAM_API_KEY_OPENAI="${OPENROUTER_API_KEY:-}" \
  EPAM_PROVIDER="$TC_PROVIDER" \
  EPAM_MODEL="$TC_MODEL" \
  EPAM_MAX_OUTPUT_TOKENS="${TC_WRITER_MAX_OUTPUT_TOKENS:-32768}" \
  EPAM_DANGEROUS_SKIP_APPROVAL=1 \
  EPAM_MAX_TOOL_CALLS="${TC_WRITER_MAX_TOOL_CALLS:-15}" \
    "$EPAM_BIN" run "$TC_PROMPT"
) 2>&1 | tee "$LOG_FILE"
TC_EXIT=${PIPESTATUS[0]}
set -e

# ── Validate and apply TCs to prd.json ─────────────────────────────────────────
python3 "$SCRIPT_DIR/lib/handlers/tc-apply-to-prd.py" "$TC_OUT_FILE" "$OUTPUT_DIR" "$PRD_FILE" "$TC_EXIT" "$PHASE" "$STORY"
