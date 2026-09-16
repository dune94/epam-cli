#!/usr/bin/env bash
# cli-commands.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (10 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# Delegates to lib/env-file.sh: loading configuration must not EXECUTE it. This function
# used to `. "$env_file"`, and a bare `cd` on line 1 of the repo's .env sent this script —
# the agent invoker — to $HOME every time it started.
load_env_file() {
    load_env_file_safe "$1"
}

# Initialize directories and logs
initialize() {
    mkdir -p "$(dirname "$PROGRESS_LOG")"
    mkdir -p "$CLAUDE_OUTPUT_DIR"

    if [ ! -f "$PROGRESS_LOG" ]; then
        cat > "$PROGRESS_LOG" << EOF
=== EPAM CLI Orchestration Progress Log ===
Started: $(date)
Project: $(jq -r '.project.name // "Unknown"' "$PRD_FILE" 2>/dev/null || echo "Unknown")
==========================================

EOF
    fi
}

# Log event to agent-status.json if running in orchestration mode
log_to_monitor() {
    local event_type=$1
    local story_id=$2
    local message=$3
    local monitor_file="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"

    # Only log if monitor file exists (orchestration mode)
    if [ ! -f "$monitor_file" ]; then
        return 0
    fi

    local lane="${WORKTREE_MODE:-main}"
    local role
    role=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local timestamp
    timestamp=$(date -Iseconds)

    # Use flock to prevent race conditions
    (
        flock -w 5 200 || return 1

        # Add event to events array
        local tmp_file="${monitor_file}.tmp.$$"
        jq --arg type "$event_type" \
           --arg story "$story_id" \
           --arg lane "$lane" \
           --arg role "$role" \
           --arg msg "$message" \
           --arg ts "$timestamp" \
           '.events += [{"type": $type, "story": $story, "lane": $lane, "role": $role, "message": $msg, "timestamp": $ts}]' \
           "$monitor_file" > "$tmp_file" && mv "$tmp_file" "$monitor_file"
    ) 200>"${monitor_file}.lock"
}

# List available phases with status
list_phases() {
    echo ""
    echo -e "${MAGENTA}=== Implementation Phases ===${NC}"
    echo ""

    local phases
    phases=$(get_phases)

    if [ -z "$phases" ]; then
        echo -e "${YELLOW}No phases defined in implementationOrder${NC}"
        return
    fi

    while IFS= read -r phase; do
        [ -z "$phase" ] && continue

        local total=0
        local completed=0
        local stories
        stories=$(get_phase_stories "$phase")

        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            total=$((total + 1))
            if is_story_completed "$story_id"; then
                completed=$((completed + 1))
            fi
        done <<< "$stories"

        local status_color=$YELLOW
        local status_icon="o"
        if [ $completed -eq $total ] && [ $total -gt 0 ]; then
            status_color=$GREEN
            status_icon="+"
        elif [ $completed -gt 0 ]; then
            status_color=$CYAN
            status_icon="~"
        fi

        echo -e "${status_color}${status_icon}${NC} ${WHITE}$phase${NC} ($completed/$total completed)"

        # Show stories in phase
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            local title
            title=$(get_story_title "$story_id")
            if is_story_completed "$story_id"; then
                echo -e "    ${GREEN}+${NC} $story_id: $title"
            else
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                local deps_info=""
                if [ -n "$deps" ]; then
                    if are_dependencies_satisfied "$story_id"; then
                        deps_info=" ${CYAN}(deps: $deps)${NC}"
                    else
                        deps_info=" ${RED}(blocked by: $deps)${NC}"
                    fi
                fi
                echo -e "    ${YELLOW}o${NC} $story_id: $title$deps_info"
            fi
        done <<< "$stories"
        echo ""
    done <<< "$phases"
}

update_monitor_status() {
    local event="$1"   # "start" | "complete" | "fail"
    local story_id="$2"
    local message="${3:-}"
    local lane="${WORKTREE_MODE:-main}"
    local title
    title=$(get_story_title "$story_id" 2>/dev/null || echo "$story_id")
    local role
    role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local update_script="$SCRIPT_DIR/update-monitor.sh"
    [ ! -x "$update_script" ] && return 0
    case "$event" in
        start)
            # Orchestration already emitted story_start with the correct model when it
            # launched this subprocess via run_story_with_watchdog. Skip the duplicate.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_start "$story_id" "$lane" "$role" "$title" \
                    "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
            fi
            ;;
        complete)
            # Orchestration emits story_complete after the TSC gate (the authoritative
            # "story is done and types pass" signal). Skip the duplicate from claude.sh
            # for main-lane stories managed by orchestration.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_complete "$story_id" "$lane" "$title" \
                    "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
            fi
            ;;
        fail)
            "$update_script" story_fail "$story_id" "$lane" "$message" 2>/dev/null || true
            ;;
    esac
}

# run_planning_phase <story_id> <planner_model>
# Invokes the planner model with a focused planning prompt.
# Outputs a structured step-by-step execution plan as plain text on stdout.
# Uses the same SDK/CLI path as execution invocations.
run_planning_phase() {
    local story_id="$1"
    local planner_model="$2"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(get_story_title "$story_id")
    local ac
    ac=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/- /' || echo "")
    # Extract the exact output paths from technicalNotes.files — the planner must
    # use these verbatim. Without them, the planner invents paths based on convention
    # (e.g. tests/ instead of src/skyscanner/), which the executor faithfully follows
    # to the wrong location and exhausts all turns trying to recover (151K token bloat).
    local declared_files declared_files_raw
    declared_files_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null || echo "")
    # These are forwarded to the child process invoked below. shellcheck cannot see the consumer,
    # so it reports them unused; removing them would take the values away from the child.
    # shellcheck disable=SC2034
    declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")
    # Inject dependency contracts so the planner also uses the correct READ paths.
    local plan_dep_contracts=""
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '[.stories[] | select(.id == $id) | (.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _cf="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        [ -f "$_cf" ] && plan_dep_contracts="${plan_dep_contracts}
### Contract: ${_dep_id}
$(cat "$_cf")
"
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-producer-vals-XXXXXX.json")
    jq_vals \
          --arg declared_paths "$(_classify_declared_paths "${declared_files_raw}")" \
          --arg dependency_contracts "$([ -n "$plan_dep_contracts" ] && printf '\n## Dependency Contracts (ground-truth import paths and signatures — use these verbatim in read/import steps)\n%s\n' "$plan_dep_contracts" || true)" \
          --arg cross_codeline_contract "$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)" \
          --arg story_id "${story_id}" \
          --arg title "${title}" \
          --arg ac "${ac}" \
          '{"__DECLARED_PATHS__":$declared_paths,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__CROSS_CODELINE_CONTRACT__":$cross_codeline_contract,"__STORY_ID__":$story_id,"__TITLE__":$title,"__AC__":$ac}' > "$_cp_vals"
    local planning_prompt
    planning_prompt="$(render_engine_prompt plan-producer "$_cp_vals")"
    rm -f "$_cp_vals"

    local plan_result_file
    plan_result_file=$(mktemp /tmp/plan-${story_id}-XXXXXX.json)
    local plan_text=""

    local plan_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}"
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        echo "$planning_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
            --cache-system \
            --model "$planner_model" \
            --system-prompt "$plan_constitution" \
            --output "$plan_result_file" 2>/dev/null || true
        plan_text=$(jq -r '.result // empty' "$plan_result_file" 2>/dev/null || cat "$plan_result_file" 2>/dev/null || echo "")
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${planner_model:-${EPAM_MODEL:-}}"
        if [ -n "$_orch_provider" ]; then
            # PLANNING SAMPLING, not the writer's. The planning turn wants determinism and
            # structure; execution sampling is per-model and, for some models, the opposite
            # (GLM-5.2 wants HIGH temperature to execute). Sharing one setting made the
            # per-model execution profiles meaningless for the plan. Config: planning.*
            # Applied inside the command substitution's SUBSHELL, so the planning values cannot
            # leak into the writer that follows. Two constructs were tried and rejected:
            #   ${VAR:+FOO=bar} as an assignment prefix — assignments are recognised at PARSE
            #     time, so a word produced by EXPANSION becomes the command name instead. It
            #     silently broke the invocation whether the var was set or not.
            #   env ${VAR:+FOO=bar} — this environment's PATH shadows GNU env with a shell shim
            #     at ~/.local/bin/env (same trap already documented above for `env -u`).
            plan_text=$(
                [ -n "${EPAM_PLANNING_TEMPERATURE:-}" ] && export EPAM_TEMPERATURE="$EPAM_PLANNING_TEMPERATURE"
                [ -n "${EPAM_PLANNING_TOP_P:-}" ] && export EPAM_TOP_P="$EPAM_PLANNING_TOP_P"
                [ -n "${EPAM_PLANNING_EFFORT:-}" ] && export EPAM_REASONING_EFFORT="$EPAM_PLANNING_EFFORT"
                echo "$planning_prompt" | \
                EPAM_AGENT_NAME="plan-producer" EPAM_STORY_ID="${story_id}" \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                2>/dev/null || echo "")
        fi
    fi

    rm -f "$plan_result_file"
    echo "$plan_text"
}

# Show PRD status with phase information
show_status() {
    echo ""
    echo -e "${MAGENTA}=== PRD Status ===${NC}"
    echo ""

    local total
    total=$(jq '.stories | length' "$PRD_FILE")
    local completed
    completed=$(jq '[.stories[] | select(.completed == true)] | length' "$PRD_FILE")
    local pending=$((total - completed))

    echo -e "Project: ${CYAN}$(jq -r '.project.name' "$PRD_FILE")${NC}"
    echo -e "Total Stories: $total"
    echo -e "Completed: ${GREEN}$completed${NC}"
    echo -e "Pending: ${YELLOW}$pending${NC}"
    echo ""

    # Show next recommended story
    local next
    next=$(get_next_story)
    if [ -n "$next" ]; then
        echo -e "Next recommended: ${WHITE}$next${NC} - $(get_story_title "$next")"
        local phase
        phase=$(get_story_phase "$next")
        [ -n "$phase" ] && echo -e "                 Phase: ${CYAN}$phase${NC}"
    fi
    echo ""

    echo -e "${CYAN}Stories by Phase:${NC}"

    local phases
    phases=$(get_phases)
    if [ -n "$phases" ]; then
        while IFS= read -r phase; do
            [ -z "$phase" ] && continue
            echo -e "\n  ${WHITE}$phase:${NC}"

            local stories
            stories=$(get_phase_stories "$phase")
            while IFS= read -r story_id; do
                [ -z "$story_id" ] && continue
                local title
                title=$(get_story_title "$story_id")
                local priority
                priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .priority // "medium"' "$PRD_FILE")
                local priority_badge=""
                case $priority in
                    high) priority_badge=" ${RED}[H]${NC}" ;;
                    low) priority_badge=" ${BLUE}[L]${NC}" ;;
                esac

                if is_story_completed "$story_id"; then
                    echo -e "    ${GREEN}+${NC} $story_id: $title$priority_badge"
                elif are_dependencies_satisfied "$story_id"; then
                    echo -e "    ${YELLOW}o${NC} $story_id: $title$priority_badge ${CYAN}(ready)${NC}"
                else
                    local deps
                    deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                    echo -e "    ${RED}x${NC} $story_id: $title$priority_badge ${RED}(blocked: $deps)${NC}"
                fi
            done <<< "$stories"
        done <<< "$phases"
    else
        # No phases, show flat list
        jq -r '.stories[] | "\(.id): \(.title) [\(if .completed then "DONE" else "PENDING" end)]"' "$PRD_FILE" | while read line; do
            if [[ "$line" == *"[DONE]"* ]]; then
                echo -e "  ${GREEN}+${NC} $line"
            else
                echo -e "  ${YELLOW}o${NC} $line"
            fi
        done
    fi
    echo ""
}

# Dry run - show what would be implemented
dry_run() {
    local stories=("$@")
    local phase_filter=""

    echo ""
    echo -e "${MAGENTA}=== Dry Run ===${NC}"
    echo ""

    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        echo -e "${GREEN}All stories are already completed (or blocked by dependencies)!${NC}"
        return
    fi

    echo "The following stories would be implemented (in order):"
    echo ""

    local order=1
    for story_id in "${stories[@]}"; do
        if ! story_exists "$story_id"; then
            echo -e "  ${RED}x${NC} $story_id - NOT FOUND"
            continue
        fi

        local phase
        phase=$(get_story_phase "$story_id")
        local phase_info=""
        [ -n "$phase" ] && phase_info=" ${CYAN}[$phase]${NC}"

        if is_story_completed "$story_id"; then
            echo -e "  ${YELLOW}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [ALREADY COMPLETED]"
        elif ! are_dependencies_satisfied "$story_id"; then
            local deps
            deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
            echo -e "  ${RED}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [BLOCKED: $deps]"
        else
            echo -e "  ${CYAN}$order.${NC} $story_id - $(get_story_title "$story_id")$phase_info"
            order=$((order + 1))
        fi
    done
    echo ""
}

run_implementation() {
    local stories=("$@")
    local implemented=0
    local failed=0
    local skipped=0

    # If no specific stories provided, get prioritized list
    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        success "All stories are already completed (or blocked by dependencies)!"
        return 0
    fi

    log "======================================"
    log "EPAM CLI Orchestration Loop Starting"
    log "Stories to implement: ${stories[*]}"
    log "======================================"

    echo ""
    get_project_context
    echo ""

    for story_id in "${stories[@]}"; do
        log "--------------------------------------"

        # Validate story exists
        if ! story_exists "$story_id"; then
            error "Story $story_id not found in PRD"
            failed=$((failed + 1))
            continue
        fi

        # Skip if already completed
        if is_story_completed "$story_id"; then
            warning "Story $story_id is already completed, skipping"
            skipped=$((skipped + 1))
            continue
        fi

        # Same live-status re-check the main lane's Step 1 loop already does
        # (run-agent-orchestration.sh) — a worktree-lane story can be
        # deprecated by a mid-execution split rejection, or blocked by the
        # inline TC writer gate below, after this loop's own story list was
        # built. Parity required: "all lanes must have the same flow no
        # deviations."
        local _wt_story_status
        _wt_story_status=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .status // "pending"' \
            "$PRD_FILE" 2>/dev/null || echo "pending")
        if [ "$_wt_story_status" = "deprecated" ]; then
            info "Skipping $story_id — deprecated after being enqueued (mid-execution split rejected this story)"
            skipped=$((skipped + 1))
            continue
        fi
        if [ "$_wt_story_status" = "blocked" ]; then
            info "Skipping $story_id — blocked (no valid testCriteria after 3 attempts, see blocked-stories.jsonl)"
            skipped=$((skipped + 1))
            continue
        fi

        # Check dependencies using check-dependencies.sh if available
        local dep_checker="$SCRIPT_DIR/check-dependencies.sh"
        if [ -x "$dep_checker" ]; then
            # Use dedicated dependency checker for better validation and output
            if ! PRD_FILE="$PRD_FILE" "$dep_checker" "$story_id" 2>&1; then
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        else
            # Fallback to inline dependency check
            if ! are_dependencies_satisfied "$story_id"; then
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        fi

        # Inline TC writer gate — same shared check the main lane runs
        # (lib/tc-writer-gate.sh), now also applied to worktree lanes (this
        # was the gap: worktree-lane pure-test stories used to run their
        # entire first execution with testCriteria.facts=[] since the only
        # other TC mechanism, the batch Step 1.6 gate, runs after Step 3.2 —
        # i.e. after this loop has already finished).
        local _wt_tc_phase
        _wt_tc_phase="${phase_filter:-$(get_story_phase "$story_id")}"
        if ! run_inline_tc_writer_gate "$story_id" "$_wt_tc_phase"; then
            skipped=$((skipped + 1))
            continue
        fi

        # Remaining per-story guards the main lane's Step 1 loop already runs
        # (run-agent-orchestration.sh), now shared via lib/story-guards.sh so
        # worktree lanes get the identical cost-budget circuit breaker,
        # pause/resume support, and operator redirects a main-lane story
        # already has. PHASE is set as a plain global (not `local`) because
        # these guards read $PHASE directly — same convention
        # run-agent-orchestration.sh itself already uses.
        PHASE="$_wt_tc_phase"
        check_cost_budget
        wait_if_paused
        apply_redirect_if_any "$story_id"

        # Implement the story
        if implement_story "$story_id"; then
            update_story_status "$story_id" "completed"
            implemented=$((implemented + 1))
            # Deterministically regenerate the dependency contract from the actual
            # source this story just wrote — before committing, so the contract file
            # itself is included in the same commit and visible to dependent stories.
            # Diagnostic timestamps (added 2026-07-06): a live run's watchdog killed
            # a story's claude.sh subprocess after 600s even though the story itself
            # had already succeeded in 15s — neither generate_story_contract() nor
            # commit_completed_story() logged anything before/after, so it was
            # impossible to tell which one (if either) actually hung. These log
            # lines make the next occurrence immediately diagnosable instead of
            # another blind guess.
            log "  [post-story] Generating dependency contract for $story_id..."
            generate_story_contract "$story_id"
            log "  [post-story] Contract generation complete for $story_id"
            # Commit this story's work immediately. Stories in the same worktree run
            # sequentially (chained by dependency), and if a LATER story in this loop
            # exhausts its retries and fails, the whole worktree process returns non-zero
            # — which makes the orchestrator skip Step 3.1/3.2 (auto-commit + merge)
            # entirely and force-remove the worktree, permanently destroying every
            # earlier story's uncommitted work. Committing per-story means that work
            # survives on the wt-* branch (worktree removal deletes the checkout, not
            # the branch/commits) even when a downstream story in the chain fails.
            log "  [post-story] Committing completed work for $story_id..."
            # `|| true` (found live, 2026-07-14, same incident as the two
            # set -e fixes inside commit_completed_story() itself): this
            # whole script runs under `set -e`. commit_completed_story()
            # legitimately returns 1 on a git-add failure or a secret-scan
            # rejection (both already logged via `warning` before it
            # returns) — a bare, unguarded call to a function that returns
            # non-zero is ITSELF a set -e trigger at the call site, so even
            # after fixing the function's own internals to fail gracefully,
            # this call would still have silently killed the whole worktree
            # lane (every remaining story in it) over one story's commit
            # being correctly skipped. The failure is already fully logged
            # inside the function; there is nothing more to do here.
            # THE GUARD STAYS, THE OUTCOME IS ACTED ON.
            #
            # `|| true` is correct: this script runs under `set -e`, and a bare failure here
            # would kill the whole lane over one story's commit. But the return code used to be
            # DISCARDED, and that is a different thing. Live 2026-08-09 the credential scan
            # unstaged a story's work, `git add` then failed, and the run reported
            # "Implemented: 1, Failed: 0" with 43 lines sitting uncommitted in the working
            # tree — every downstream reader told the story was delivered.
            local _commit_rc=0
            commit_completed_story "$story_id" || _commit_rc=$?
            log "  [post-story] Commit step complete for $story_id"
            if [ "$_commit_rc" -ne 0 ]; then
                error "  [post-story] $story_id: work is UNCOMMITTED (commit step exit ${_commit_rc}) — the story is not delivered; demoting from implemented"
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            elif ! _committed_change_uses_helpers "$story_id"; then
                # THE ARTIFACT IS JUDGED, NOT THE TREE IT CAME FROM.
                #
                # The write-time guard rejects an attempt while it is still running, against
                # the working tree. This asks the only question that survives the attempt:
                # does what SHIPPED use every helper the spec verified? On 2026-08-15 a story
                # committed 1 of 4 and was reported complete — tsc green, tests green, because
                # the tests assert the SDK was configured, never that content re-renders.
                error "  [post-story] $story_id: committed work is incomplete against the plan — demoting from implemented"
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            fi

            # Same post-story guards the main lane's Step 1 loop runs after a
            # successful story (run-agent-orchestration.sh) — parity per
            # "all lanes must have the same flow no deviations": TypeScript
            # compile gate, actualCost written back to prd.json (falls back
            # to phase-cost.jsonl since there's no per-story log file to grep
            # in-process — see record_story_actual_cost's docstring), and
            # mid-execution split validation before the NEXT story in this
            # lane runs.
            if ! story_tsc_gate "$story_id"; then
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            fi
            record_story_actual_cost "$story_id"
            validate_mid_execution_splits "$PHASE"
        else
            update_story_status "$story_id" "failed"
            failed=$((failed + 1))
        fi

        increment_iteration
    done

    log "======================================"
    log "EPAM CLI Orchestration Loop Complete"
    log "Implemented: $implemented, Failed: $failed, Skipped: $skipped"
    log "======================================"

    if [ $failed -gt 0 ]; then
        return 1
    fi
    return 0
}

# Print usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [STORY_IDS...]

EPAM CLI Orchestration script for implementing PRD stories.

Options:
  --status              Show current PRD status with phase information
  --list-phases         Show all implementation phases and their stories
  --phase NAME          Implement all incomplete stories in a specific phase
  --worktree NAME       Run in worktree mode (primary|independent)
  --setup-worktrees     Create git worktrees for parallel execution
  --cleanup-worktrees   Remove git worktrees
  --dry-run             Show what would be implemented without running
  --interactive         Run with permission prompts (safer, requires approval)
  --help                Show this help message

Arguments:
  STORY_IDS       Specific story IDs to implement (e.g., US-001 US-002)
                  If not provided, implements stories in priority order

Story Prioritization:
  Stories are implemented based on:
  1. Phase order (from implementationOrder in prd.json)
  2. Dependency satisfaction (blocked stories are skipped)
  3. Priority field (high > medium > low)

Environment Variables:
  CLAUDE_CMD      Path to Claude CLI (default: claude)

Permissions:
  By default, the script runs with --dangerously-bypass-approvals-and-sandbox to allow
  autonomous file read/write operations. Use --interactive if you want to
  manually approve each operation.

Examples:
  $(basename "$0")                      # Implement next stories (priority order)
  $(basename "$0") --phase phase1       # Implement phase1 stories only
  $(basename "$0") --list-phases        # Show all phases and progress
  $(basename "$0") US-001 US-002        # Implement specific stories
  $(basename "$0") --dry-run            # Preview implementation order
  $(basename "$0") --status             # Show PRD status
  $(basename "$0") --interactive        # Run with manual approval prompts

EOF
}
