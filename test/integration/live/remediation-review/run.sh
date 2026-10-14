#!/usr/bin/env bash
# A REMEDIATOR'S CRITERIA ARE JUDGED — THE REAL PRD-CHANGE-REVIEWER, LIVE TOKENS, COPIES ONLY.
#
#   run.sh <work-dir> [samples=3] [install]
#
# apply_reviewed_acs (lib/reviewed-acs.sh) puts every remediator's proposed criteria before the prd-change-reviewer.
# This runs THE reviewer a run uses — the Claude set, the project's own env and roster — on copies of a release line's
# PRD, with proposals taken from what rehearsal rv3 actually produced:
#   BAD   — criteria that dictate the FORM of a test (rv3's AC14/AC15): every sample must reject; nothing is added.
#   GOOD  — a criterion stating observable behaviour the finding is about: every sample must approve; it is added.
# Writes only under <work-dir>; the install is checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; SAMPLES="${2:-3}"; INSTALL="${3:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; LINE="$INSTALL/orchestrations/logs/lanes/cxshared/lines/7.x"; STORY=AMSD-2974
# THE STORY AS ITS PLAN STATES IT — the lane's PRD approved at pause 2 (seven criteria). The line's own PRD also carries
# criteria earlier remediations added unjudged, and the reviewer rightly caps a story's criteria.
PLAN_PRD="${PLAN_PRD:-$P/runs/20261010T043322Z/lanes/cxshared/checkpoint/prd.json}"
for f in "$PLAN_PRD" "$INSTALL/orchestrations/agents/profiles.json"; do [ -e "$f" ] || { echo "RESULT setup=missing $f"; exit 0; }; done
_before=$(md5sum "$PLAN_PRD" | cut -c1-32)

export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}"
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC
C="$W/project"; mkdir -p "$C"; tar -C "$P" --exclude=./runs -cf - . | tar -C "$C" -xf -
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export AUTOMATION_DIR="$REPO_ROOT/orchestrations" EPAM_AGENTS_DIR="$INSTALL/orchestrations/agents" NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$C"
export AGENT_PROFILES_FILE="$EPAM_AGENTS_DIR/profiles.json" SCRIPT_DIR
[ -n "${ORCH_GATE_PROVIDER:-}" ] || { echo "RESULT setup=the project env declares no gate provider — the reviewer cannot run"; exit 0; }

BAD1='The test case validating distinct header-portal edges must refactor the makeHeaderPortal call from positional arguments to a named-parameter object makeHeaderPortal({ top: 200, bottom: 260 }).'
BAD2='The desktop top offset test must call makeHeaderPortal({ top: 180, bottom: 180 }) with a named-parameter object rather than local variables.'
GOOD='When the site header'"'"'s top and bottom edges differ, the desktop toast is positioned below the header'"'"'s bottom edge, and a test fails if the top edge is used instead.'

# case_run <name> <n> <acs-json>
case_run() {
    export AI_RUNNER_CMD="${RR_RUNNER:-}"; [ -n "$AI_RUNNER_CMD" ] || unset AI_RUNNER_CMD
    local name="$1" n="$2" acs="$3" d="$W/$1-$2"; mkdir -p "$d"
    cp "$PLAN_PRD" "$d/prd.json"
    printf 'remediator output:\n%s\n' "$(jq -cn --arg s "$STORY" --argjson a "$acs" '{story_id:$s, acs_added:($a|length), acs:$a}')" > "$d/raw.txt"
    local before after added
    before=$(jq '.stories[0].acceptanceCriteria | length' "$d/prd.json")
    added=$( ( LOG_DIR="$d"
        log(){ echo "LOG $*" >&2; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ echo "OK $*" >&2; }
        . "$SCRIPT_DIR/lib/model-ladders.sh"; export_model_ladders "$C/llm-settings.json" || true; . "$SCRIPT_DIR/lib/seam-ladder.sh"
        . "$SCRIPT_DIR/lib/reviewed-acs.sh"
        apply_reviewed_acs "$d/prd.json" "$STORY" "$d/raw.txt" ac-apply.py ) 2> "$d/err.txt" )
    after=$(jq '.stories[0].acceptanceCriteria | length' "$d/prd.json")
    local verdict; verdict=$(grep -oE "APPROVED|REJECTED|not approved|unreviewed|cannot render" "$d/err.txt" | head -1)
    echo "RESULT $name-$n added=${added:-?} criteria=${before}->${after} reviewer=${verdict:-NONE}"
}

for n in $(seq 1 "$SAMPLES"); do
    case_run bad "$n" "$(jq -cn --arg a "$BAD1" --arg b "$BAD2" '[$a,$b]')"
    case_run good "$n" "$(jq -cn --arg a "$GOOD" '[$a]')"
done
echo "RESULT install_untouched=$([ "$(md5sum "$PLAN_PRD" | cut -c1-32)" = "$_before" ] && echo yes || echo NO)"
