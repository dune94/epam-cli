#!/usr/bin/env bash
# Shared per-story orchestration guards — single source of truth, sourced by
# BOTH run-agent-orchestration.sh (main lane, Step 1) and claude.sh
# (run_implementation(), worktree Step 3a/3b lanes).
#
# Root cause this fixes (found live, 2026-07-14, tier3-travel-app run): these
# guards used to be defined ONLY in run-agent-orchestration.sh and called
# ONLY from its Step 1 main-branch loop. Worktree lanes never pass through
# that loop at all — they run inside claude.sh's own run_implementation()
# loop, launched as a background subprocess (Step 2/3a/3b), so a worktree-
# lane story got none of: the cost-budget circuit breaker, pause/resume,
# operator redirects, the post-story TypeScript compile gate, per-story
# actualCost written back to prd.json, or mid-execution split validation.
# Per explicit instruction ("all lanes must have the same flow no
# deviations" / "ensure lanes gave no other differences in processing"),
# every lane now calls the exact same implementation of each guard.
#
# Requires from the caller's environment: PRD_FILE, LOG_DIR, SCRIPT_DIR,
# PROJECT_ROOT, PHASE (set as a plain global, not `local`, before calling —
# these guards read $PHASE directly, matching run-agent-orchestration.sh's
# own existing convention), ORCH_RUN_ID, and the log/warning/success/error
# helpers — all already defined identically in both sourcing scripts.

# Check actual phase spend against prd.json budget.
# If exceeded, writes a JSON PAUSED sentinel so wait_if_paused() blocks and
# the dashboard can display the reason. Operator resumes via dashboard Resume button.
# Bypass: SKIP_COST_GUARD=true
check_cost_budget() {
    [ "${SKIP_COST_GUARD:-false}" = "true" ] && return
    local cost_file="$LOG_DIR/phase-cost.jsonl"
    [ -f "$cost_file" ] || return 0
    local budget
    budget=$(jq -r '.budget // empty' "$PRD_FILE" 2>/dev/null || true)
    [ -z "$budget" ] || [ "$budget" = "null" ] && return
    local actual
    local _cost_py='
import sys, json
cost_file, phase = sys.argv[1], sys.argv[2]
total = 0.0
with open(cost_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            if rec.get("phase_id") == phase or rec.get("phase") == phase:
                total += float(rec.get("actual_cost_usd", rec.get("cost_usd", 0)) or 0)
        except Exception:
            pass
print(f"{total:.4f}")
'
    actual=$(echo "$_cost_py" | python3 - "$cost_file" "$PHASE" 2>/dev/null || echo "0")
    if python3 -c "import sys; sys.exit(0 if float('${actual}') >= float('${budget}') else 1)" 2>/dev/null; then
        warning "Cost circuit breaker: actual=\$${actual} >= budget=\$${budget} for phase '$PHASE'"
        warning "Orchestration paused — resume from dashboard after reviewing spend"
        printf '%s' "$(jq -n \
            --arg reason "budget_exceeded" \
            --arg phase "$PHASE" \
            --argjson actual "$actual" \
            --argjson budget "$budget" \
            '{reason:$reason, phase:$phase, actualCost:$actual, budget:$budget, pausedAt:(now|todate)}'
        )" > "$LOG_DIR/PAUSED"
    fi
}

# Block until the PAUSED sentinel is removed (operator resumes via dashboard).
# Checks every 5 seconds; logs a reminder every 60 seconds.
wait_if_paused() {
    if [ ! -f "$LOG_DIR/PAUSED" ]; then
        return
    fi
    local _waited=0
    local _max="${EPAM_MAX_PAUSE_SECS:-300}"
    warning "Orchestration PAUSED — waiting for resume signal (auto-resume in ${_max}s)..."
    warning "  Resume: POST http://localhost:${CONTROL_PLANE_PORT}/resume"
    warning "  Abort:  DELETE $LOG_DIR/PAUSED then kill the orchestration process"
    while [ -f "$LOG_DIR/PAUSED" ]; do
        sleep 5
        _waited=$(( _waited + 5 ))
        if (( _waited % 60 == 0 )); then
            warning "Still paused (${_waited}s / ${_max}s max). POST http://localhost:${CONTROL_PLANE_PORT}/resume to continue."
        fi
        # Hard ceiling — auto-resume after EPAM_MAX_PAUSE_SECS to prevent indefinite hangs
        if [ "$_waited" -ge "$_max" ]; then
            warning "Auto-resuming after ${_max}s pause ceiling — continuing past paused story."
            rm -f "$LOG_DIR/PAUSED" 2>/dev/null || true
            break
        fi
    done
    success "Orchestration RESUMED after ${_waited}s pause."
}

# Usage: apply_redirect_if_any <story_id>
# Operator-initiated live re-route of a story to a different agentRole,
# signalled by dropping a redirect-<story_id>.json file in LOG_DIR.
apply_redirect_if_any() {
    local story_id="$1"
    local redirect_file="$LOG_DIR/redirect-${story_id}.json"
    if [ -f "$redirect_file" ]; then
        local target_agent
        target_agent=$(jq -r '.targetAgent // empty' "$redirect_file" 2>/dev/null || true)
        if [ -n "$target_agent" ]; then
            warning "REDIRECT: story $story_id → $target_agent (operator override)"
            rm -f "$redirect_file"
            # Update prd.json agentRole for this story
            local _tmp
            _tmp="${PRD_FILE}.redirect.$$"
            jq --arg id "$story_id" --arg role "$target_agent" \
                '(.stories[] | select(.id == $id)).agentRole = $role' \
                "$PRD_FILE" > "$_tmp" && mv "$_tmp" "$PRD_FILE"
            info "prd.json updated: $story_id.agentRole = $target_agent"
        fi
    fi
}

# Speckit must review ALL splits, not only those proposed by openspec during
# the spec pass (Step 0). The pre-phase assessment agent (Step 0.5) may write
# new stories directly to the PRD, and (for worktree lanes) an agent can
# register a mid-execution split while its own worktree story is running.
# Validate those before the NEXT story in this lane executes.
validate_mid_execution_splits() {
    local _phase_id="$1"
    local _spec_runner="$SCRIPT_DIR/spec-mode-runner.js"
    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"

    if [ ! -f "$_spec_runner" ] || ! command -v "$_node_cmd" >/dev/null 2>&1; then
        return 0
    fi

    # Find stories in implementationOrder for this phase that have createdFrom set
    # but have NOT been speckit-validated (i.e., mid-execution splits)
    local _new_split_ids
    _new_split_ids=$(jq -r \
        --arg phase "$_phase_id" \
        '(.implementationOrder[$phase] // []) as $order |
         .stories[] |
         select(
           (.id as $id | $order | index($id) != null) and
           (.specification.createdFrom != null) and
           (.specification.speckitValidated != true) and
           (.specification.splitRejected != true)
         ) | .id' \
        "$PRD_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//')

    if [ -z "$_new_split_ids" ]; then
        log "  [split-gate] No unvalidated mid-execution splits for phase '$_phase_id'"
        return 0
    fi

    log "  [split-gate] Running speckit on mid-execution splits: $_new_split_ids"
    set +e
    PRD_FILE="$PRD_FILE" OUTPUT_DIR="$LOG_DIR" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" \
        EPAM_ORCHESTRATION_PROVIDER="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}" \
        SPEC_MODE_PROVIDER="${SPEC_MODE_PROVIDER:-}" \
        SPEC_MODE_SPECKIT_MODEL="${SPEC_MODE_SPECKIT_MODEL:-}" \
        PHASE="$_phase_id" ORCH_RUN_ID="$ORCH_RUN_ID" \
        "$_node_cmd" "$_spec_runner" --validate-splits "$PRD_FILE" "$_new_split_ids" \
        2>&1 | tee "$LOG_DIR/split-validate-${_phase_id}.log"
    local _sv_exit=${PIPESTATUS[0]}
    set -e
    if [ "$_sv_exit" -ne 0 ]; then
        warning "  [split-gate] Split validation found hard violations — check $LOG_DIR/split-validate-${_phase_id}.log"
    else
        success "  [split-gate] Mid-execution splits validated for phase '$_phase_id'"
    fi
}

# record_story_actual_cost <story_id> [log_file]
# Extracts cost_usd from the story's JSONL log output and writes it back to
# prd.json as .actualCost so estimates-vs-actuals can be compared per story.
#
# log_file is OPTIONAL (2026-07-14): worktree-lane stories run implement_story
# in-process inside claude.sh's own loop, not via a `timeout ... | tee
# per-story.log` subprocess wrapper the way main-lane stories do via
# run_story_with_watchdog — there is no per-story log file to grep. When
# log_file is omitted or doesn't exist, this falls straight to the
# phase-cost.jsonl aggregation (claude.sh's own cost-tracking append,
# append_task_cost_record()-equivalent, already writes task_cost_usd there
# for EVERY story regardless of lane) instead of returning early.
record_story_actual_cost() {
    local story_id="$1"
    local log_file="${2:-}"
    local actual_cost=""
    if [ -n "$log_file" ] && [ -f "$log_file" ]; then
        # Extract cost from JSONL lines: epam run --json emits lines with cost_usd field
        actual_cost=$(grep -o '"cost_usd":[0-9.]*\|"total_cost_usd":[0-9.]*' "$log_file" 2>/dev/null \
            | tail -1 | grep -o '[0-9.]*$' || echo "")
    fi
    # Fallback: sum all task_cost_usd records for this story from phase-cost.jsonl
    if [ -z "$actual_cost" ] || [ "$actual_cost" = "0" ]; then
        local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
        if [ -f "$cost_file" ]; then
            actual_cost=$(jq -rs --arg sid "$story_id" \
                '[.[] | select(.story_id == $sid) | .task_cost_usd // 0] | add // 0' \
                "$cost_file" 2>/dev/null || echo "")
        fi
    fi
    [ -z "$actual_cost" ] && return 0
    [ "$actual_cost" = "0" ] && return 0
    # Write actualCost back to prd.json for this story
    local prd="${MAIN_PRD_FILE:-$PRD_FILE}"
    if [ -f "$prd" ]; then
        local tmp
        tmp=$(mktemp)
        # mktemp defaults to mode 0600; mv preserves that onto the final PRD
        # file, breaking anything not running as this user (e.g. the monitor
        # dashboard's nginx worker).
        chmod 644 "$tmp" 2>/dev/null
        jq --arg sid "$story_id" --argjson cost "$actual_cost" \
            '(.stories[] | select(.id == $sid)) |= (.actualCost = $cost)' \
            "$prd" > "$tmp" && mv "$tmp" "$prd" || rm -f "$tmp"
    fi
}

# Per-story TypeScript compile gate — runs tsc --noEmit after each story
# succeeds. Catches TS errors at the responsible story rather than at phase
# level. Bypassed when: tsconfig.json not yet present, SKIP_STORY_TSC_GATE=1,
# or test-only stories.
story_tsc_gate() {
    local _sid="$1"
    [ "${SKIP_STORY_TSC_GATE:-0}" = "1" ] && return 0
    [ ! -f "$PROJECT_ROOT/tsconfig.json" ] && return 0
    # Skip when no .ts source files exist yet (scaffold phase creates structure but no source)
    local _ts_count
    _ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l)
    [ "$_ts_count" -eq 0 ] && return 0
    # Skip tsc gate for test-only stories (they extend existing files, not create TS modules)
    local _role
    _role=$(jq -r --arg id "$_sid" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    [ "$_role" = "test-engineer" ] && return 0

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    local _tsc_log="$LOG_DIR/tsc-gate-${_sid}.log"

    set +e
    cd "$PROJECT_ROOT" && "$_node_cmd" ./node_modules/.bin/tsc --noEmit 2>&1 | tee "$_tsc_log"
    local _tsc_exit=${PIPESTATUS[0]}
    set -e

    if [ "$_tsc_exit" -ne 0 ]; then
        # Brownfield: this is the SAME whole-project-scope bug fixed in
        # claude.sh's run_tsc_verification() (live, AMSD-1820, 2026-07-22) —
        # a large brownfield repo can have pre-existing tsc errors in files no
        # story ever touches. Without the baseline diff, this OUTER gate
        # flipped a genuinely-completed story back to failed on the exact same
        # pre-existing Redis/Stripe/OTel/jwt errors, AFTER run_tsc_verification
        # had already correctly passed it inside the retry loop — the run
        # showed "Story AMSD-1820 marked as completed" immediately followed by
        # "Story AMSD-1820 marked as failed" a few lines later. Same fix:
        # diff against JIRA_BASELINE_BRANCH via a git worktree (symlinking
        # node_modules in, since worktree checkouts don't include gitignored
        # dirs), only failing on errors the story's own commit introduced.
        local _new_errors
        _new_errors="$(cat "$_tsc_log")"
        local _baseline_sha_file="$LOG_DIR/phase-baseline-sha.txt"
        if [ -f "$_baseline_sha_file" ]; then
            local _baseline_sha
            _baseline_sha=$(tr -d '[:space:]' < "$_baseline_sha_file")
            if [ -n "$_baseline_sha" ]; then
                local _baseline_cache="$LOG_DIR/tsc-baseline-errors-${_baseline_sha:0:12}.txt"
                if [ ! -f "$_baseline_cache" ]; then
                    local _wt_dir
                    _wt_dir=$(mktemp -d)
                    if git -C "$PROJECT_ROOT" worktree add --detach "$_wt_dir" "$_baseline_sha" >/dev/null 2>&1; then
                        ln -s "$PROJECT_ROOT/node_modules" "$_wt_dir/node_modules" 2>/dev/null || true
                        ( cd "$_wt_dir" && "$_node_cmd" ./node_modules/.bin/tsc --noEmit 2>&1 \
                            | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+' ) > "$_baseline_cache" 2>/dev/null || true
                        git -C "$PROJECT_ROOT" worktree remove --force "$_wt_dir" >/dev/null 2>&1 || true
                    fi
                    rm -rf "$_wt_dir" 2>/dev/null || true
                fi
                if [ -f "$_baseline_cache" ]; then
                    _new_errors=$(grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+.*$' "$_tsc_log" \
                        | grep -vFf "$_baseline_cache" || true)
                fi
            fi
        fi

        if [ -z "$(echo "$_new_errors" | tr -d '[:space:]')" ]; then
            success "  [tsc-gate] $_sid: tsc --noEmit has only pre-existing baseline errors — none introduced by this story"
            return 0
        fi

        error "  [tsc-gate] $_sid: TypeScript errors after story completed — story marked failed"
        error "  [tsc-gate] Fix required before next story runs. Log: ${_tsc_log##*/}"
        return 1
    fi
    success "  [tsc-gate] $_sid: tsc --noEmit passed"
    return 0
}
