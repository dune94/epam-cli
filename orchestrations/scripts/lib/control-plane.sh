#!/usr/bin/env bash
# control-plane.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (15 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# is_parent — true in the top-level orchestrator process. Guard project-wide work with this:
# anything that allocates a run-global resource, mutates shared state, or must happen exactly
# once per run regardless of how many codelines are in scope.
is_parent() { [ "$(orch_role)" = 'parent' ]; }

# REGISTERED HERE, NOT IN cleanup() — BECAUSE bash INSTALLS A HANDLER WHEN IT REACHES IT.
#
# The export used to ride along inside cleanup(), which is registered at the foot of this file.
# A run only ever had a cassette handler installed if it survived that far. The first `exit` in
# this script is thousands of lines earlier, so ingest, codeline discovery, spec-mode, the mint
# and roster derivation all failed into a trap that did not yet include the export.
#
# Measured 2026-09-11 by the free mockserver rehearsal: roster derivation failed, the write
# perimeter released (registered at the top of this file, so it was installed), cleanup never
# ran, and the run left nothing to replay. An early structural failure is exactly the run worth
# replaying, and it was the one guaranteed to leave no recording.
#
# Registered beside the recorder it uses: reaching the source line is the only precondition.
_epam_export_cassette() {
    declare -F export_run_cassette >/dev/null 2>&1 || return 0
    local _cas_run_id="${ORCH_RUN_ID:-${EPAM_RUN_ID:-${RUN_NUMBER:-}}}"
    [ -n "$_cas_run_id" ] || return 0
    export_run_cassette "$_cas_run_id" \
        "$(basename "${EPAM_PROJECT_CONFIG_DIR:-project}")" \
        "${EPAM_CASSETTE_DIR:-${AUTOMATION_DIR:-$SCRIPT_DIR/..}/cassettes}" || true
}

_resolve_control_plane_port() {
    # Reads only the environment and the PRD — plus is_parent(), the single place the
    # parent/lane role is derived. A harness testing this in isolation must carry those
    # helpers with it; duplicating the role check here would be the very thing they exist
    # to prevent.
    local _base="${CONTROL_PLANE_BASE_PORT:-8094}"
    # An explicit override always wins — the operator can pin a port.
    if [ -n "${CONTROL_PLANE_PORT:-}" ]; then
        printf '%s' "$CONTROL_PLANE_PORT"; return 0
    fi
    # THE PARENT AND ITS LANES ARE THE SAME SCRIPT, SO THEY MUST NOT DERIVE THE SAME PORT.
    #
    # This script is both the parent orchestrator and, re-invoked with JIRA_CODELINE_RUN=1,
    # each lane — so every per-run resource is allocated twice. The lane is derived from the
    # codeline whose outputDirs[].path matches project.outputDir, and the synthesizer sets
    # project.outputDir = outputDirs[0].path, so the PARENT resolved to codeline index 0 —
    # exactly what the FIRST LANE resolves to from its own filtered PRD.
    #
    # That collision is not benign: start_control_plane kills whatever already holds the port
    # ("a stale process from a previous run") before binding. The first lane therefore killed
    # the parent's control plane and took the port, and when the lane finished its cleanup
    # stopped the control plane entirely — leaving the port dead while the parent still held a
    # PID it believed was live.
    #
    # The parent reserves the base port. Lanes are offset past it, so no lane can ever land on
    # it. Lanes keep their own control plane — each has its own LOG_DIR to serve.
    if is_parent; then
        printf '%s' "$_base"; return 0
    fi

    # EPAM_CODELINE is what the lane invocation actually exports; CODELINE_NAME is kept as the
    # documented override. Reading only the latter meant every lane fell through to the PRD
    # lookup, since nothing in this script has ever set it.
    local _lane="${CODELINE_NAME:-${EPAM_CODELINE:-}}"
    if [ -z "$_lane" ] && [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _lane=$(jq -r '.project as $p | (($p.outputDirs // []) | map(select(.path == $p.outputDir)) | .[0].codeline) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    if [ -z "$_lane" ]; then
        printf '%s' "$_base"; return 0
    fi
    local _idx=""
    if [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _idx=$(jq -r --arg cl "$_lane" '((.project.outputDirs // []) | map(.codeline) | index($cl)) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    if [ -z "$_idx" ] || [ "$_idx" = "null" ]; then
        _idx=$(printf '%s' "$_lane" | cksum | awk '{print $1 % 64}')
    fi
    # +1 so lane 0 clears the parent's reserved base port.
    printf '%s' "$(( _base + 1 + _idx ))"
}

step_emit() {
    local step_id="$1"
    local status="$2"
    local label="$3"
    local reason="${4:-}"
    local ts
    ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)

    _STEP_LABELS["$step_id"]="$label"
    _STEP_STATUS["$step_id"]="$status"
    # Only overwrite the stored reason when this call actually supplied one —
    # many terminal-state calls (e.g. the final "pass") are emitted right
    # after a "running" call with no reason, and would otherwise blank out
    # a real detail a caller set moments earlier (found while wiring real
    # per-step detail through to the dashboard, 2026-07-13).
    [ -n "$reason" ] && _STEP_REASON["$step_id"]="$reason"

    local icon
    case "$status" in
        pass)    icon="${GREEN}  ✓${NC}" ;;
        skip)    icon="${YELLOW}  ⊘${NC}" ;;
        fail)    icon="${RED}  ✗${NC}" ;;
        warn)    icon="${YELLOW}  ⚠${NC}" ;;
        running) icon="${CYAN}  ▶${NC}" ;;
        *)       icon="    " ;;
    esac

    local reason_str=""
    [ -n "$reason" ] && reason_str=" ${YELLOW}[${reason}]${NC}"
    echo -e "${icon} ${label}${reason_str}"

    # Write JSON snapshot (atomic via tmp file)
    local tmp_file="${STEP_STATUS_FILE}.tmp.$$"
    {
        echo "{"
        echo "  \"phase\": \"${PHASE:-unknown}\","
        echo "  \"updatedAt\": \"${ts}\","
        echo "  \"steps\": ["
        local first=true
        local _sid _slabel _sstatus _sreason
        for _sid in \
            "1:spec" "1a:openspec" "1b:speckit" "2:cpa" "3:skill-pre" "4:hybrid-coord" "5:regression" \
            "6:mkdir" "7:model-coord" "8:main-stories" "9:auto-commit" "10:tc-writer" \
            "11:skills-audit" "12:tools-audit" "13:worktrees" "14:primary" "15:independent" "16:wt-health" \
            "17:wt-merge" "18:skill-post" "19:pre-review" "20:lint-gate" \
            "21:review-stories" "22a:sast" "22b:spec-val" \
            "22c:review-ranger" "22d:mutant-hunter" \
            "22e:fuzz-weaver" "22f:perf-sentinel" "23:e2e"; do
            local _key="${_sid%%:*}"
            _slabel="$(_json_escape_str "${_STEP_LABELS[$_key]:-${_sid#*:}}")"
            _sstatus="${_STEP_STATUS[$_key]:-pending}"
            _sreason="$(_json_escape_str "${_STEP_REASON[$_key]:-}")"
            [ "$first" = "true" ] && first=false || echo ","
            printf '    {"id":"%s","label":"%s","status":"%s","detail":"%s"}' \
                "$_key" "$_slabel" "$_sstatus" "$_sreason"
        done
        echo ""
        echo "  ]"
        echo "}"
    } > "$tmp_file" && mv "$tmp_file" "$STEP_STATUS_FILE" 2>/dev/null || true
}

# Print full step checklist (called once at run start, after skip detection)
print_step_checklist() {
    echo ""
    echo -e "${MAGENTA}━━━ Pipeline Step Checklist ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    printf "  %-6s %-32s %s\n" "Step" "Name" "Planned"
    printf "  %-6s %-32s %s\n" "------" "--------------------------------" "--------"

    _checklist_row() {
        local step="$1" name="$2" planned="$3" reason="${4:-}"
        local color
        case "$planned" in
            ACTIVE) color="$GREEN" ;;
            SKIP)   color="$YELLOW" ;;
            COND)   color="$CYAN" ;;
            *)      color="$NC" ;;
        esac
        # A SWITCH ONLY MEANS SOMETHING ON A ROW THAT IS ACTUALLY OFF.
        #
        # The reason was printed unconditionally, and for the skip-toggle rows it is the variable
        # that DISABLES the step — so a running gate rendered as
        #     5      Regression guard          ACTIVE (SKIP_REGRESSION_GUARD=true)
        # which reads as "skipped, here is the proof". Eleven rows did this on every run: the
        # status was computed and correct, and the text beside it contradicted the status.
        #
        # By SHAPE, not by a list of rows: several rows pass the resolved MODEL here, which is the
        # most useful thing on the line and must survive. `NAME=value` is a switch; a model name
        # never looks like one. So a switch is shown only when the row is not ACTIVE.
        local reason_str=""
        if [ -n "$reason" ] \
           && { [ "$planned" != "ACTIVE" ] || ! printf '%s' "$reason" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; }; then
            reason_str=" (${reason})"
        fi
        printf "  %-6s %-32s " "$step" "$name"
        echo -e "${color}${planned}${reason_str}${NC}"
    }

    if [ -n "${RESOLVED_RUN_MODE:-}" ]; then
        echo -e "  ${CYAN}RUN MODE: ${RESOLVED_RUN_MODE}${NC} — the SKIP rows below are what it turns off"
    fi
    _checklist_row "1"    "Specification pass"       "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "EPAM_SPEC_MODE=0"
    _checklist_row "1a"   "  openspec (elaboration)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "$(seam_model_or_fail "spec-agent" 2>/dev/null || printf '<unresolved>')"
    _checklist_row "1b"   "  speckit (verification)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "$(seam_model_or_fail "spec-agent" 2>/dev/null || printf '<unresolved>')"
    _checklist_row "2"  "CPA pre-pass"             "$(is_truthy "${SKIP_CPA:-}" && echo SKIP || echo ACTIVE)"           "SKIP_CPA=1"
    _checklist_row "3"  "Pre-phase skill assess"   "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "4"  "Hybrid pre-coord"         "$([ "${RESOLVED_ORCH_MODE:-bash}" = "hybrid" ] && echo ACTIVE || echo SKIP)" "ORCH_MODE≠hybrid"
    _checklist_row "5"  "Regression guard"         "$(is_truthy "${SKIP_REGRESSION_GUARD:-}" && echo SKIP || echo ACTIVE)" "SKIP_REGRESSION_GUARD=true"
    _checklist_row "6"  "mkdir src/ dirs"          "ACTIVE"
    _checklist_row "7"  "PRD model coordinator"    "$(is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}" && echo SKIP_PRD_MODEL_COORDINATOR=1 || true)"
    _checklist_row "8"    "Main-branch stories"      "ACTIVE"
    _checklist_row "9"  "Auto-commit"              "COND"  "if uncommitted changes"
    _checklist_row "10"  "TC writer gate"           "$(is_truthy "${SKIP_TC_WRITER:-}" && echo SKIP || echo COND)" "SKIP_TC_WRITER=1 or no test stories"
    _checklist_row "11" "Skills coordinator audit" "$(is_truthy "${SKIP_SKILLS_AUDIT:-}" && echo SKIP || echo ACTIVE)" "SKIP_SKILLS_AUDIT=1"
    _checklist_row "12" "Tools coordinator audit"  "$(is_truthy "${SKIP_TOOLS_AUDIT:-}" && echo SKIP || echo ACTIVE)" "SKIP_TOOLS_AUDIT=1"
    _checklist_row "13"    "Create worktrees"         "COND"  "if parallel stories exist"
    _checklist_row "14"   "Primary agent"            "COND"  "if primary stories"
    _checklist_row "15"   "Independent agent"        "COND"  "if independent stories"
    _checklist_row "16"  "Worktree health check"    "COND"  "if worktrees created"
    _checklist_row "17"  "Merge worktrees"          "COND"  "if worktrees created"
    _checklist_row "18"  "Post-parallel assessment" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "19"  "Pre-review gate"          "$(is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && echo SKIP || echo ACTIVE)" "SKIP_PRE_REVIEW_GATE=true"
    _checklist_row "20"  "Lint gate"                "$(is_truthy "${SKIP_LINT_GATE:-}" && echo SKIP || echo ACTIVE)" "SKIP_LINT_GATE=true"
    _checklist_row "21"    "Review stories"           "COND"  "if review stories exist"
    _checklist_row "22a" "SAST sentinel"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22b" "Spec validator"           "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22c" "Review ranger"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22d" "Mutant hunter"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22e" "Fuzz-weaver"              "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22f" "Perf sentinel"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22g" "Runtime boundary"         "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "23"  "Browser E2E routing"     "$([ "${SKIP_BROWSER_E2E_ROUTING:-false}" = "true" ] && echo SKIP || echo COND)" "SKIP_BROWSER_E2E_ROUTING=true"

    local skips=0
    for key in "1" "2" "3" "4" "5" "6" "7" "8" "9" "10" "11" "12" "13" "14" "15" "16" "17" "18" "19" "21" "22a" "22b" "22c" "22d" "22e" "22f" "23"; do
        [ "${_STEP_STATUS[$key]:-}" = "skip" ] && skips=$((skips + 1))
    done
    echo ""
    echo -e "  ${YELLOW}SKIP bypass env vars active: SKIP_TESTING_GATES=${SKIP_TESTING_GATES:-false}  SKIP_CPA=${SKIP_CPA:-0}  SKIP_TC_WRITER=${SKIP_TC_WRITER:-0}  SKIP_REGRESSION_GUARD=${SKIP_REGRESSION_GUARD:-false}${NC}"
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

seed_runtime_logs() {
    mkdir -p "$LOG_DIR" "$LOG_DIR/phase-improvements"
    local files=(
        "agent-activity.jsonl"
        "agent-messages.jsonl"
        "code-reviews.jsonl"
        "cpa-review.jsonl"
        "phase-cost.jsonl"
        "phase-gates.jsonl"
        "profiles-audit.jsonl"
        "testing-gates.jsonl"
    )
    local f
    for f in "${files[@]}"; do
        [ -f "$LOG_DIR/$f" ] || : > "$LOG_DIR/$f"
    done
}

# Kill a process and every descendant, leaves first. `pkill -P` reaches only direct children:
# `npx @11ty/eleventy` runs eleventy as ITS child, so killing npx's children and npx left eleventy
# alive after every run — five of them, 4GB resident, measured 2026-09-14 after five finished
# harness runs (one of which exited 0).
_epam_kill_tree() {
    local _pid="$1" _child
    for _child in $(pgrep -P "$_pid" 2>/dev/null); do
        _epam_kill_tree "$_child"
    done
    kill "$_pid" 2>/dev/null || true
}

stop_dashboards_watch() {
    if [ "$DASHBOARD_WATCH_OWNED" != "true" ] || [ -z "$DASHBOARD_WATCH_PID" ]; then
        return
    fi
    if ps -p "$DASHBOARD_WATCH_PID" > /dev/null 2>&1; then
        info "Stopping dashboards watcher (PID $DASHBOARD_WATCH_PID)..."
        _epam_kill_tree "$DASHBOARD_WATCH_PID"
        wait "$DASHBOARD_WATCH_PID" 2>/dev/null || true
    fi
    rm -f "$DASHBOARD_WATCH_PID_FILE"
    DASHBOARD_WATCH_PID=""
    DASHBOARD_WATCH_OWNED=false
}

start_control_plane() {
    if [ "${EPAM_CONTROL_PLANE:-1}" != "1" ]; then
        info "Control plane disabled (EPAM_CONTROL_PLANE=0)."
        return
    fi
    local _node_bin
    _node_bin=$(detect_node 2>/dev/null || true)
    if [ -z "$_node_bin" ]; then
        warning "Control plane: node binary not found — skipping."
        return
    fi
    local cp_script="$SCRIPT_DIR/control-plane.js"
    if [ ! -f "$cp_script" ]; then
        warning "Control plane script not found at $cp_script — skipping."
        return
    fi
    # Remove stale PAUSED sentinel from a previous run
    rm -f "$LOG_DIR/PAUSED"
    # Kill any stale process holding the control plane port from a previous run
    local _stale_pid
    _stale_pid=$(lsof -ti "tcp:${CONTROL_PLANE_PORT}" 2>/dev/null || true)
    if [ -n "$_stale_pid" ]; then
        warning "Killing stale process on port ${CONTROL_PLANE_PORT} (PID $_stale_pid)"
        kill "$_stale_pid" 2>/dev/null || true
        sleep 0.3
    fi
    CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT}" \
    LOG_DIR="$LOG_DIR" \
        "$_node_bin" "$cp_script" >> "$CONTROL_PLANE_LOG" 2>&1 &
    CONTROL_PLANE_PID=$!
    sleep 0.5
    if ! ps -p "$CONTROL_PLANE_PID" > /dev/null 2>&1; then
        warning "Control plane exited immediately; see $CONTROL_PLANE_LOG"
        CONTROL_PLANE_PID=""
        return
    fi
    info "Control plane started (PID $CONTROL_PLANE_PID, port $CONTROL_PLANE_PORT)"
}

stop_control_plane() {
    if [ -z "$CONTROL_PLANE_PID" ]; then
        return
    fi
    if ps -p "$CONTROL_PLANE_PID" > /dev/null 2>&1; then
        kill "$CONTROL_PLANE_PID" 2>/dev/null || true
        wait "$CONTROL_PLANE_PID" 2>/dev/null || true
    fi
    CONTROL_PLANE_PID=""
}

start_dashboards_watch() {
    local dashboards_dir="$AUTOMATION_DIR/dashboards"
    local config_path="$dashboards_dir/.eleventy.js"
    local local_eleventy_bin="$dashboards_dir/node_modules/.bin/eleventy"

    if [ "${EPAM_DASH_AUTO_SERVE:-1}" != "1" ]; then
        info "Dashboard auto-serve disabled (EPAM_DASH_AUTO_SERVE=0)."
        return
    fi
    if [ ! -f "$config_path" ]; then
        warning "Dashboards config not found at $config_path; skipping auto-serve."
        return
    fi
    # A lane re-exec must never start its own watcher. The parent run already has
    # one, and the pid-file check below is NOT atomic: three lanes launched
    # together all read the file before any of them wrote it, so live metrolinx
    # 2026-07-29 ran three Eleventy stacks rebuilding the same dashboard from the
    # same LOG_DIR — ~120% CPU competing with the lanes for identical output.
    # Sequential lanes hid this by never overlapping. A lock would also close the
    # race; not starting it at all is simpler and strictly correct, because the
    # lane has nothing to serve that the parent is not already serving.
    if is_lane; then
        return
    fi
    if [ -n "$DASHBOARD_WATCH_PID" ]; then
        return
    fi
    if [ -f "$DASHBOARD_WATCH_PID_FILE" ]; then
        local existing_pid
        existing_pid="$(cat "$DASHBOARD_WATCH_PID_FILE" 2>/dev/null || true)"
        if [ -n "$existing_pid" ] && ps -p "$existing_pid" > /dev/null 2>&1; then
            info "Eleventy dashboards watcher already running (PID $existing_pid)."
            DASHBOARD_WATCH_PID="$existing_pid"
            return
        fi
    fi

    # NOTE: EPAM_PROJECT_OUTPUT_DIR is intentionally NOT exported to the Eleventy
    # subprocess here. snapshot.js's agentActivity/agentStatus/phaseCost paths use
    # process.env.EPAM_PROJECT_OUTPUT_DIR directly (not via resolveProjectOutputDir),
    # and those files live in orchestrations/logs — which the dashboard's logs/ symlink
    # already resolves correctly. Exporting EPAM_PROJECT_OUTPUT_DIR=OUTPUT_DIR would
    # redirect those reads to the project output dir (wrong place). The .active-output-dir
    # pointer written by pre-run-reset.sh is sufficient for resolveProjectOutputDir(),
    # which only feeds healingEvents/storyFailures/guardedStepRetries (files in OUTPUT_DIR).

    if [ -x "$local_eleventy_bin" ]; then
        info "Starting Eleventy dashboards watcher (local binary)..."
        (
            cd "$PROJECT_ROOT" || exit 1
            exec "$local_eleventy_bin" \
                "--config=$config_path" \
                "--input=$dashboards_dir" \
                "--output=$dashboards_dir/live" \
                --serve >> "$DASHBOARD_WATCH_LOG" 2>&1
        ) &
    elif command -v npx >/dev/null 2>&1; then
        info "Starting Eleventy dashboards watcher (npx --prefix)..."
        (
            cd "$PROJECT_ROOT" || exit 1
            exec npx --prefix "$dashboards_dir" @11ty/eleventy \
                "--config=$config_path" \
                "--input=$dashboards_dir" \
                "--output=$dashboards_dir/live" \
                --serve >> "$DASHBOARD_WATCH_LOG" 2>&1
        ) &
    else
        warning "Neither local Eleventy binary nor npx is available; skipping dashboard auto-serve."
        return
    fi

    DASHBOARD_WATCH_PID=$!
    DASHBOARD_WATCH_OWNED=true
    echo "$DASHBOARD_WATCH_PID" > "$DASHBOARD_WATCH_PID_FILE"
    sleep 1
    if ! ps -p "$DASHBOARD_WATCH_PID" > /dev/null 2>&1; then
        warning "Dashboards watcher exited immediately; see $DASHBOARD_WATCH_LOG"
        rm -f "$DASHBOARD_WATCH_PID_FILE"
        DASHBOARD_WATCH_PID=""
        DASHBOARD_WATCH_OWNED=false
    fi
}

# Cleanup on exit
cleanup() {
    local exit_code=$?
    # THE RUN LEAVES A CASSETTE HOWEVER IT ENDS — and this is the only place that can promise it.
    #
    # Export-on-completion sat at the end of _run_codeline_loop(), which a run reaches only by
    # running to the end. pause-before-writer ends the process with `exit 0` hundreds of lines
    # earlier, and every failure path is a bare `exit 1`/`2`/`3`. pipeline-tests-48 is the one
    # install that carried that hook and has no cassettes directory at all: the run paused, so the
    # hook never ran, while Langfuse held all 286 traces the whole time. Langfuse records each call
    # as it happens, so the recording was never pending — waiting for completion to harvest it was
    # the defect.
    #
    # `trap ... EXIT` fires on every exit path bash controls, including ones added later, so this
    # cannot be forgotten by whoever writes the next `exit`. FIRST in the trap, before the control
    # plane is torn down, because the export reads a service that teardown is about to stop. It
    # cannot change what the run reports: $? is already captured above, and export_run_cassette
    # never fails the caller.
    #
    # NOT COVERED HERE: `kill -9` and an OOM kill bypass every trap. Only a harvest that does not
    # depend on this process can cover those.
    # The cassette export is registered beside lib/cassette-archive.sh, near the top of this
    # file, so that a run failing before cleanup() is even registered still leaves a recording.
    stop_control_plane
    stop_dashboards_watch
    if [ "$SKIP_CLEANUP" = "true" ]; then
        warning "Skipping worktree cleanup (--skip-cleanup)"
        return
    fi
    if [ $exit_code -ne 0 ]; then
        error "Execution failed with exit code $exit_code"
    fi
    log "Cleaning up worktrees..."
    "$CLAUDE_SH" --cleanup-worktrees 2>/dev/null || true
}

# PUBLISH THE PLAN THIS PROCESS WILL WORK FROM — outside the spec-pass branch, deliberately.
#
# The detective renders its own answer (lib/producers/fix-plan.js) and it is published once, from
# THIS process's PRD, so consumers stop reading story.fixSiteAnalysis and inventing their own
# wording of it. Publishing from this PRD is what keeps a lane's writer on its own plan: a lane
# runs with its own scoped PRD, while the canonical one holds the UNION of every codeline — on
# AMSD-2041 that is 13 sites where gotransit has 4, including three conflicting prescriptions for
# one file.
#
# It sits OUTSIDE the spec-pass branch because a resume routinely skips the spec pass. Inside it,
# a resumed run would publish nothing, the plan would simply be absent, and the writer would go in
# blind — which looks exactly like a run that never had a plan.
_publish_agent_outputs() {
    local _node="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ -x "$_node" ] || _node="$(command -v node 2>/dev/null || echo node)"
    [ -f "${PRD_FILE:-}" ] || return 0
    "$_node" "$SCRIPT_DIR/lib/producers/fix-plan.js" --publish "$PRD_FILE" \
        || warning "fix-plan publication failed — consumers will find no published plan"
}

# ── Periodic checklist heartbeat ─────────────────────────────────────────────
# Prints a compact step-status summary every 60s so long-running phases stay
# visible in the log without requiring tail.
_checklist_heartbeat() {
    while true; do
        sleep 60
        echo ""
        echo -e "${MAGENTA}━━━ Step Status @ $(date +%H:%M:%S) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        for _sid in \
            "1:Specification pass" "1a:openspec" "1b:speckit" "2:CPA pre-pass" \
            "3:Skill assessment" "4:Hybrid pre-coord" "5:Regression guard" \
            "6:mkdir src/ dirs" "7:PRD model coordinator" "8:Main-branch stories" \
            "9:Auto-commit" "10:TC writer gate" "11:Skills coordinator audit" \
            "12:Tools coordinator audit" "13:Create worktrees" "14:Primary agent" \
            "15:Independent agent" "16:Worktree health" "17:Merge worktrees" \
            "18:Post-parallel assessment" "19:Pre-review gate" "20:Lint gate" \
            "21:Review stories" "22a:SAST sentinel" "22b:Spec validator" \
            "22c:Review ranger" "22d:Mutant hunter" \
            "22e:Fuzz-weaver" "22f:Perf sentinel" "23:Browser E2E"; do
            local _key="${_sid%%:*}"
            local _st="${_STEP_STATUS[$_key]:-pending}"
            local _lbl="${_STEP_LABELS[$_key]:-${_sid#*:}}"
            local _icon
            case "$_st" in
                pass)    _icon="${GREEN}✓${NC}" ;;
                skip)    _icon="${YELLOW}⊘${NC}" ;;
                fail)    _icon="${RED}✗${NC}" ;;
                warn)    _icon="${YELLOW}⚠${NC}" ;;
                running) _icon="${CYAN}▶${NC}" ;;
                *)       _icon="${WHITE}○${NC}" ;;
            esac
            printf "  %b %-6s %s\n" "${_icon}" "$_key" "$_lbl"
        done
        echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
    done
}

# Kill heartbeat on exit — ADDED, never replacing the handlers registered above.
_epam_kill_heartbeat() { kill "${_HEARTBEAT_PID:-}" 2>/dev/null || true; }
