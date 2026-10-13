#!/usr/bin/env bash
# A BACK-PORT'S REVIEWER COMPARES IT WITH ITS OWN LINE'S CHANGE — ON LIVE TOKENS, THE REAL REVIEWER, COPIES ONLY.
#
#   run.sh <work-dir> [rounds=2] [install]
#
# AMSD-2974 run 9 (2026-10-13): cx-shared's 7.x back-port carried a fraction of the 8.x change (no header-measured
# placement, no pointer-events on the empty container, no stopped close click) and its reviewer approved it — it was
# given the plan's summary and the line's last commit, never the 8.x change. lib/release-lines.sh now hands every line
# its own line's committed change (template release-line-port), and lib/review-scope.sh gives the reviewer the story's
# whole change. This runs THE reviewer a run uses (team-lead-review.sh, the Claude set, the project's own env) on
# clones of cx-shared and copies of the 7.x line's logs:
#   RED   — today's 7.x branch: every round must NOT approve.
#   GREEN — the 8.x change applied on v7.11.0 (it applies cleanly): no round may reject it for a missing port.
# Writes only under <work-dir>; the install and the codelines are checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; ROUNDS="${2:-2}"; INSTALL="${3:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; LANE="$INSTALL/orchestrations/logs/lanes/cxshared"; LINE="$LANE/lines/7.x"
SRC="${CXSHARED_REPO:-$HOME/projects/metrolinx/cx-shared}"; STORY=AMSD-2974
MAIN_BR=bugfix/AI-AMSD-2974; LINE_BR=bugfix/AI-AMSD-2974-7.x
for f in "$LINE/prd.json" "$LINE/phase-baseline-sha.txt" "$LANE/phase-baseline-sha.txt" "$SRC/.git"; do [ -e "$f" ] || { echo "RESULT setup=missing $f"; exit 0; }; done
_sum() { { md5sum "$LINE/prd.json" "$LINE/story-changes.jsonl" "$LINE/code-reviews.jsonl"; git -C "$SRC" for-each-ref --format='%(objectname) %(refname)'; } 2>/dev/null | md5sum | cut -c1-32; }
_before=$(_sum)

# The change the codeline's own line made — as lib/release-lines.sh computes it.
git -C "$SRC" diff "$(tr -d '[:space:]' < "$LANE/phase-baseline-sha.txt")" "$MAIN_BR" > "$W/main-line-change.diff"
[ -s "$W/main-line-change.diff" ] || { echo "RESULT setup=no main-line change"; exit 0; }

# The project's env on the Claude set, as the launcher runs it.
export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}"
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC
C="$W/project"; mkdir -p "$C"; tar -C "$P" --exclude=./runs -cf - . | tar -C "$C" -xf -
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export AUTOMATION_DIR="$REPO_ROOT/orchestrations" EPAM_AGENTS_DIR="$INSTALL/orchestrations/agents" AI_RUNNER_CMD="$SCRIPT_DIR/ai-run.sh" NODE_BIN="$NODE"
export EPAM_PROJECT_CONFIG_DIR="$C" EPAM_CODELINE=cxshared EPAM_RELEASE_LINE=7.x EPAM_MAIN_LINE_BRANCH="$MAIN_BR" EPAM_BROWNFIELD=1

# case <name> <round> — a clone at the case's branch, the line's logs copied, the real reviewer run once.
case_run() {
    local name="$1" round="$2" d="$W/$1-$2"; mkdir -p "$d"
    git clone -q --shared "$SRC" "$d/cx-shared" 2>/dev/null
    git -C "$d/cx-shared" checkout -q -B "AI-${STORY}-7.x" "origin/$LINE_BR"
    # THE LINE'S REVIEW LOG STAYS (KEEP_APPROVAL=1, the default): a resume meets the line's earlier approval, and whether
    # it stands is part of what is proven (2026-10-13: it stood, "not re-reviewed", and the weak port went to GO).
    cp -a "$LINE" "$d/logs"; rm -f "$d/logs"/review-feedback-*.json
    [ "${KEEP_APPROVAL:-1}" = 1 ] || rm -f "$d/logs/code-reviews.jsonl"
    cp "$W/main-line-change.diff" "$d/main-line-change.diff"
    if [ "$name" = green ]; then
        # The 8.x change ported as-is onto the line's base, committed as the pipeline commits a story.
        git -C "$d/cx-shared" checkout -q -B "AI-${STORY}-7.x" "$(tr -d '[:space:]' < "$LINE/phase-baseline-sha.txt")"
        git -C "$d/cx-shared" apply --3way "$d/main-line-change.diff" >/dev/null 2>&1 || { echo "RESULT $name-$round setup=8.x change does not apply"; return; }
        git -C "$d/cx-shared" -c user.email=t@t -c user.name=t commit -qam "${STORY}: story complete (3 file(s))"
        jq -cn --arg id "$STORY" --arg sha "$(git -C "$d/cx-shared" rev-parse HEAD)" '{storyId:$id, sha:$sha, committedAt:(now|todate)}' > "$d/logs/story-changes.jsonl"
    fi
    ( export PROJECT_ROOT="$d/cx-shared" OUTPUT_DIR="$d/cx-shared" PRD_FILE="$d/logs/prd.json" LOG_DIR="$d/logs" \
             REVIEW_LOG="$d/logs/code-reviews.jsonl" AGENT_IO_DIR="$d/logs/agent-io" EPAM_MAIN_LINE_CHANGE="$d/main-line-change.diff" \
             ACTIVITY_FILE="$d/logs/agent-activity.jsonl" JIRA_BASELINE_BRANCH=v7.11.0
      "$NODE" "$SCRIPT_DIR/lib/producers/fix-plan.js" --publish "$PRD_FILE" 2>/dev/null
      bash "$SCRIPT_DIR/team-lead-review.sh" core ) > "$d/review.out" 2>&1
    local verdict issues port
    grep -q "approval stands, not re-reviewed" "$d/review.out" && echo "RESULT $name-$round STOOD_NOT_REVIEWED"
    verdict=$(jq -r 'select(.phase_id=="core") | .verdict // .review_status' "$d/logs/code-reviews.jsonl" 2>/dev/null | tail -1)
    issues=$(jq -r 'select(.phase_id=="core") | .issues_found // 0' "$d/logs/code-reviews.jsonl" 2>/dev/null | tail -1)
    port=$(cat "$d/logs"/review-feedback-*.json 2>/dev/null | grep -oiE "TOP_RIGHT|pointer-?events|stopPropagation|header|8\.x|port" | sort -u | tr '\n' ' ')
    echo "RESULT $name-$round verdict=${verdict:-NONE} issues=${issues:-?} port_terms=[${port}] scope=\"$(grep -aoE 'Reviewing [^ ]+ on its whole change[^(]*' "$d/review.out" | head -1)\""
    grep -q "THE CHANGE THIS RELEASE LINE PORTS" -r "$d/logs" 2>/dev/null && echo "RESULT $name-$round port_section_in_prompt=yes" || echo "RESULT $name-$round port_section_in_prompt=NO"
}

for r in $(seq 1 "$ROUNDS"); do case_run red "$r"; case_run green "$r"; done
echo "RESULT install_and_codelines_untouched=$([ "$(_sum)" = "$_before" ] && echo yes || echo NO)"
