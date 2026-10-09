#!/usr/bin/env bash
# THE RETRY-EXTENSION COORDINATOR, FUNCTIONALLY, ON LIVE TOKENS — pipeline code only.
#
#   run.sh <work-dir> [converging|repeating]
#
# implement_story asks run_retry_extension_coordinator (lib/retry-extension.sh) once, after MAX_RETRIES is spent, whether
# to grant more attempts. This builds the state that call reads — healing-events.jsonl and the groundedness ledger for a
# story whose every self-heal produced a DISTINCT diagnosis (converging) or the same one again (repeating) — loads the
# engine exactly as claude.sh does on the live copilot set, and calls it. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; SHAPE="${2:-converging}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
ORCH="$REPO_ROOT/orchestrations"; NODE="${NODE_BIN:-$(command -v node)}"

SRC_PROJECT="${RETRY_EXTENSION_PROJECT:-$(ls -t "$HOME"/projects/tests/installs/*/orchestrations/projects/metrolinx/prompts/failure-analyst.json 2>/dev/null | head -1 | xargs -r dirname | xargs -r dirname)}"
[ -d "$SRC_PROJECT" ] || { echo "RESULT setup=no project config at '$SRC_PROJECT'"; exit 0; }
P="$W/project"; cp -r "$SRC_PROJECT" "$P"; chmod -R u+w "$P"; rm -rf "$P/runs" "$P/kb" "$P/prd.json"
R="$W/codeline"; mkdir -p "$R"; git -C "$R" init -q -b develop
L="$W/logs"; mkdir -p "$L"
PRD="$W/prd.json"
cat > "$PRD" <<'JSON'
{"stories":[{"id":"S-1","phase":"core","codeline":"hello","agentRole":"toast-messaging-engineer","status":"in-progress",
  "title":"Toast messages announce to screen readers",
  "acceptanceCriteria":["the toast region has role=status","the close button has an accessible name","errors use role=alert","focus returns to the trigger on close","the toast is dismissable with Escape","announcements are not duplicated"]}]}
JSON
# The ledgers implement_story would have written by the time MAX_RETRIES is spent: one heal event per attempt.
if [ "$SHAPE" = "repeating" ]; then
  DIAGS=("the close button has no accessible name" "the close button still has no accessible name" "close button missing accessible name again")
else
  DIAGS=("the toast region lacks role=status" "the close button has no accessible name" "errors are announced with role=status instead of role=alert" "focus is not returned to the trigger on close")
fi
i=0; for d in "${DIAGS[@]}"; do
  jq -nc --arg d "$d" --argjson r "$i" '{ts:"2026-10-08T00:00:00Z",story_id:"S-1",retry:$r,rung:($r/2|floor),target:"skill",diagnosis:$d,patches_applied:0,profile_updated:true}' >> "$L/healing-events.jsonl"
  jq -nc --argjson r "$i" '{storyId:"S-1",retry:$r,skipped:false,score:0.82}' >> "$L/failure-diagnosis-groundedness.jsonl"
  i=$((i + 1))
done
# A real run's healing check (check_healing_effectiveness) writes this once the same root cause recurs.
[ "$SHAPE" = "repeating" ] && jq -nc --arg d "${DIAGS[2]}" --argjson r "$((i - 1))" '{ts:"2026-10-08T00:00:00Z",story_id:"S-1",retry:$r,rung:($r/2|floor),target:"none",diagnosis:$d,patches_applied:0,profile_updated:false,event:"HEALING_BROKEN",repeated_diagnosis:$d,count:2}' >> "$L/healing-events.jsonl"

export SCRIPT_DIR="$ORCH/scripts" AUTOMATION_DIR="$ORCH" NODE_BIN="$NODE"
export PROJECT_ROOT="$R" OUTPUT_DIR="$R" PRD_FILE="$PRD" MAIN_PRD_FILE="$PRD" LOG_DIR="$L" PHASE=core
export EPAM_PROJECT_CONFIG_DIR="$P" EPAM_BROWNFIELD=1 EPAM_CODELINE=hello EPAM_PROVIDER_SET=copilot
export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
cd "$R"
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$P" || { echo "RESULT setup=project env failed"; exit 0; }
# shellcheck source=/dev/null
. "$SCRIPT_DIR/claude.sh"
set +e
echo "RESULT enabled=${EPAM_RETRY_EXTENSION_ENABLED:-<unset>} max=${EPAM_RETRY_EXTENSION_MAX:-<unset>} gate_provider=${ORCH_GATE_PROVIDER:-<none>} gate_model=${EPAM_MODEL:-<empty>}"
echo "RESULT evidence=$(compute_retry_extension_evidence S-1)"
retry_count=12; MAX_RETRIES=11
granted=$(run_retry_extension_coordinator S-1 2> "$L/coordinator.stderr")
echo "RESULT granted=${granted}"
echo "RESULT decision=$(tail -1 "$L/retry-extension-decisions.jsonl" 2>/dev/null || echo '<none recorded>')"
echo "RESULT call_errors=$(grep -v '^===' "$L/retry-extension-coordinator.log" 2>/dev/null | head -c 300 || true)"
exit 0
