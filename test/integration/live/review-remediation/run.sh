#!/usr/bin/env bash
# REVIEW-REJECTION SELF-HEAL, ON LIVE TOKENS — the real remediator, run 9's real review rejections.
#
#   run.sh <work-dir> [install]
#
# AMSD-2974 run 9 (2026-10-10/11): the team-lead review rejected cxshared six times; the loop re-ran the writer with the
# review text and a higher rung and nothing else — no analyst, no episode, no requirement — and escalated when the last
# blocker was a decision the plan never made. lib/review-cycle.sh now calls _remediate_review_rejection first. This
# executes THAT function (sourced from the repo, with the pipeline's own render/seam/kb libraries) against copies of
# run 9's story and knowledge base, feeding it run 9's actual review messages, on the Claude set. Nothing is stood in.
#
# Scenarios (RED = what must NOT happen, GREEN = what must):
#   S1 final rejection — blocker: desktop placement clears the sticky header only above ~128px; plan has no placement
#      decision                         → GREEN: ≥1 AC added, at least one "Assumed requirement:"; episode recorded
#   S2 rejection — blocker: desktop placement still the production defect (translateY) → GREEN: ≥1 AC added
#   S3 rejection — blocker: info icon contrast 1.40:1 → GREEN: ≥1 AC added
#   S4 rejection carrying NO blocker/major finding     → GREEN: no analyst call, 0 ACs (nothing invented)
#   S5 S3's message when the story ALREADY has an AC settling its blocker → GREEN: that AC is not duplicated (the
#      message's other, uncovered finding may still be remediated)
#
# Writes only under <work-dir>; the install is checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${2:-${REMEDIATION_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs/lanes/cxshared"
CHK="$P/runs/20261010T043322Z/lanes/cxshared/checkpoint/prd.json"
OUT="$L/messages/outbox"; STORY=AMSD-2974
for f in "$CHK" "$OUT/msg-1791696958849.json"; do [ -f "$f" ] || { echo "RESULT setup=missing $f"; exit 0; }; done
_before=$(md5sum "$CHK" "$P"/kb/*.json* 2>/dev/null | md5sum | cut -c1-32)

# The project's env on the Claude set, as the launcher runs it.
export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}"
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC
C="$W/project"; mkdir -p "$C"; cp -a "$P"/config*.env "$P"/llm-settings.json "$P"/manifest.json "$P"/plugins.json "$C"/ 2>/dev/null
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export AUTOMATION_DIR="$REPO_ROOT/orchestrations" EPAM_AGENTS_DIR="$INSTALL/orchestrations/agents" AI_RUNNER_CMD="$SCRIPT_DIR/ai-run.sh" NODE_BIN="$NODE"

feedback_from() { "$NODE" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({story_id:m.story_id,issues:(m.body&&m.body.data&&m.body.data.issues)||[]}))' "$1"; }

scenario() {   # <name> <message-file> [ac-to-pre-add]
    local name="$1" msg="$2" pre="${3:-}" d="$W/$1"; mkdir -p "$d/logs" "$d/cfg/kb"
    cp "$CHK" "$d/prd.json"
    cp "$P"/kb/*.json* "$d/cfg/kb/" 2>/dev/null || true
    feedback_from "$msg" > "$d/logs/review-feedback-$STORY.json"
    if [ -n "$pre" ]; then
        "$NODE" -e 'const [f,id,ac]=process.argv.slice(1);const p=JSON.parse(require("fs").readFileSync(f,"utf8"));const s=p.stories.find(x=>x.id===id);(s.acceptanceCriteria=s.acceptanceCriteria||[]).push(ac);require("fs").writeFileSync(f,JSON.stringify(p,null,2))' "$d/prd.json" "$STORY" "$pre"
    fi
    local acs_before; acs_before=$(jq --arg id "$STORY" '[.stories[]|select(.id==$id)|.acceptanceCriteria[]?]|length' "$d/prd.json")
    local ep_before; ep_before=$(wc -l < "$d/cfg/kb/healing-events.jsonl" 2>/dev/null || echo 0)
    local calls="$d/calls"
    bash -c '
        set -uo pipefail
        SCRIPT_DIR="$1"; LOG_DIR="$2"; PRD_FILE="$3"; MAIN_PRD_FILE=""; PHASE=core; _review_cycle=1
        # What run-agent-orchestration.sh defines before it sources these libraries.
        RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; MAGENTA=""; NC=""
        export EPAM_PROJECT_CONFIG_DIR="$4"
        . "$SCRIPT_DIR/lib/orch-common.sh" 2>/dev/null || { log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "WARN $*"; }; success(){ echo "$*"; }; error(){ echo "ERR $*"; }; }
        . "$SCRIPT_DIR/lib/render-engine-prompt.sh"; . "$SCRIPT_DIR/lib/seam-ladder.sh"; . "$SCRIPT_DIR/lib/review-cycle.sh"
        declare -F _remediate_review_rejection >/dev/null || { echo "NO_REMEDIATION_FUNCTION"; exit 0; }
        _remediate_review_rejection "$LOG_DIR/review-feedback-'"$STORY"'.json" '"$STORY"'
        echo "ADDED=${REVIEW_REMEDIATION_ADDED:-0}"
    ' _ "$SCRIPT_DIR" "$d/logs" "$d/prd.json" "$d/cfg" > "$d/out.txt" 2>&1
    local added; added=$(grep -oE '^ADDED=[0-9]+' "$d/out.txt" | cut -d= -f2)
    local acs_after; acs_after=$(jq --arg id "$STORY" '[.stories[]|select(.id==$id)|.acceptanceCriteria[]?]|length' "$d/prd.json")
    local assumed; assumed=$(jq -r --arg id "$STORY" '[.stories[]|select(.id==$id)|.acceptanceCriteria[]?|(.text? // .)|select(type=="string" and test("^Assumed requirement:"))]|length' "$d/prd.json")
    local ep_after; ep_after=$(wc -l < "$d/cfg/kb/healing-events.jsonl" 2>/dev/null || echo 0)
    local ep_role; ep_role=$(tail -n +$((ep_before + 1)) "$d/cfg/kb/healing-events.jsonl" 2>/dev/null | jq -r 'select(.failure_class=="review-rejected")|.agent_role' | head -1)
    local called; called=$(ls "$d"/logs/review-remediation-*-cycle*.txt 2>/dev/null | wc -l)
    grep -q NO_REMEDIATION_FUNCTION "$d/out.txt" && echo "RESULT $name function=ABSENT (code under test has no review remediation)"
    echo "RESULT $name analyst_called=$called acs_before=$acs_before acs_after=$acs_after added=${added:-0} assumed=$assumed episode_role=${ep_role:-none}"
    jq -r --arg id "$STORY" '.stories[]|select(.id==$id)|.acceptanceCriteria[]?|(.text? // .)' "$d/prd.json" | tail -n +$((acs_before + 1)) | sed "s/^/RESULT $name   + /" | cut -c1-260
}

M=$OUT
scenario S1 "$M/msg-1791696958849.json"
scenario S2 "$M/msg-1791693546182.json"
scenario S3 "$M/msg-1791689291248.json"
scenario S4 "$M/msg-1791645086037.json"
scenario S5 "$M/msg-1791689291248.json" "The info toast's type icon has a contrast ratio of at least 4.5:1 against the toast background in both themes."

v() { grep -oE "^RESULT $1 .*" "$W"/RESULTS 2>/dev/null; }
echo "RESULT install_untouched=$([ "$(md5sum "$CHK" "$P"/kb/*.json* 2>/dev/null | md5sum | cut -c1-32)" = "$_before" ] && echo yes || echo NO)"
