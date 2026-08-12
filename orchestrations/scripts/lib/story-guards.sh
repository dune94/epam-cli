#!/usr/bin/env bash

# _run_project_verification <project_root>
# The project's declared check (.epam/verification.json) via the verification plugin. The engine
# names no tool, extension, directory or runtime path. Undeclared -> non-zero with a reason.
# The baseline-delta implementation lives in ONE place. Sourced here rather than re-implemented:
# this file used to carry its own copy, complete with a tsc error regex and a node_modules
# literal, and so did claude.sh and eslint-baseline-gate.sh — four copies, four independent
# fail-open paths on any repo whose checker speaks a different dialect.
_SG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$_SG_LIB_DIR/tsc-baseline-gate.sh" ] && . "$_SG_LIB_DIR/tsc-baseline-gate.sh"

_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _auto="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}"
    local _plugin="${_auto}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then echo "verification plugin missing at $_plugin"; return 2; fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}

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
    # No stack precondition. runVerification reports UNKNOWN for a project that has declared
    # no check, and every caller treats non-zero as failure — so an undeclared repo is
    # refused rather than skipped. Counting a language's files here meant "skip", which
    # callers read as PASS: the fail-open the verification plugin exists to remove, moved
    # from the invocation to the condition.
    # Skip tsc gate for test-only stories (they extend existing files, not create TS modules)
    local _role
    _role=$(jq -r --arg id "$_sid" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    [ "$_role" = "test-engineer" ] && return 0

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    local _tsc_log="$LOG_DIR/tsc-gate-${_sid}.log"

    set +e
    _run_project_verification "$PROJECT_ROOT" 2>&1 | tee "$_tsc_log"
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
        # ONE IMPLEMENTATION, in lib/tsc-baseline-gate.sh. This was a fourth copy of the same
        # baseline-delta logic, each carrying its own tsc error regex and its own `node_modules`
        # literal — so each one failed open independently on a repo whose checker speaks a
        # different dialect: the grep matches nothing, the baseline set is empty, there is
        # nothing to subtract, and the gate reports PASS having verified nothing.
        #
        # The output is passed in because it has already been captured; re-running the check
        # here would double the cost of the most expensive gate in the run.
        local _new_errors
        _new_errors="$(cat "$_tsc_log")"
        if command -v baseline_new_failures >/dev/null 2>&1; then
            local _delta_out _delta_rc=0
            _delta_out=$(baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                "$LOG_DIR" typecheck "$_tsc_log") || _delta_rc=$?
            [ "$_delta_rc" -eq 0 ] && _new_errors="" || _new_errors="$_delta_out"
        fi

        if [ -z "$(echo "$_new_errors" | tr -d '[:space:]')" ]; then
            success "  [tsc-gate] $_sid: the type check has only pre-existing baseline errors — none introduced by this story"
            record_brownfield_verified_baseline
            return 0
        fi

        error "  [tsc-gate] $_sid: TypeScript errors after story completed — story marked failed"
        error "  [tsc-gate] Fix required before next story runs. Log: ${_tsc_log##*/}"
        reset_brownfield_story_commit "$_sid"
        return 1
    fi
    success "  [tsc-gate] $_sid: the project's type check passed"
    record_brownfield_verified_baseline
    return 0
}

# record_brownfield_verified_baseline
#
# Durable (cross-run) half of the predictable-teardown mandate. Writes the
# current HEAD SHA to a marker OUTSIDE the codeline entirely — never inside
# $PROJECT_ROOT itself, so it can never be swept into a `git add -A` /
# committed, and modifying it is never a surprising change to the client's
# own repo (no .gitignore edits, no stray files in their tree). Keyed by an
# md5 of the absolute PROJECT_ROOT path so multiple codelines never collide.
#
# Survives a `git reset --hard` unconditionally (it isn't part of the git
# working tree at all) and persists across runs regardless of how the
# previous run ended (clean success, clean failure via
# reset_brownfield_story_commit, or a hard kill/crash mid-story).
#
# This is the run-START backstop's source of truth: a run that gets killed
# before story_tsc_gate ever runs leaves no updated marker, so the NEXT run's
# start-of-run check (see run-brownfield-preflight-reset.sh) knows to reset
# back to the last point a story was ACTUALLY verified complete — not just
# "the last commit whose message happened to say complete."
#
# Brownfield-only; a no-op elsewhere (the file simply never gets created).
record_brownfield_verified_baseline() {
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _sha=""
    # When a fixed baseline branch is configured (JIRA_BASELINE_BRANCH, e.g.
    # "develop"), the "verified baseline" is that BRANCH — never a story's own
    # fix commit sitting on top of it. Recording HEAD here (which becomes the fix
    # commit once a story completes) is exactly what made a re-run of the same
    # story reset to the PREVIOUS fix and build on top of it, so the detective saw
    # already-fixed code and the run was invalid (found live 2026-07-24,
    # AMSD-1820). Pin the marker to the baseline branch so it can never advance
    # onto a fix — repeat runs of the same story always start from the clean
    # original state.
    if [ -n "${JIRA_BASELINE_BRANCH:-}" ]; then
        _sha=$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${JIRA_BASELINE_BRANCH}" 2>/dev/null \
            || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${JIRA_BASELINE_BRANCH}" 2>/dev/null || echo "")
    fi
    [ -n "$_sha" ] || _sha=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null) || return 0
    local _state_dir="${EPAM_BROWNFIELD_STATE_DIR:-$HOME/.epam/brownfield-baselines}"
    mkdir -p "$_state_dir" 2>/dev/null || true
    local _key
    _key=$(printf '%s' "$PROJECT_ROOT" | md5sum 2>/dev/null | cut -d' ' -f1)
    [ -n "$_key" ] || return 0
    echo "$_sha" > "$_state_dir/${_key}.sha" 2>/dev/null || true
}

# reset_brownfield_story_commit <story_id>
#
# Standing mandate (6+ months, not new): the pipeline must be able to tear
# down to a predictable pre-run state every time — a run may be repeated
# 200+ times until it succeeds, and contamination from a failed attempt must
# never persist into the next one. Brownfield's own semantics for this
# (confirmed 2026-07-22, not the same as reset-to-baseline.sh's greenfield
# "last <id>: story complete commit" model): hard-reset the codeline to
# phase-baseline-sha.txt — the SHA captured once, at the very start of this
# run's phase, BEFORE any story in it touched anything (see
# run-agent-orchestration.sh Step 8's capture just before the main-story
# loop). Every commit made during this run is provisional until a story
# passes ALL of its gates; a story failing story_tsc_gate has NOT done so.
#
# Live bug this closes (AMSD-1820, 2026-07-22): commit_completed_story()
# commits BEFORE story_tsc_gate runs. When the gate then failed, the commit
# ("AMSD-1820: story complete (7 file(s))") was left sitting on develop
# permanently — nothing ever reverted it. It went on to actively poison
# later Semble semantic-search results (its prose matched the bug title
# better than the real fix file, outranking the actual code needing the fix)
# for every subsequent run, compounding the damage rather than staying inert.
#
# Brownfield-only (EPAM_BROWNFIELD=1) — greenfield worktree lanes have their
# own, different teardown model and are unaffected.
# No-op (not an error) when: not brownfield, no phase-baseline-sha.txt yet
# (can't reset to an unknown target), or the working tree isn't a git repo.
reset_brownfield_story_commit() {
    local _sid="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _baseline_file="${LOG_DIR:-}/phase-baseline-sha.txt"
    [ -f "$_baseline_file" ] || return 0
    local _baseline_sha
    _baseline_sha=$(tr -d '[:space:]' < "$_baseline_file")
    [ -n "$_baseline_sha" ] || return 0

    local _current_sha
    _current_sha=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")
    if [ "$_current_sha" = "$_baseline_sha" ]; then
        # Nothing was ever committed for this story (or it's already clean) —
        # no reset needed, and resetting to HEAD would be a harmless no-op
        # anyway, but skip it entirely to avoid an unnecessary git operation.
        return 0
    fi

    warning "  [teardown] $_sid: resetting $PROJECT_ROOT to pre-run baseline $_baseline_sha — discarding this story's failed commit(s)"
    git -C "$PROJECT_ROOT" reset --hard "$_baseline_sha" >/dev/null 2>&1 \
        && success "  [teardown] $_sid: reset complete — repo is back to the exact state before this run started"
}

# ── _text_violates_anti_pattern moved here 2026-08-02 ──────────────────────
# Moved from claude.sh so BOTH claude.sh (FailureAnalyst's skill-note path)
# and run-agent-orchestration.sh (review-rejection skill-note path, below)
# can call it — the same "shared, single source of truth" reasoning already
# applied to lib/git-ops.sh.
# _text_violates_anti_pattern <text>
# A SEPARATE, purpose-built pattern per rule — `textMatchPattern`, distinct
# from `matchPattern` — applied to an arbitrary piece of TEXT: specifically, a
# self-heal skill note about to be persisted into profiles.json for every
# future run to inherit. A rule with no `textMatchPattern` simply does not
# apply here (silently skipped) — most anti-pattern rules are code-shape-only
# and have no prose equivalent worth gating.
#
# Root cause this closes (found live, 2026-08-02, Writer Retest): FailureAnalyst
# diagnosed a TypeScript compile error from an SDK's installed .d.ts and wrote
# a skill note prescribing a config key from it. A type declaration can
# disagree with what the package's runtime actually reads, in either direction,
# and FailureAnalyst has no way to know that — nor does its reviewer-retry gate,
# an LLM judging another LLM's note, since the same blind spot applies to both.
# Vetting the note here stops a wrong belief being persisted into a profile for
# every future run to inherit.
#
# WHAT THIS MUST NOT BECOME, learned the hard way 2026-08-04: the original
# version of this vetting leaned on a hand-written anti-patterns.json rule
# asserting which SDK key was correct — a VENDOR API FACT written from memory
# after watching one ticket fail. Discovery against the INSTALLED package (the
# dependency_contract plugin) later showed the assertion was backwards: the
# "wrong" key is the one the runtime reads, and the "prescribed" one appears
# nowhere in the package. The rule would have refused correct guidance and
# forced writers toward a key that silently does nothing.
#
# So a rule vetted here must be one that could have been written BEFORE any
# failure was observed. What a third-party package consumes is DETERMINABLE —
# have the agent call dependency_contract; never transcribe the answer into a
# rule file. See test/unit/orchestration/no-hand-authored-vendor-rules.test.ts.
#
# `textMatchPattern` is DELIBERATELY separate from `matchPattern` (found live,
# 2026-08-02, same day: the two were briefly the same shared, loosened pattern
# — broadening it to catch prose in a skill note ALSO made
# run_anti_pattern_check(), which scans real CODE FILES with `matchPattern`,
# false-positive on a correct, review-approved comment explaining the exact
# same contrast in prose (a comment naming one SDK key "not" another).
# That false positive blocked a real test run and cascaded into a
# HealingBroken escalation — a genuine run regression traced back to sharing
# one pattern across two consumers with different strictness needs. Never
# reuse one regex across a code-scanner and a free-text scanner again — see
# [[feedback_regex_100_percent_coverage]].
#
# Prints the matched rule's message on stdout when it matches; prints nothing
# and returns 0 when clean (matches run_anti_pattern_check's "OK"/malformed
# config = never block" posture).
_text_violates_anti_pattern() {
    local _text="$1"
    local _rules_file="${EPAM_PROJECT_CONFIG_DIR:-}/anti-patterns.json"
    [ -f "$_rules_file" ] || return 0

    python3 - "$_rules_file" "$_text" << 'PYEOF'
import json, re, sys
rules_file, text = sys.argv[1], sys.argv[2]
try:
    with open(rules_file, encoding='utf-8') as f:
        rules = json.load(f)
except Exception:
    sys.exit(0)
for rule in rules:
    pattern = rule.get('textMatchPattern')
    if not pattern:
        continue
    try:
        if re.search(pattern, text):
            print(rule.get('message', rule.get('id', 'anti-pattern match')))
            sys.exit(1)
    except re.error:
        continue
sys.exit(0)
PYEOF
}


# _persist_skill_note_simple <profiles_file> <role> <raw_text>
# Lightweight skill-note persister for call sites that don't have access to
# claude.sh's full LLM-invocation infrastructure (run_change_with_reviewer_retry,
# which validates a note's WORDING via an LLM review pass before persisting) —
# specifically, run-agent-orchestration.sh's review-rejection path (Step 3.6,
# below). Applies the SAME deterministic anti-pattern gate and exact-duplicate
# guard claude.sh's own FailureAnalyst skill-note persister uses, then writes
# directly with no LLM wording-review sub-step — justified because the text
# here is already reviewer-vetted content (a real code review's own blocker
# description), unlike FailureAnalyst's raw, unvalidated model diagnosis text.
#
# Root cause this closes (found live, 2026-08-02): a story that repeatedly
# fails REVIEW for the same reason (e.g. AMSD-2041's live_preview never
# forwarded through public query functions) had NO mechanism to persist that
# lesson for the writer across runs — only FailureAnalyst's tsc/test-failure
# diagnoses fed the skill-note pipeline. The exact same defect could recur
# indefinitely across runs with nothing ever accumulating for the writer to
# learn from, unlike self-heal-diagnosed failures.
#
# Best-effort: never fails the caller (always returns 0), same posture as
# run_anti_pattern_check()/_text_violates_anti_pattern().
_persist_skill_note_simple() {
    local _profiles_file="$1"
    local _role="$2"
    local _raw_text="$3"
    [ -f "$_profiles_file" ] || return 0
    [ -n "$_raw_text" ] || return 0

    local _anti_pattern_msg
    _anti_pattern_msg=$(_text_violates_anti_pattern "$_raw_text")
    if [ -n "$_anti_pattern_msg" ]; then
        warning "  [skill-note] Refusing to persist for [${_role}] — contradicts a known anti-pattern: $_anti_pattern_msg"
        return 0
    fi

    local _current_role_profile
    _current_role_profile=$(jq -c --arg role "$_role" '.[$role] // ""' "$_profiles_file" 2>/dev/null)
    if echo "$_current_role_profile" | grep -qF -- "$_raw_text"; then
        log "  [skill-note] Exact duplicate already present in [${_role}] — not persisting again"
        return 0
    fi

    ( flock -w 10 200 || { error "  [skill-note] Could not acquire lock on $_profiles_file"; return 1; }
    python3 - "$_raw_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [skill-note] $line"; done
import json, sys, os
profiles_path = '$_profiles_file'
role = '$_role'
note = '[Self-Heal] ' + sys.argv[1]
with open(profiles_path) as f:
    profiles = json.load(f)
if role in profiles:
    existing = profiles[role]
    sep = '\n\n' if existing else ''
    profiles[role] = existing + sep + note
    _tmp_profiles_path = profiles_path + '.tmp'
    with open(_tmp_profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    os.replace(_tmp_profiles_path, profiles_path)
    print(f'Skill note appended to [{role}] profile — persisted for future runs')
else:
    print(f'Profile role [{role}] not found in profiles.json — skill note NOT persisted', file=sys.stderr)
PYEOF
    ) 200>"${_profiles_file}.lock"
    return 0
}


# _load_timeout_config
# Loads timeout-related fallback defaults from EPAM_PROJECT_CONFIG_DIR/
# llm-settings.json — same "only export if the env var isn't already set"
# posture as claude.sh's load_llm_settings_json(), and reads the SAME
# storyTimeoutSecs/gateTimeoutSecs keys that function already reads, plus
# three new ones (storyEffortTimeoutSecs, roleTimeoutMultipliers,
# watchdogRetryMultiplier — see llm-settings.schema.json).
#
# Root cause this closes (found live, 2026-08-02, gotransit/upexpress digging):
# run_story_with_watchdog() (run-agent-orchestration.sh) computes its timeout
# from a hardcoded case statement, completely disconnected from
# llm-settings.json — load_llm_settings_json() DOES export
# EPAM_STORY_TIMEOUT_SECS, but run_story_with_watchdog() reads the unprefixed
# STORY_TIMEOUT_SECS, so the two never connected (a naming mismatch, not a
# missing feature). Worse: load_llm_settings_json() only runs INSIDE
# claude.sh, which run_story_with_watchdog() itself invokes AS A SUBPROCESS —
# by the time claude.sh could export anything, the watchdog's `timeout`
# wrapper around that exact invocation has already been computed and applied.
# A child process's exported env vars never propagate back to its parent, so
# that channel could never have worked no matter what the var was named.
# The fix is loading config in run-agent-orchestration.sh itself, BEFORE the
# first call to run_story_with_watchdog() — this function, called once near
# the top of that script, right after EPAM_PROJECT_CONFIG_DIR is available.
#
# Deliberately does NOT special-case gotransit's specific hung-API-call
# failure (0 tokens, $0 cost, 11+ min, recurring 6 times) — that failure mode
# is a dead/stuck connection, not "needs more time to finish work", and
# raising its timeout would only make a hung run take longer to fail the same
# way. This function makes the timeout MECHANISM configurable; it does not
# and should not paper over a specific hang.
#
# Best-effort: malformed/absent config is silently skipped, same posture as
# every other loader in this file.
_load_timeout_config() {
    local _settings_file="${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json"
    [ -f "$_settings_file" ] || return 0

    # `|| true` is load-bearing (found live, 2026-08-02): this runs under
    # `set -e` (run-agent-orchestration.sh:12) — a malformed llm-settings.json
    # makes jq exit non-zero on the PARSE error itself (`// empty` only
    # covers a valid-but-absent VALUE, not a parse failure), and every call
    # site is `_v=$(_lt_get ...)`, a bare simple command whose failing exit
    # status would otherwise kill the whole orchestration script — see the
    # identical fix and rationale in claude.sh's load_llm_settings_json().
    _lt_get() { jq -r "$1 // empty" "$_settings_file" 2>/dev/null || true; }
    local _v

    _v=$(_lt_get '.timeouts.storyTimeoutSecs'); [ -z "${EPAM_STORY_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_SECS="$_v"
    _v=$(_lt_get '.timeouts.gateTimeoutSecs'); [ -z "${EPAM_GATE_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_GATE_TIMEOUT_SECS="$_v"

    # Loaded HERE, in the parent, because the watchdog that consumes them runs in this process
    # — claude.sh's own loader is a subprocess and too late by construction (the reason this
    # function exists at all). secondsPerIteration x the attempt's iteration budget derives a
    # wall that can actually accommodate the work; storyTimeoutMaxSecs caps it.
    _v=$(_lt_get '.timeouts.secondsPerIteration'); [ -z "${EPAM_SECONDS_PER_ITERATION:-}" ] && [ -n "$_v" ] && export EPAM_SECONDS_PER_ITERATION="$_v"
    _v=$(_lt_get '.timeouts.storyTimeoutMaxSecs'); [ -z "${EPAM_STORY_TIMEOUT_MAX_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_MAX_SECS="$_v"
    # TWO SCOPES, TWO WALLS. The knobs above bound ONE ATTEMPT. A story runs up to
    # maxRetries+1 attempts inside a single watchdog window, and each attempt also pays
    # planning, gates, verification and the analyst — none of which are iterations. Measured
    # 2026-08-12: two attempts consumed 1780s of an 1800s wall that also claimed to bound eight.
    _v=$(_lt_get '.timeouts.perAttemptOverheadSecs'); [ -z "${EPAM_PER_ATTEMPT_OVERHEAD_SECS:-}" ] && [ -n "$_v" ] && export EPAM_PER_ATTEMPT_OVERHEAD_SECS="$_v"
    _v=$(_lt_get '.timeouts.storyWallMaxSecs'); [ -z "${EPAM_STORY_WALL_MAX_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_WALL_MAX_SECS="$_v"

    _v=$(_lt_get '.timeouts.storyEffortTimeoutSecs.low'); [ -z "${EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS="$_v"
    _v=$(_lt_get '.timeouts.storyEffortTimeoutSecs.medium'); [ -z "${EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS="$_v"
    _v=$(_lt_get '.timeouts.storyEffortTimeoutSecs.high'); [ -z "${EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS="$_v"
    _v=$(_lt_get '.timeouts.storyEffortTimeoutSecs.default'); [ -z "${EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS="$_v"

    # roleTimeoutMultipliers is an arbitrary-keys object (unlike the fixed
    # low/medium/high/default tiers above) — serialize it the same way
    # load_llm_settings_json() serializes modelLadder[], into the
    # "role=mult|role2=mult2" string resolve_role_timeout_multiplier() already
    # parses via EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP.
    _v=$(_lt_get '(.timeouts.roleTimeoutMultipliers // {}) | to_entries | map("\(.key)=\(.value)") | join("|")')
    [ -z "${EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP:-}" ] && [ -n "$_v" ] && export EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP="$_v"

    _v=$(_lt_get '.timeouts.watchdogRetryMultiplier'); [ -z "${EPAM_WATCHDOG_RETRY_MULTIPLIER:-}" ] && [ -n "$_v" ] && export EPAM_WATCHDOG_RETRY_MULTIPLIER="$_v"

    unset -f _lt_get
    return 0
}

# spec_review_gate <prd-file>
#
# A REVIEW THAT CANNOT STOP ANYTHING IS NOT A GATE.
#
# Live 2026-08-04 (run 20260804T035435Z): the coordinator reviewed all three lanes, used
# list_files to check each manifest against the repository, and returned needs_review on
# every one — qualityScore 0.45 on the worst. Two of those lanes had a manifest naming a
# file that does not exist, the condition that sent a writer into a 120-iteration,
# ~2M-token loop. The verdict was written to story.specification.coordinatorReview,
# and then ignored: the only verdict the code branched on was 'fail', which the review
# schema (approved|needs_review) never emits. The reviewer knew, on every lane, and had
# no word that stopped anything.
#
# Enforced here, deterministically, from the PRD the spec pass wrote — at the pre-writer
# boundary, before a single token is spent on implementation.
#
# CONFIGURABLE, never hardcoded:
#   SPEC_REVIEW_ENFORCE=0        turn the gate off deliberately (default: on)
#   SPEC_REVIEW_MIN_QUALITY=0.7  the bar a score must clear (default: 0.7)
#
# Deliberately NOT blocking: a story with no coordinatorReview at all. A resumed run skips the
# spec pass, so an absent review is expected and must not halt it. Absent is not zero —
# a null qualityScore does not block either, or a reviewer that omitted the field would
# fail every story.
spec_review_gate() {
    local _prd="${1:-${PRD_FILE:-}}"
    if [ "${SPEC_REVIEW_ENFORCE:-1}" = "0" ]; then
        return 0
    fi
    if [ -z "$_prd" ] || [ ! -f "$_prd" ]; then
        warning "[spec-review-gate] no PRD to check (${_prd:-unset}) — cannot verify the spec review"
        return 1
    fi
    if ! jq -e . "$_prd" >/dev/null 2>&1; then
        error "[spec-review-gate] PRD is not valid JSON — refusing to pass a gate it cannot read"
        return 1
    fi

    # qualityScore IS TELEMETRY. It never gates. (Operator decision, 2026-08-07.)
    #
    # It is a bare number the reviewer invents: nothing constrains how it is derived and
    # nothing can check it. Unlike a flag, a verdict or a missing manifest path, "0.68" is not
    # a claim about anything, so it can be neither structurally constrained nor independently
    # re-checked — which is how every other model assertion in this pipeline is now handled.
    #
    # It was the DEFAULT blocker at 0.7 while the specific, enumerable signal defaulted to
    # empty, so the only thing that could stop a run was the one thing nobody could
    # interrogate. Live 2026-08-07: a lane halted at 0.68 — a 0.02 margin — while two lanes
    # cleared, and nothing in the artefacts can say whether that spec was materially worse or
    # simply drew a lower number. The comments above record the same instability from earlier
    # runs: lanes stopped at 0.78 and 0.72, and elsewhere every lane sailing through at 0.45.
    #
    # Reported every time so a degrading reviewer is visible; never enforced.

    local _blocking_flags="${SPEC_REVIEW_BLOCKING_FLAGS-}"
    local _blockers _advisories _manifest_blockers
    # THE PATH IS THE PRODUCER'S, NOT AN INVENTED ONE. This gate originally queried
    # `.specReview` — a field nothing in the pipeline has ever written. spec-mode-runner.js
    # persists the coordinator's verdict to `.specification.coordinatorReview`, so the gate
    # read null on every story and passed everything. Live run 20260804T130402Z: all three
    # lanes returned needs_review at qualityScore 0.45 and every one sailed through.
    # gate-reads-what-the-producer-writes.test.ts now derives this path from the producer's
    # own assignment, so the two cannot drift apart again.
    local _jq_common='
        ($bf | ascii_downcase | split(",") | map(gsub("^[[:space:]]+|[[:space:]]+$";""))
             | map(select(length > 0))) as $blocking
        | [ .stories[]?
            | select(.status != "deprecated")
            | . as $s
            | (.specification.coordinatorReview) as $r
            | select($r != null)
            # Flags may be bare strings (legacy: always advisory) or objects carrying severity.
            | (($r.flags // [])
                | map(if type == "string" then {flag: ascii_downcase, severity: "advisory"}
                      elif type == "object" then {flag: ((.flag // "") | ascii_downcase),
                                                  severity: ((.severity // "advisory") | ascii_downcase)}
                      else empty end)
                | map(select(.flag != ""))) as $fo
            | ($fo | map(.flag)) as $f
            # A REVIEW THAT OBJECTS MUST SAY WHAT IT OBJECTS TO.
            #
            # Blocking requires a needs_review verdict AND at least one flag. Enumerable and
            # specific: it satisfies "a review must be able to stop things" without resting on
            # a scalar, and a reviewer returning needs_review with no flags — exactly what
            # halted a lane on 2026-08-07 — no longer blocks, because it named nothing anyone
            # can act on. Blocking on the verdict alone was tried and abandoned: it stopped
            # three lanes whose flags were advisory nits.
            #
            # With no SPEC_REVIEW_BLOCKING_FLAGS declared, ANY flag counts. A project narrows
            # it by declaring the ones it cares about; it is never silently inert.
            # BLOCKING REQUIRES CORROBORATION OR A HUMAN DECISION — never self-assessment.
            #
            # The reviewer own severity does NOT grant blocking. It is the same class of
            # signal as qualityScore: something the model asserts about its own output, which
            # nothing can check. This reviewer hallucinates a missing-manifest-path flag in 1 of
            # 4 samples; letting it mark that flag blocking would halt valid runs on that word
            # alone, which is the failure the computed manifest check exists to prevent.
            #
            # What blocks: a flag the PROJECT declared blocking (a human decided it matters),
            # and the deterministic computed checks below. Severity is carried through as
            # advisory metadata so a human reading the report can rank what to look at first.
            | [ $fo[] | select(.flag as $x | $blocking | index($x)) | .flag ] as $hit
            | ((($r.verdict // "approved") != "approved") and (($hit | length) > 0)) as $blocked
            | {s: $s, r: $r, hit: $hit, fo: $fo, lowq: $blocked}   # lowq is the BLOCKED flag now
          ]'

    _blockers=$(jq -r --arg bf "$_blocking_flags" "
        $_jq_common
        | .[] | select(.lowq)
        | \"\(.s.id)\tverdict=\(.r.verdict // \"?\")\tquality=\(.r.qualityScore // \"n/a\")\treason=\(if (.hit | length) > 0 then \"blocking flag: \" + (.hit | join(\",\")) else \"needs_review with blocking flag(s): \" + (.hit | join(\",\")) end)\"
        " "$_prd" 2>/dev/null)

    # A needs_review that does NOT block is still the reviewer telling us something. It is
    # reported every time — an advisory nobody sees is a silent failure.
    _advisories=$(jq -r --arg bf "$_blocking_flags" "
        $_jq_common
        | .[] | select(.lowq | not)
        | select((.r.verdict // \"approved\") != \"approved\")
        | \"\(.s.id)\tverdict=\(.r.verdict)\tquality=\(.r.qualityScore // \"n/a\")\tflags=\(.fo | map(.flag + \"[\" + .severity + \"]\") | join(\",\"))\"
        " "$_prd" 2>/dev/null)

    # The score, always reported, never enforced.
    _low_quality=$(jq -r '
        [ .stories[]? | select(.status != "deprecated")
          | . as $s | (.specification.coordinatorReview) as $r
          | select($r != null and $r.qualityScore != null and $r.qualityScore < 0.7)
          | "\($s.id)\tquality=\($r.qualityScore)" ] | .[]' "$_prd" 2>/dev/null)
    if [ -n "$_low_quality" ]; then
        warning "[spec-review-gate] low reviewer qualityScore (telemetry — never blocks):"
        printf '%s\n' "$_low_quality" | while IFS= read -r _q; do
            [ -n "$_q" ] && warning "[spec-review-gate]   $_q"
        done
        warning "[spec-review-gate] What blocks: a needs_review verdict carrying at least one flag, and missing manifest paths."
    fi

    if [ -n "$_advisories" ]; then
        warning "[spec-review-gate] the reviewer flagged these for human attention (advisory — not blocking):"
        printf '%s\n' "$_advisories" | while IFS= read -r _a; do
            [ -n "$_a" ] && warning "[spec-review-gate]   $_a"
        done
        warning "[spec-review-gate] None carries a flag the reviewer marked blocking (or the project narrowed the set), so none halts the run."
        warning "[spec-review-gate] Blocking flags: ${_blocking_flags:-(none)} — set SPEC_REVIEW_BLOCKING_FLAGS to change."
    fi

    # The computed missing-path list — the one manifest fact worth halting for. Absent
    # manifestCheck does not block: a resumed run skips the spec pass, and absent is not
    # zero (same rule the quality score already follows).
    _manifest_blockers=$(jq -r '
        .stories[]?
        | select(.status != "deprecated")
        | . as $s
        | (.specification.manifestCheck.missing // []) as $m
        | select(($m | length) > 0)
        | $m[]
        | "\($s.id)\tMISSING declared path: \(.file // .)"
        ' "$_prd" 2>/dev/null)

    if [ -n "$_manifest_blockers" ]; then
        error "[spec-review-gate] the manifest names files that are NOT in the repository:"
        printf '%s\n' "$_manifest_blockers" | while IFS= read -r _m; do
            [ -n "$_m" ] && error "[spec-review-gate]   $_m"
        done
        error "[spec-review-gate] A writer sent to edit a file that is not there cannot succeed,"
        error "[spec-review-gate] and every retry reproduces it. Fix the manifest before implementing."
        return 1
    fi

    if [ -z "$_blockers" ]; then
        return 0
    fi

    error "[spec-review-gate] the specification review did not clear these stories:"
    printf '%s\n' "$_blockers" | while IFS= read -r _b; do
        [ -n "$_b" ] && error "[spec-review-gate]   $_b"
    done
    error "[spec-review-gate] The reviewer examined the repository and was not satisfied."
    error "[spec-review-gate] Implementing anyway spends the writer's budget on a spec the"
    error "[spec-review-gate] reviewer already flagged. Fix the spec, or set"
    error "[spec-review-gate] SPEC_REVIEW_ENFORCE=0 to proceed deliberately."
    return 1
}

# ── Brownfield story selection: two questions, two names ────────────────────
#
# These were ONE jq snippet, copy-pasted into two loops that ask different
# questions. fe5d6cb (2026-07-29) narrowed it with `storyKind != "novel"` to fix
# the GATE — correctly, a novel story has no bug to reproduce — and the same
# filter landed on the test WRITER, which never needed it. Step 10's TC writer is
# skipped for all brownfield, so the writer at Step 3.54 is the ONLY step that
# authors a test in this path; excluding novel left those stories with no test
# author at all, while team-lead-review.sh still enforces test coverage. Live run
# 20260804T202338Z deadlocked all three lanes on exactly that.
#
# Two names so a future copy-paste cannot silently re-conflate them.

# Every story in this phase. Who gets a test written for them (Step 3.54), and
# whose VC coverage is reported (Step 3.55). Test authoring is not conditional on
# there having been a bug: the writer works from the committed fix diff and the
# story's verificationCriteria.
phase_stories_brownfield_scope() {
    local _prd="${1:-${PRD_FILE:-}}" _phase="${2:-${PHASE:-}}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    jq -r --arg phase "$_phase" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[]? | select(.id != null)
                     | select(.id as $id | $ids | index($id) != null)
                     | .id' "$_prd" 2>/dev/null || true
    return 0
}

# Strictly narrower, and narrower ON PURPOSE: only stories that have a bug to
# reproduce. The repro gate proves RED→GREEN against a pre-fix baseline, which a
# story with no prior bug can never satisfy — it was blocking AMSD-2041 on an
# unsatisfiable bar. An UNCLASSIFIED story is still gated: absent classification
# defaults to the safe side.
# phase_stories_for_tc_writer — the EXACT COMPLEMENT of the repro gate.
#
# The bug-reproduction gate excludes storyKind "novel", and rightly: a new capability has no
# prior bug to reproduce, so RED→GREEN against a pre-fix baseline is unsatisfiable. Step 10
# then skipped the TC writer for ALL brownfield work, on the stated grounds that the
# reproduction gate covers it.
#
# For a novel brownfield story neither is true. Live 2026-08-07 (AMSD-2041, storyKind novel):
# Step 10 skipped, Step 3.55 "passed for all phase stories" because it had none to check, and
# NO step in the pipeline was responsible for tests. The team-lead reviewer asked for them as
# an opinion on seven review cycles across two runs; the writer, under a minimal-fix
# instruction, never wrote any; the reviewer never approved; the phase halted every time.
# Two mechanisms handing off to each other, and novel work falling between them.
#
# So: defects are proven by reproduction, novel work is proven by test criteria, and this
# selector is the other half of that split.
phase_stories_for_tc_writer() {
    local _prd="${1:-${PRD_FILE:-}}" _phase="${2:-${PHASE:-}}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    jq -r --arg phase "$_phase" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[]? | select(.id != null)
                     | select(.id as $id | $ids | index($id) != null)
                     | select((.storyKind // "") == "novel")
                     | .id' "$_prd" 2>/dev/null || true
    return 0
}

phase_stories_for_repro_gate() {
    local _prd="${1:-${PRD_FILE:-}}" _phase="${2:-${PHASE:-}}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    jq -r --arg phase "$_phase" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[]? | select(.id != null)
                     | select(.id as $id | $ids | index($id) != null)
                     | select((.storyKind // "") != "novel")
                     | .id' "$_prd" 2>/dev/null || true
    return 0
}

# assert_phase_stories_have_roles — refuse to run a phase whose stories have no agent.
#
# agentRole is deliberately null between synthesis and assignment: at synthesis nothing has
# analysed the codeline, so there is no roster to choose from, and synthesize-prd-from-jira.js
# no longer invents one (it used to hardcode a single role, which is how every client ticket
# ended up on an agent briefed on THIS repo's CLI). assignAgentRoles() fills it after the
# project's roles are minted.
#
# Past that point a null is a defect, and it is a SILENT one: fifteen consumers read the field
# as `.agentRole // "unknown"`, so an unassigned story is handed to the writer with an empty
# system prompt and the run completes with nobody the wiser. "unknown" is rejected for the same
# reason — it is the substituted value, never a role anyone assigned.
#
# One guard here rather than fifteen patched call sites.
assert_phase_stories_have_roles() {
    local _prd="${1:-${PRD_FILE:-}}" _phase="${2:-${PHASE:-}}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    local _bad
    _bad=$(jq -r --arg phase "$_phase" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[]? | select(.id != null)
                     | select(.id as $id | $ids | index($id) != null)
                     | select((.agentRole // "") == "" or (.agentRole // "") == "unknown")
                     | .id' "$_prd" 2>/dev/null || true)
    [ -z "$_bad" ] && return 0
    printf '[story-guards] no agent role assigned for: %s\n' "$(printf '%s' "$_bad" | tr '\n' ' ')" >&2
    printf '[story-guards] a story with no role runs with an empty system prompt and is read as "unknown" by every consumer downstream. Refusing to run the phase.\n' >&2
    return 1
}
