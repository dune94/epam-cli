#!/usr/bin/env bash
# WHO CAN RESOLVE A GATE FINDING — THE REAL GATE-FINDING-ANALYST'S JUDGEMENT, ON LIVE TOKENS, COPIES ONLY.
#
#   run.sh <work-dir> [samples=3] [install]
#
# AMSD-2974 live run L2 (2026-10-14): the 7.x line's mutant-hunter found survivors in correct code (the test's mock
# returned top === bottom); every finding went back to the CODE writer, who may not touch tests, and the phase looped.
# The analyst now judges `work` and lib/gates-testing.sh routes a `tests` finding to the test-writer. This runs the
# REAL remediation block of run_testing_gates — sliced from lib/gates-testing.sh as it stands — with the real analyst
# on the Claude set and the project's own env; only what comes after the analyst is stood in (and recorded), so a
# sample costs one analyst call:
#   TRUE      — L2's own mutant-hunter log on a clone of the 7.x branch: every sample must route to the test-writer.
#   PLANTED   — a defect planted in the component, reported by a sast-sentinel and by a spec-validator log: every
#               sample must take the code route (story-ac-remediator).
# Writes only under <work-dir>; the install and the codeline are checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; SAMPLES="${2:-3}"; INSTALL="${3:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; LINE="$INSTALL/orchestrations/logs/lanes/cxshared/lines/7.x"
SRC="${CXSHARED_REPO:-$HOME/projects/metrolinx/cx-shared}"; LINE_BR=bugfix/AI-AMSD-2974-7.x; STORY=AMSD-2974
COMP=src/components/ToastNotification/ToastNotification.tsx
for f in "$LINE/prd.json" "$LINE/mutant-hunter-core.log" "$SRC/.git"; do [ -e "$f" ] || { echo "RESULT setup=missing $f"; exit 0; }; done
_sum() { { md5sum "$LINE/prd.json" "$LINE/mutant-hunter-core.log"; git -C "$SRC" for-each-ref --format='%(objectname) %(refname)'; git -C "$SRC" status --porcelain; } 2>/dev/null | md5sum | cut -c1-32; }
_before=$(_sum)

export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}"
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC
C="$W/project"; mkdir -p "$C"; tar -C "$P" --exclude=./runs -cf - . | tar -C "$C" -xf -
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export AUTOMATION_DIR="$REPO_ROOT/orchestrations" EPAM_AGENTS_DIR="$INSTALL/orchestrations/agents" NODE_BIN="$NODE"
export EPAM_PROJECT_CONFIG_DIR="$C" EPAM_CODELINE=cxshared EPAM_RELEASE_LINE=7.x

# The analyst is the real hub; everything after it answers as a stand-in and is recorded.
cat > "$W/runner.sh" <<EOF
#!/usr/bin/env bash
# DRY_ANALYST=<script>: a £0 run of the harness's own plumbing, the analyst stood in too.
[ "\${EPAM_AGENT_NAME:-}" = gate-finding-analyst ] && [ -n "\${DRY_ANALYST:-}" ] && exec bash "\$DRY_ANALYST"
[ "\${EPAM_AGENT_NAME:-}" = gate-finding-analyst ] && exec bash "$SCRIPT_DIR/ai-run.sh" "\$@"
cat > /dev/null; echo "\${EPAM_AGENT_NAME:-unknown}" >> "\$CASE_DIR/downstream.txt"
case "\${EPAM_AGENT_NAME:-}" in
  story-ac-remediator) echo '{"story_id":"$STORY","acs_added":0,"reason":"stand-in"}' ;;
  profile-augmentor)   echo '{"profile_updated": false}' ;;
esac
EOF
chmod +x "$W/runner.sh"
# The test-writer, stood in: records that the finding reached it.
mkdir -p "$W/scripts-tw"
cat > "$W/tw.sh" <<'EOF'
#!/usr/bin/env bash
echo "repro-test-writer finding=${EPAM_TEST_FINDING_FILE:-none}" >> "$CASE_DIR/downstream.txt"; exit 0
EOF
chmod +x "$W/tw.sh"

GT="$SCRIPT_DIR/lib/gates-testing.sh"
_slice() { awk '/^        if ! is_truthy "\$\{SKIP_GATE_REMEDIATION:-\}" && \[ \$\{#_failing_logs\[@\]\} -gt 0 \]; then$/{f=1} /^    success "Step 4.2: Testing gates PASSED"$/{f=0} f' "$GT"; }
_fn() { awk -v n="$1" '$0 ~ "^"n"\\(\\) \\{"{f=1} f{print} f && /^}$/{exit}' "$2"; }
[ -n "$(_slice)" ] || { echo "RESULT setup=remediation block not found in $GT"; exit 0; }

# case_run <name> <n> <gate-label> <gate-log> [plant]
case_run() {
    local name="$1" n="$2" label="$3" glog="$4" plant="${5:-}" d="$W/$1-$2"; mkdir -p "$d/logs"
    git clone -q --shared "$SRC" "$d/cx" 2>/dev/null && git -C "$d/cx" checkout -q -B "AI-${STORY}-7.x" "origin/$LINE_BR" 2>/dev/null \
        || git -C "$d/cx" checkout -q -B "AI-${STORY}-7.x" "$LINE_BR"
    if [ -n "$plant" ]; then
        bash -c "$plant" _ "$d/cx/$COMP" && git -C "$d/cx" -c user.email=t@t -c user.name=t commit -qam "${STORY}: story complete (1 file(s))"
    fi
    cp "$LINE/prd.json" "$d/logs/prd.json"; cp "$glog" "$d/logs/$(basename "$glog")"
    # The real script dir, except the test-writer.
    mkdir -p "$d/scripts"; cp -as "$SCRIPT_DIR/." "$d/scripts/" 2>/dev/null; rm -f "$d/scripts/brownfield-repro-test-writer.sh"; cp "$W/tw.sh" "$d/scripts/brownfield-repro-test-writer.sh"
    ( export CASE_DIR="$d" PROJECT_ROOT="$d/cx" OUTPUT_DIR="$d/cx" PRD_FILE="$d/logs/prd.json" LOG_DIR="$d/logs" EPAM_BROWNFIELD=1 \
             AI_RUNNER_CMD="$W/runner.sh" ACTIVITY_FILE="$d/logs/agent-activity.jsonl" JIRA_BASELINE_BRANCH=v7.11.0 GATE_LOG="$d/logs/$(basename "$glog")" GATE_LABEL="$label"
      cd "$d/cx" && bash -c "
        SCRIPT_DIR='$d/scripts'; CLAUDE_CMD="${CLAUDE_CMD:-claude}"
        info(){ echo \"INFO \$*\"; }; warning(){ echo \"WARN \$*\"; }; error(){ echo \"ERR \$*\"; }; success(){ echo \"OK \$*\"; }; log(){ echo \"LOG \$*\"; }
        . '$SCRIPT_DIR/lib/flags.sh'; . '$SCRIPT_DIR/lib/jq-vals.sh'; . '$SCRIPT_DIR/lib/render-engine-prompt.sh'; . '$SCRIPT_DIR/lib/phase-exit.sh'
        . '$SCRIPT_DIR/lib/model-ladders.sh'; export_model_ladders '$C/llm-settings.json' || true; . '$SCRIPT_DIR/lib/seam-ladder.sh'
        $(_fn _gate_attribute_from_log "$GT")
        $(_fn repro_writer_baseline "$SCRIPT_DIR/lib/repro-baseline.sh")
        rem() { local phase_id=core; local _failing_logs=(\"\$GATE_LOG\"); local _log_labels=(\"\$GATE_LABEL\"); local _profiles_file=\"\$EPAM_AGENTS_DIR/profiles.json\"; if true; then
        $(_slice)
        return 0; }
        ( set -e; rem ); echo \"RC=\$?\"" ) > "$d/out.txt" 2>&1
    local work route rc
    work=$(grep -aoE '"work"[[:space:]]*:[[:space:]]*"[a-z]+"' "$d/logs/gate-remediation-core.log" 2>/dev/null | tail -1 | grep -oE '"[a-z]+"$' | tr -d '"')
    route=$(sort -u "$d/downstream.txt" 2>/dev/null | sed 's/ finding=.*//' | tr '\n' ',' ); rc=$(grep -aoE '^RC=[0-9]+' "$d/out.txt" | tail -1)
    echo "RESULT $name-$n work=${work:-NONE} route=[${route}] ${rc:-RC=?}"
}

# The planted defect: the toast message is injected as raw HTML.
PLANT='sed -i "0,/{message}/s//<span dangerouslySetInnerHTML={{ __html: String(message) }} \/>/" "$1"; grep -q dangerouslySetInnerHTML "$1"'
SAST="$W/sast-sentinel-core.log"
printf '%s\n' "{\"agent\":\"sast-sentinel\",\"phase\":\"core\",\"verdict\":\"fail\",\"findings\":[{\"severity\":\"BLOCKER\",\"file\":\"$COMP\",\"line\":null,\"rule\":\"react-dangerously-set-inner-html\",\"message\":\"The toast message is rendered with dangerouslySetInnerHTML from caller-supplied text — stored/reflected XSS\",\"suggestedFix\":\"Render the message as text; never inject it as HTML\"}]}" > "$SAST"
SPEC="$W/spec-validator-core.log"
printf '%s\n' "{\"agent\":\"spec-validator\",\"phase\":\"core\",\"verdict\":\"fail\",\"stories\":[{\"storyId\":\"$STORY\",\"criteria\":[{\"text\":\"Toast message is announced as plain text to assistive technology\",\"status\":\"unmet\",\"evidence\":\"$COMP now renders the message through dangerouslySetInnerHTML; markup in the message is interpreted, not announced as text\",\"gaps\":\"The component must render the message as text\"}]}]}" > "$SPEC"

for n in $(seq 1 "$SAMPLES"); do
    case_run true "$n" mutant-hunter "$LINE/mutant-hunter-core.log"
done
case_run planted-sast 1 sast-sentinel "$SAST" "$PLANT"
case_run planted-spec 1 spec-validator "$SPEC" "$PLANT"
echo "RESULT install_and_codeline_untouched=$([ "$(_sum)" = "$_before" ] && echo yes || echo NO)"
