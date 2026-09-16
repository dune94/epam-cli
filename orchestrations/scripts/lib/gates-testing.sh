#!/usr/bin/env bash
# gates-testing.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (8 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# _emit_agent <start|complete|fail> <role> [message]
# Thin wrapper so QA/system agents appear in agent-activity.jsonl.
# story_id is intentionally left empty (these are pipeline-level agents, not
# bound to a specific story) so the agent badge and story badge don't repeat.
_emit_agent() {
    local _action="$1" _role="$2" _msg="${3:-}"
    # THE MODEL THE AGENT ACTUALLY RUNS ON, which is its seam's — not a run-wide pin and not a
    # vendor name written here. This is a display value, so an unresolvable model is left blank
    # rather than failing: the monitor showing nothing is honest, showing the wrong model is not.
    local _gate_model
    _gate_model=$(seam_model_or_fail "$_role" 2>/dev/null || printf '')
    local _gate_provider="${ORCH_GATE_PROVIDER:-}"
    case "$_action" in
        # story_start: <story_id> <lane> <role> [title] [provider] [model]
        start)    "$SCRIPT_DIR/update-monitor.sh" story_start    "" "main" "$_role" "$_msg" "${_gate_provider}" "${_gate_model}" 2>/dev/null || true ;;
        complete) "$SCRIPT_DIR/update-monitor.sh" story_complete "" "main" "$_msg"                                               2>/dev/null || true ;;
        fail)     "$SCRIPT_DIR/update-monitor.sh" story_fail     "" "main" "$_msg"                                               2>/dev/null || true ;;
    esac
}

# _brownfield_gate_scope <gate-name>
# The brownfield addendum every QA gate prompt gets. Empty on greenfield, whose
# flow is deliberately unchanged.
#
# These gates were designed for a freshly-scaffolded application. On a brownfield
# bugfix they are pointed at 850+ existing files and a three-line change, and it
# shows: on 2026-07-26 only TWO of six gates mentioned the code the run actually
# changed. sast spent its budget on 70 pre-existing dependency CVEs; review-ranger
# returned a 211-byte "pass" without naming the diff; perf-sentinel was handed
# browser E2E routing context for a backend string comparison and returned 40
# bytes; fuzz-weaver returned nothing.
#
# Two corrections: judge THIS CHANGE, and be allowed to say the change is not
# your business. Silence is indistinguishable from failure, and a fabricated
# "pass" is worse than both — so `not_applicable` is a first-class verdict with
# a required reason.
_brownfield_gate_scope() {
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate="${1:-this gate}"
    local _files=""
    if [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ]; then
        # shellcheck disable=SC1090
        . "$SCRIPT_DIR/lib/story-outputs.sh" 2>/dev/null || true
        _files=$(story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | head -20)
    fi
    # RENDERED FROM THE TEMPLATE LAYER. Values through a FILE, never argv: the file list is
    # unbounded and argv is capped at ARG_MAX.
    local _bs_vals; _bs_vals=$(mktemp "${TMPDIR:-/tmp}/qa-brownfield-scope-XXXXXX.json")
    jq_vals --arg gate "$_gate" \
          --arg files "${_files:-  (none recorded — fall back to the injected diff)}" \
          '{"__GATE__":$gate,"__FILES__":$files}' > "$_bs_vals"
    # This function's STDOUT is the prompt section its caller injects. `|| true` meant a
    # failed render emitted nothing and the gate ran without its scope section, with no trace.
    if ! render_engine_prompt qa-brownfield-scope "$_bs_vals"; then
        echo "[prompt] qa-brownfield-scope did not render — the QA gate has no scope section" >&2
        rm -f "$_bs_vals"
        return 1
    fi
    rm -f "$_bs_vals"
}

# _run_qa_gate_with_retry <prompt> <agent> <phase> <log_file>
# Wraps run_orch_prompt_with_tools with up to QA_GATE_MAX_RETRIES (default 2) attempts.
# Retry 2: prepends corrective note + escalates to ESCALATION_MODEL_HIGH when set.
# Returns 0 when the log contains structured JSON output; 1 when all attempts fail.
# _lint_fix_findings_directly <lint_log> <phase>
# Repair the flagged lines. Do not rebuild the story around them.
#
# Live metrolinx 2026-07-26, run 7: a correct fix, a test proven RED→GREEN by
# execution and an approved review were all discarded-in-waiting because
# `'line-item-1'` appeared four times in the test's fixture data
# (sonarjs/no-duplicate-string). The only remediation available was to add
# acceptance criteria, exit 2, reset the codeline and rebuild the entire phase —
# ~20 minutes and ~$1 — and nothing in that loop actually fixes the literal, so
# the rebuild can land in exactly the same place.
#
# Nothing here knows any rule names. Whatever the PROJECT'S eslint config
# flagged is what gets repaired; an engine carrying a list of "rules we can fix"
# would rot the moment the project changed its config.
#
# The danger this must not create is worse than the one it solves: an agent
# editing a test could "fix" the finding by weakening the test — and that test is
# the run's only executable proof. So every edit is verified (lint clean, types
# compile, tests still pass) and reverted on any failure, leaving the pipeline
# exactly where it was.
_lint_fix_findings_directly() {
    local _lf_log="$1" _lf_phase="${2:-core}"
    [ "${LINT_FIX_DIRECT_ENABLED:-1}" = "1" ] || return 1
    [ -f "$_lf_log" ] || return 1

    # Findings as the gate reported them: "path:line:col  rule  message".
    local _lf_findings
    # grep reading a FILE still dies on SIGPIPE when head exits after 25 lines: a lint log with
    # more than 25 findings killed the caller. Collect first, take second.
    _lf_all=$(grep -oE '^[^ ]+\.[A-Za-z]+:[0-9]+:[0-9]+ +[^ ]+ +.*' "$_lf_log" 2>/dev/null || true)
    _lf_findings=$(head -n "$(evidence_window lintFindingLines)" <<< "$_lf_all")
    [ -n "$_lf_findings" ] || return 1

    # Scope: ONLY the files the gate flagged. Nothing else is touched.
    local _lf_files
    _lf_files=$(printf '%s\n' "$_lf_findings" | awk -F: '{print $1}' | sort -u)
    [ -n "$_lf_files" ] || return 1

    # Snapshot, so a bad repair can be undone completely.
    local _lf_stash="$LOG_DIR/lint-fix-${_lf_phase}.snapshot"
    rm -rf "$_lf_stash" 2>/dev/null; mkdir -p "$_lf_stash" 2>/dev/null || return 1
    local _f
    while IFS= read -r _f; do
        [ -f "$PROJECT_ROOT/$_f" ] || continue
        mkdir -p "$_lf_stash/$(dirname "$_f")" 2>/dev/null
        cp "$PROJECT_ROOT/$_f" "$_lf_stash/$_f" 2>/dev/null || true
    done <<< "$_lf_files"

    local _lf_attempt=0 _lf_max="${LINT_FIX_MAX_ATTEMPTS:-2}"
    while [ "$_lf_attempt" -lt "$_lf_max" ]; do
        _lf_attempt=$(( _lf_attempt + 1 ))
        info "  [lint-fix] repairing ${_lf_findings_count:-$(printf '%s\n' "$_lf_findings" | wc -l | tr -d ' ')} finding(s) in place (attempt ${_lf_attempt}/${_lf_max})"

        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/lint-fixer-vals-XXXXXX.json")
        jq_vals \
              --arg lf_findings "${_lf_findings}" \
              --arg project_root "${PROJECT_ROOT}" \
              --arg lf_files "${_lf_files}" \
              '{"__LF_FINDINGS__":$lf_findings,"__PROJECT_ROOT__":$project_root,"__LF_FILES__":$lf_files}' > "$_cp_vals"
        local _lf_prompt
        _lf_prompt="$(render_engine_prompt lint-fixer "$_cp_vals")"
        rm -f "$_cp_vals"

        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="${LINT_FIX_ALLOWED_TOOLS:-bash,read_file,write_file,list_files,search}" \
        EPAM_AGENT_NAME="lint-fixer" EPAM_STORY_ID="${_lf_phase}" \
            run_orch_prompt "$_lf_prompt" "lint-fixer" "$_lf_phase" \
            > "$LOG_DIR/lint-fix-${_lf_phase}.log" 2>&1 || true

        # ── VERIFY. The agent's claim is not evidence. ────────────────────────
        local _lf_ok=1

        # 1. the finding is actually gone
        local _lf_relint=0
        eslint_baseline_gate "$PROJECT_ROOT" "$_eslint_bin" "$LOG_DIR" \
            "$LOG_DIR/lint-recheck-${_lf_phase}.log" || _lf_relint=$?
        [ "$_lf_relint" -eq 0 ] || _lf_ok=0

        # 2. it still compiles
        if [ "$_lf_ok" = "1" ] && [ -n "${_node_bin:-}" ]; then
            ( _run_project_verification "$PROJECT_ROOT" ) \
                >/dev/null 2>&1 || _lf_ok=0
        fi

        # 3. the tests still pass — a repair must never weaken the proof
        # The codeline's own command — a `-x .bin/vitest` guard skipped this entirely on a jest
        # repo and left _lf_ok=1, accepting a repair without re-running its proof.
        local _lf_test_cmd; _lf_test_cmd="$(_codeline_test_command "$PROJECT_ROOT")"
        if [ "$_lf_ok" = "1" ] && [ -n "$_lf_test_cmd" ]; then
            ( cd "$PROJECT_ROOT" && run_test_bounded "$(resolve_test_workers)" timeout 600 sh -c "$_lf_test_cmd" ) >/dev/null 2>&1 || _lf_ok=0
        elif [ "$_lf_ok" = "1" ]; then
            warning "  loop-fix: ${PROJECT_ROOT} declares no test command — repair NOT re-verified"
            _lf_ok=0
        fi

        if [ "$_lf_ok" = "1" ]; then
            success "  [lint-fix] findings repaired in place — lint clean, types compile, tests still pass"
            rm -rf "$_lf_stash" 2>/dev/null || true
            return 0
        fi

        warning "  [lint-fix] repair rejected by verification (attempt ${_lf_attempt}/${_lf_max}) — revert the files to their pre-repair state"
        while IFS= read -r _f; do
            [ -f "$_lf_stash/$_f" ] && cp "$_lf_stash/$_f" "$PROJECT_ROOT/$_f" 2>/dev/null || true
        done <<< "$_lf_files"
    done

    rm -rf "$_lf_stash" 2>/dev/null || true
    warning "  [lint-fix] could not repair in place — falling through to gate remediation"
    return 1
}

# ──────────────────────────────────────────────
# run_testing_gates <phase_id>
# Steps 4.2–4.4: Testing coordinator gate (three phases).
# Phase A (Step 4.2): sast-sentinel + spec-validator in parallel.
# Phase B (Step 4.3): review-ranger + mutant-hunter in parallel (only if A passes).
# Phase C (Step 4.4): fuzz-weaver + perf-sentinel in parallel (only if A+B pass).
# Blocks phase gate if any agent returns a blocker-severity finding.
# Skippable with SKIP_TESTING_GATES=true.
# ──────────────────────────────────────────────
# _gate_diff_excludes — the pathspecs that keep artefacts out of a gate's diff.
#
# THE GATES USED TO FILTER BY EXTENSION INSTEAD: `-- '*.ts'`. That is the wrong axis. It answers
# "is this TypeScript", when the question is "is this the change under review" — so on a Python,
# Rust, Go, Ruby or plain-JS codeline the reviewer was handed an EMPTY patch and reviewed nothing,
# while its verdict still counted. Excluding known artefacts keeps lockfiles and build output out
# without deciding what language the customer writes.
_gate_diff_excludes() {
    "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/repo-exclude-patterns.js" diff 2>/dev/null || true
}

run_testing_gates() {
    local phase_id="$1"
    local gate_log="$LOG_DIR/testing-gates-${phase_id}.log"
    local gate_jsonl="$LOG_DIR/testing-gates.jsonl"
    local profiles_file="$AGENT_PROFILES_FILE"
    local failed=0
    # Declared here (not down at the remediation block) because several gates'
    # "agent ran fine, content says fail" branches need to append to these
    # AS THEY EVALUATE — declaring them later in the same function would wipe
    # out those earlier appends via `local`'s scope-wide (not block-wide) effect.
    local _failing_logs=()
    local _log_labels=()
    local force_lightpanda="${FORCE_LIGHTPANDA:-0}"
    local force_playwright="${FORCE_PLAYWRIGHT:-0}"
    local routing_decision="auto"
    local routing_reason="complexity_policy"
    local start_ts
    start_ts=$(date +%s%3N 2>/dev/null || date +%s)

    if [ "$force_lightpanda" = "1" ] && [ "$force_playwright" = "1" ]; then
        warning "Both FORCE_LIGHTPANDA=1 and FORCE_PLAYWRIGHT=1 set; FORCE_PLAYWRIGHT takes precedence"
    fi
    if [ "$force_playwright" = "1" ]; then
        routing_decision="force_playwright"
        routing_reason="env_override"
    elif [ "$force_lightpanda" = "1" ]; then
        routing_decision="force_lightpanda"
        routing_reason="env_override"
    fi

    if is_truthy "${SKIP_TESTING_GATES:-}"; then
        step_emit "22a" "skip" "Step 22a: SAST sentinel" "SKIP_TESTING_GATES=true"
step_emit "22b" "skip" "Step 22b: Spec validator" "SKIP_TESTING_GATES=true"
step_emit "22c" "skip" "Step 22c: Review ranger" "SKIP_TESTING_GATES=true"
step_emit "22d" "skip" "Step 22d: Mutant hunter" "SKIP_TESTING_GATES=true"
step_emit "22e" "skip" "Step 22e: Fuzz-weaver" "SKIP_TESTING_GATES=true"
step_emit "22f" "skip" "Step 22f: Perf sentinel" "SKIP_TESTING_GATES=true"
step_emit "23"  "skip" "Step 23: Browser E2E" "SKIP_TESTING_GATES=true"
        info "Step 4.2: Testing gates skipped (SKIP_TESTING_GATES=true)"
        return 0
    fi

    # Check if phase has code stories (skip for docs-only phases)
    local phase_story_count
    phase_story_count=$(jq -r --arg phase "$phase_id" \
        '(.implementationOrder[$phase] // []) | length' \
        "$PRD_FILE" 2>/dev/null || echo "0")
    if [ "${phase_story_count:-0}" -eq 0 ]; then
        info "Step 4.2: No stories in phase '$phase_id' — skipping testing gates"
        return 0
    fi

    cd "$PROJECT_ROOT"
    log "Step 4.2: Running testing gates for phase '$phase_id'..."
    info "  E2E routing overrides: FORCE_LIGHTPANDA=$force_lightpanda FORCE_PLAYWRIGHT=$force_playwright (decision=$routing_decision)"
    echo "=== Testing Gates: $phase_id @ $(date -Iseconds) ===" > "$gate_log"
    echo "Routing override decision: $routing_decision ($routing_reason), FORCE_LIGHTPANDA=$force_lightpanda, FORCE_PLAYWRIGHT=$force_playwright" >> "$gate_log"
    "$SCRIPT_DIR/update-monitor.sh" event "testing_gate_start" \
        "Starting testing gates for $phase_id" "" "main" "test-coordinator-agent" 2>/dev/null || true

    # Load browser E2E profiles for routing execution (Step 4.6).
    local lightpanda_profile=""
    local playwright_profile=""
    if [ -f "$profiles_file" ]; then
        lightpanda_profile=$(jq -r '.["lightpanda-agent"] // ""' "$profiles_file")
        playwright_profile=$(jq -r '.["playwright-agent"] // ""' "$profiles_file")
    fi
    local e2e_route_runs=0
    local e2e_route_lightpanda=0
    local e2e_route_playwright=0
    local e2e_route_failed=0
    local e2e_route_log="$LOG_DIR/e2e-routing-${phase_id}.log"
    local max_routing_stories="${MAX_BROWSER_ROUTING_STORIES:-3}"
    echo "=== Browser E2E Routing: $phase_id @ $(date -Iseconds) ===" > "$e2e_route_log"

    e2e_story_score() {
        local story_id="$1"
        local score=0
        local hours
        local priority
        local haystack
        hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.estimatedHours // 0)' "$PRD_FILE" 2>/dev/null || echo "0")
        priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.priority // "")' "$PRD_FILE" 2>/dev/null || echo "")
        haystack=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | ((.title // "") + " " + (.description // "")) | ascii_downcase' "$PRD_FILE" 2>/dev/null || echo "")

        if [ "${hours%.*}" -ge 8 ] 2>/dev/null; then score=$((score + 3));
        elif [ "${hours%.*}" -ge 5 ] 2>/dev/null; then score=$((score + 2));
        elif [ "${hours%.*}" -ge 3 ] 2>/dev/null; then score=$((score + 1));
        fi

        case "$(echo "$priority" | tr '[:upper:]' '[:lower:]')" in
            critical|high) score=$((score + 2)) ;;
        esac
        if echo "$haystack" | grep -Eq '(auth|payment|checkout|billing)'; then score=$((score + 2)); fi
        if echo "$haystack" | grep -Eq '(ui|frontend|screen|page|form|browser|e2e)'; then score=$((score + 1)); fi
        echo "$score"
    }

    should_route_browser_story() {
        local story_id="$1"
        local haystack
        haystack=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | ((.title // "") + " " + (.description // "") + " " + (.storyType // "")) | ascii_downcase' "$PRD_FILE" 2>/dev/null || echo "")
        if [ "$force_lightpanda" = "1" ] || [ "$force_playwright" = "1" ]; then
            return 0
        fi
        echo "$haystack" | grep -Eq '(ui|frontend|screen|page|form|browser|e2e|auth|checkout|payment)' && return 0
        return 1
    }

    run_browser_e2e_routing() {
        local phase_ids
        local routed=0
        local story_id
        local route
        local route_reason
        local route_score
        local story_log
        local agent_profile
        local story_title
        local prompt
        local rc

        if [ "${SKIP_BROWSER_E2E_ROUTING:-false}" = "true" ]; then
            step_emit "23" "skip" "Step 23: Browser E2E" "SKIP_BROWSER_E2E_ROUTING=true"
            info "  Step 4.6: Browser E2E routing skipped (SKIP_BROWSER_E2E_ROUTING=true)"
            return 0
        fi

        phase_ids=$(jq -r --arg phase "$phase_id" '(.implementationOrder[$phase] // [])[]' "$PRD_FILE" 2>/dev/null || true)
        if [ -z "$phase_ids" ]; then
            info "  Step 4.6: No phase stories for browser E2E routing"
            return 0
        fi

        step_emit "23" "running" "Step 23: Browser E2E"
        log "  Step 4.6: Browser E2E routing checks (Lightpanda/Playwright)..."
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            should_route_browser_story "$story_id" || continue
            if [ "$routed" -ge "$max_routing_stories" ]; then
                warning "  Step 4.6: Reached MAX_BROWSER_ROUTING_STORIES=$max_routing_stories (remaining stories skipped)"
                break
            fi

            route_score=$(e2e_story_score "$story_id")
            route="lightpanda-agent"
            route_reason="complexity_low_or_medium"
            if [ "$force_playwright" = "1" ]; then
                route="playwright-agent"
                route_reason="env_force_playwright"
            elif [ "$force_lightpanda" = "1" ]; then
                route="lightpanda-agent"
                route_reason="env_force_lightpanda"
            elif [ "${route_score:-0}" -ge 7 ]; then
                route="playwright-agent"
                route_reason="complexity_high"
            elif [ "${route_score:-0}" -ge 4 ]; then
                route="lightpanda-agent"
                route_reason="complexity_medium"
            fi

            if [ "$route" = "playwright-agent" ] && [ -z "$playwright_profile" ]; then
                route="lightpanda-agent"
                route_reason="fallback_playwright_profile_missing"
                warning "  Step 4.6: playwright-agent profile missing; falling back to lightpanda-agent for $story_id"
            fi
            if [ "$route" = "lightpanda-agent" ] && [ -z "$lightpanda_profile" ]; then
                warning "  Step 4.6: lightpanda-agent profile missing; skipping $story_id"
                continue
            fi

            story_title=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.title // $id)' "$PRD_FILE" 2>/dev/null || echo "$story_id")
            "$SCRIPT_DIR/update-monitor.sh" event "e2e_route" \
                "Routed $story_id to $route (score=$route_score, reason=$route_reason)" "$story_id" "main" "test-coordinator-agent" 2>/dev/null || true

            routed=$((routed + 1))
            e2e_route_runs=$((e2e_route_runs + 1))
            if [ "$route" = "playwright-agent" ]; then
                e2e_route_playwright=$((e2e_route_playwright + 1))
                agent_profile="$playwright_profile"
            else
                e2e_route_lightpanda=$((e2e_route_lightpanda + 1))
                agent_profile="$lightpanda_profile"
            fi

            story_log="$LOG_DIR/${route}-${phase_id}-${story_id}.log"
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/e2e-route-check-vals-XXXXXX.json")
            jq_vals \
                  --arg agent_profile "$agent_profile" \
                  --arg route_reason "$route_reason" \
                  --arg story_title "$story_title" \
                  --arg route_score "$route_score" \
                  --arg phase_id "$phase_id" \
                  --arg story_id "$story_id" \
                  --arg route "$route" \
                  '{"__AGENT_PROFILE__":$agent_profile,"__ROUTE_REASON__":$route_reason,"__STORY_TITLE__":$story_title,"__ROUTE_SCORE__":$route_score,"__PHASE_ID__":$phase_id,"__STORY_ID__":$story_id,"__ROUTE__":$route}' > "$_cp_vals"
            prompt="$(render_engine_prompt e2e-route-check "$_cp_vals")"
            rm -f "$_cp_vals"

            echo "[$(date -Iseconds)] story=$story_id route=$route score=$route_score reason=$route_reason" >> "$e2e_route_log"
            set +e
            # run_orch_prompt_with_tools (not plain run_orch_prompt): the
            # playwright-agent/lightpanda-agent profiles instruct actually
            # running browser E2E tests — impossible without Bash tool access,
            # so this call was guaranteed to hallucinate its verdict every time
            # (found live 2026-07-08, same class of bug already fixed for the
            # assessment agents above).
            _run_qa_gate_with_retry "$prompt" "qa-gate:e2e" "${story_id:-unknown}" "$story_log"
            rc=$?
            set -e
            if [ $rc -ne 0 ]; then
                error "  Step 4.6: $route failed for $story_id (exit $rc)"
                e2e_route_failed=$((e2e_route_failed + 1))
                failed=1
                continue
            fi
            # ABSENCE OF "fail" IS NOT SUCCESS. This read the log for fail, then warn, and called
            # everything else a PASS — so an empty log, an unparseable reply or a verdict this
            # gate has never emitted was reported to the operator in the same words as an
            # approval. See qa_gate_verdict_of in lib/gate-verdicts.sh.
            case "$(qa_gate_verdict_of "$story_log")" in
                fail)
                    error "  Step 4.6: $route reported FAIL for $story_id"
                    e2e_route_failed=$((e2e_route_failed + 1))
                    failed=1
                    ;;
                warn)
                    warning "  Step 4.6: $route reported WARN for $story_id"
                    ;;
                pass)
                    success "  Step 4.6: $route PASS for $story_id"
                    ;;
                *)
                    error "  Step 4.6: $route produced NO verdict for $story_id — treating as a failure, because a gate that did not judge has not approved anything"
                    e2e_route_failed=$((e2e_route_failed + 1))
                    failed=1
                    ;;
            esac
        done <<< "$phase_ids"

        if [ $e2e_route_runs -eq 0 ]; then
            step_emit "23" "skip" "Step 23: Browser E2E" "no stories matched"
            info "  Step 4.6: No stories matched browser E2E routing criteria"
        elif [ "$e2e_route_failed" -gt 0 ]; then
            step_emit "23" "fail" "Step 23: Browser E2E"
        else
            step_emit "23" "pass" "Step 23: Browser E2E"
        fi
        echo "Summary: runs=$e2e_route_runs lightpanda=$e2e_route_lightpanda playwright=$e2e_route_playwright failed=$e2e_route_failed" >> "$e2e_route_log"
        return 0
    }

    # ── Phase A: SAST sentinel + spec validator (parallel) ──
    local sast_log="$LOG_DIR/sast-sentinel-${phase_id}.log"
    local spec_log="$LOG_DIR/spec-validator-${phase_id}.log"
    local sast_exit=0
    local spec_exit=0

    # Load QA gate agent profiles
    local sast_profile=""
    local spec_profile=""
    if [ -f "$profiles_file" ]; then
        sast_profile=$(jq -r '.["sast-sentinel"] // ""' "$profiles_file")
        spec_profile=$(jq -r '.["spec-validator"] // ""' "$profiles_file")
    fi

    # ── SAST Sentinel ──
    step_emit "22a" "running" "Step 22a: SAST sentinel"
    log "  Step 4.2a: Running SAST sentinel..."
    {
        # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
        local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-sast-sentinel-vals-XXXXXX.json")
        # The rule vocabulary comes from the one declaration the gate also reads, so the prompt
        # cannot ask for a name the gate does not recognise (config/sast-vocabulary.json).
        local _dep_cve_prefix
        _dep_cve_prefix=$(jq -r '.dependencyCveRulePrefix // ""' "$AUTOMATION_DIR/config/sast-vocabulary.json" 2>/dev/null)
        jq_vals --arg gate_scope "$(_brownfield_gate_scope sast-sentinel)" \
              --arg phase_id "$phase_id" \
              --arg project_root "$PROJECT_ROOT" \
              --arg dependency_cve_rule_prefix "$_dep_cve_prefix" \
              '{"__GATE_SCOPE__":$gate_scope,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root,"__DEPENDENCY_CVE_RULE_PREFIX__":$dependency_cve_rule_prefix}' > "$_qa_vals" 2>/dev/null
        local sast_prompt
        if ! sast_prompt=$(render_engine_prompt qa-sast-sentinel "$_qa_vals"); then
            error "  [sast-sentinel] cannot render its prompt — refusing to gate with no instructions" >&2
            rm -f "$_qa_vals"; return 1
        fi
        rm -f "$_qa_vals"

        if [ -n "$sast_profile" ]; then
            sast_prompt="$sast_profile

$sast_prompt"
        fi

        # ── Semgrep Oracle: inject static analysis evidence before LLM invocation ──
        local semgrep_json="$LOG_DIR/semgrep-oracle-${phase_id}.json"
        local semgrep_summary=""
        # NO LAYOUT ASSUMPTION. This required $PROJECT_ROOT/src to exist, so a repository laying
        # its code out any other way — lib/, app/, pkg/, cmd/, or a flat root — got NO static
        # analysis evidence at all, silently, and the SAST agent judged the change without it.
        # semgrep scans a directory; the repository root is the honest one to give it.
        if command -v semgrep > /dev/null 2>&1 && [ -d "$PROJECT_ROOT" ]; then
            set +e
            semgrep scan \
                --config=auto \
                --json \
                --quiet \
                --timeout=60 \
                --max-target-bytes=500000 \
                "$PROJECT_ROOT" \
                > "$semgrep_json" 2>/dev/null
            local _semgrep_rc=$?
            set -e
            if [ -f "$semgrep_json" ] && [ -s "$semgrep_json" ]; then
                semgrep_summary=$(python3 "$SCRIPT_DIR/lib/handlers/semgrep-summary.py" "$semgrep_json" 2>/dev/null || echo "(semgrep unavailable)")
            else
                semgrep_summary="(semgrep produced no output — exit code $_semgrep_rc)"
            fi
        else
            semgrep_summary="(semgrep oracle skipped — semgrep not in PATH or src/ missing)"
        fi

        _oe_vals=$(mktemp "${TMPDIR:-/tmp}/qa-oracle-vals-XXXXXX.json")
        jq_vals \
              --arg semgrep_summary "$semgrep_summary" \
              --arg sast_prompt "$sast_prompt" \
              '{"__SEMGREP_SUMMARY__":$semgrep_summary,"__SAST_PROMPT__":$sast_prompt}' > "$_oe_vals"
        sast_prompt="$(render_engine_prompt qa-oracle-evidence "$_oe_vals" semgrep)"
        rm -f "$_oe_vals"

        # ── npm audit Oracle: inject dependency CVE evidence ──
        local audit_json="$LOG_DIR/npm-audit-oracle-${phase_id}.json"
        local audit_summary=""
        local _npm_bin
        _npm_bin=$(command -v npm 2>/dev/null || true)
        if [ -n "$_npm_bin" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
            set +e
            "$_npm_bin" audit --json --prefix "$PROJECT_ROOT" \
                > "$audit_json" 2>/dev/null
            local _audit_rc=$?
            set -e
            if [ -f "$audit_json" ] && [ -s "$audit_json" ]; then
                # MOVED TO A HANDLER. This was a 48-line Python program held in a shell
                # single-quoted string and piped to `python3 -`, inside a 1590-line function:
                # unrunnable on its own, untestable, and invisible to every Python tool here.
                audit_summary=$(python3 "$SCRIPT_DIR/lib/handlers/dependency-audit-summary.py" \
                    "$audit_json" "$PROJECT_ROOT/package.json" 2>/dev/null \
                    || echo "(audit parse error)")
            else
                audit_summary="(npm audit produced no output — exit code $_audit_rc)"
            fi
        else
            audit_summary="(npm audit skipped — npm not found or no package.json)"
        fi

        _oe_vals=$(mktemp "${TMPDIR:-/tmp}/qa-oracle-vals-XXXXXX.json")
        jq_vals \
              --arg audit_summary "$audit_summary" \
              --arg sast_prompt "$sast_prompt" \
              '{"__AUDIT_SUMMARY__":$audit_summary,"__SAST_PROMPT__":$sast_prompt}' > "$_oe_vals"
        sast_prompt="$(render_engine_prompt qa-oracle-evidence "$_oe_vals" npm_audit)"
        rm -f "$_oe_vals"

        # ── TypeScript Oracle: run tsc in shell and inject results ──
        local tsc_summary=""
        local _tsc_node_bin
        _tsc_node_bin=$(detect_node 2>/dev/null || true)
        # Guarded on the project having DECLARED a check, not on a specific binary existing.
        if [ -f "$PROJECT_ROOT/.epam/verification.json" ]; then
            set +e
            local _tsc_out
            _tsc_out=$( cd "$PROJECT_ROOT" && _run_project_verification "$PROJECT_ROOT" 2>&1 )
            local _tsc_rc=$?
            set -e

            # Deterministic self-heal for TS18003 ("No inputs were found") —
            # recurred 3x live (2026-07-08): spec-pass sometimes splits the
            # scaffold story so that NO child story ever creates a real source
            # file, leaving tsconfig.json's own include glob matching zero
            # files. This is 100% mechanically diagnosable (tsc says exactly
            # this) and mechanically fixable — no LLM judgment needed, so fix
            # it here instead of letting it fall through to SAST/remediation,
            # which already proved unable to ground a fix for a finding that
            # points at a config file no story owns. Fully generic: reads
            # tsconfig.json's OWN include patterns already on disk — no
            # hardcoded file names, no assumption beyond "this is a tsconfig.json".
            if [ $_tsc_rc -ne 0 ] && echo "$_tsc_out" | grep -q "error TS18003"; then
                local _placeholder_created=""
                _placeholder_created=$(python3 "$SCRIPT_DIR/lib/handlers/tsconfig-strictness.py" "$PROJECT_ROOT" 2>/dev/null || echo "")

                if [ -n "$_placeholder_created" ]; then
                    warning "  [scaffold-self-heal] tsconfig.json include glob matched zero files (TS18003) — created minimal placeholder: $_placeholder_created"
                    set +e
                    _tsc_out=$( cd "$PROJECT_ROOT" && _run_project_verification "$PROJECT_ROOT" 2>&1 )
                    _tsc_rc=$?
                    set -e
                    if [ $_tsc_rc -eq 0 ]; then
                        success "  [scaffold-self-heal] tsc now passes after placeholder creation"
                        ( cd "$PROJECT_ROOT" && git add "$_placeholder_created" 2>/dev/null && \
                          git commit -m "chore(scaffold-self-heal): add placeholder ${_placeholder_created} so tsc has a real input" --quiet 2>/dev/null ) || true
                    else
                        warning "  [scaffold-self-heal] placeholder created but tsc still fails for other reasons — falling through to normal gate evaluation"
                    fi
                fi
            fi

            if [ $_tsc_rc -eq 0 ]; then
                # The engine does not know what the project checked, only that it passed.
                tsc_summary="verification: PASS (exit 0)"
            else
                # grep -c already prints "0" on zero matches while also exiting 1 —
                # `|| echo "?"` would double-print ("0\n?"), garbling this message.
                local _err_count
                _err_count=$(echo "$_tsc_out" | { grep -c "error TS" 2>/dev/null || true; })
                tsc_summary="tsc: FAIL (exit $_tsc_rc) — $_err_count error(s)
$(echo "$_tsc_out" | head -n "$(evidence_window typecheckLines)")"
            fi
        else
            tsc_summary="(tsc oracle skipped — node or tsc binary not found at $PROJECT_ROOT)"
        fi

        _oe_vals=$(mktemp "${TMPDIR:-/tmp}/qa-oracle-vals-XXXXXX.json")
        jq_vals \
              --arg tsc_summary "$tsc_summary" \
              --arg sast_prompt "$sast_prompt" \
              '{"__TSC_SUMMARY__":$tsc_summary,"__SAST_PROMPT__":$sast_prompt}' > "$_oe_vals"
        sast_prompt="$(render_engine_prompt qa-oracle-evidence "$_oe_vals" typescript)"
        rm -f "$_oe_vals"

        _run_qa_gate_with_retry "$sast_prompt" "qa-gate:sast" "${PHASE:-unknown}" "$sast_log"
    } &
    local sast_pid=$!
    _emit_agent start "sast-sentinel" "SAST Sentinel"

    # ── Spec Validator ──
    step_emit "22b" "running" "Step 22b: Spec validator"
    log "  Step 4.2b: Running spec validator..."
    {
        # ── Spec validator: implementation evidence oracle ──
        # Pre-inject git diff + key source files so the agent does NOT need tool
        # calls to examine the implementation. Without this, 7+ stories × ~3 file
        # reads per story exceeds the 20-iteration agent cap before a verdict is
        # written. Pattern mirrors review-ranger's oracle injection.
        local _spec_impl_evidence=""
        local _spec_git_bin
        _spec_git_bin=$(command -v git 2>/dev/null || true)
        if [ -n "$_spec_git_bin" ] && [ -d "$PROJECT_ROOT/.git" ]; then
            local _spec_baseline_sha=""
            [ -f "$LOG_DIR/phase-baseline-sha.txt" ] && \
                _spec_baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
            local _spec_diff_ref="${_spec_baseline_sha:+${_spec_baseline_sha}..HEAD}"
            _spec_diff_ref="${_spec_diff_ref:-HEAD~1}"
            set +e
            local _spec_diff_stat
            _spec_diff_stat=$(cd "$PROJECT_ROOT" && "$_spec_git_bin" diff --stat "$_spec_diff_ref" 2>/dev/null || echo "(no diff)")
            local _spec_diff_patch
            local _spec_ex; mapfile -t _spec_ex < <(_gate_diff_excludes)
            _spec_diff_patch=$(cd "$PROJECT_ROOT" && "$_spec_git_bin" diff -U2 "$_spec_diff_ref" -- . ${_spec_ex[0]+"${_spec_ex[@]}"} 2>/dev/null | head -400 || echo "")
            set -e
            # Also inject content of expected files listed in technicalNotes.files
            local _spec_file_excerpts=""
            _spec_file_excerpts=$(python3 "$SCRIPT_DIR/lib/handlers/phase-story-summary.py" "$PRD_FILE" "$phase_id" "$PROJECT_ROOT" 2>/dev/null || echo "(file oracle unavailable)")
            _spec_impl_evidence="## Implementation Evidence (pre-computed — do NOT call any tools)

### Git diff since phase start ($phase_id)
$_spec_diff_stat

TypeScript/JSON changes (first 400 lines):
$_spec_diff_patch

### Key implementation files (excerpts from technicalNotes.files)
$_spec_file_excerpts"
        else
            _spec_impl_evidence="## Implementation Evidence
(git oracle skipped — git not found or no .git directory; use untestable for ACs that cannot be verified from the story oracle alone)"
        fi

        # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
        local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-spec-validator-vals-XXXXXX.json")
        jq_vals --arg force_lightpanda "$force_lightpanda" \
              --arg force_playwright "$force_playwright" \
              --arg gate_scope "$(_brownfield_gate_scope spec-validator)" \
              --arg phase_id "$phase_id" \
              --arg project_root "$PROJECT_ROOT" \
              --arg routing_decision "$routing_decision" \
              '{"__FORCE_LIGHTPANDA__":$force_lightpanda,"__FORCE_PLAYWRIGHT__":$force_playwright,"__GATE_SCOPE__":$gate_scope,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root,"__ROUTING_DECISION__":$routing_decision}' > "$_qa_vals" 2>/dev/null
        local spec_prompt
        if ! spec_prompt=$(render_engine_prompt qa-spec-validator "$_qa_vals"); then
            error "  [spec-validator] cannot render its prompt — refusing to gate with no instructions" >&2
            rm -f "$_qa_vals"; return 1
        fi
        rm -f "$_qa_vals"

        if [ -n "$spec_profile" ]; then
            spec_prompt="$spec_profile

$spec_prompt"
        fi

        # ── Test Oracle: inject hard vitest evidence before LLM invocation ──
        local oracle_json="$LOG_DIR/vitest-oracle-${phase_id}.json"
        local oracle_summary=""
        local _node_bin
        _node_bin=$(detect_node 2>/dev/null || true)
        if [ -n "$_node_bin" ] && [ -f "$PROJECT_ROOT/package.json" ] && \
           [ -n "$(_codeline_test_command "$PROJECT_ROOT")" ]; then
            set +e
            # The oracle wants machine-readable output; only vitest is asked for --reporter=json,
            # and any other runner falls back to its plain output, which _parse_failing_test_files
            # understands. Previously a non-vitest codeline got no oracle at all.
            if [ -x "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
                "$_node_bin" "$PROJECT_ROOT/node_modules/.bin/vitest" run \
                    --reporter=json --outputFile="$oracle_json" --root "$PROJECT_ROOT" \
                    > /dev/null 2>&1
            else
                # BOUNDED LIKE THE OTHER SIX SITES. This was the one client-suite spawn in this
                # file without run_test_bounded, and its `$(…)` shape escaped the guard scan that
                # covers the `"$_x_test_cmd"` ones. Live 2026-09-11 13:45:50Z, inside a 4623MB
                # scope: Step 19 ran bounded (3 processes), Step 22b's oracle then spawned jest on
                # every core — 18 processes — and the cgroup killed the run after the writer, the
                # repro test, the invalidated-tests step, the review and the build gate had all
                # passed. Uncapped, every earlier run paid the same peak out of the host.
                ( cd "$PROJECT_ROOT" && run_test_bounded "$(resolve_test_workers)" \
                    timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" \
                    sh -c "$(_codeline_test_command "$PROJECT_ROOT")" ) > "${oracle_json}.txt" 2>&1
            fi
            local _oracle_rc=$?
            set -e
            if [ -f "$oracle_json" ]; then
                oracle_summary=$(python3 "$SCRIPT_DIR/lib/handlers/vitest-oracle-summary.py" "$oracle_json" 2>/dev/null || echo "(oracle unavailable)")
            else
                oracle_summary="(vitest ran but produced no JSON output — exit code $_oracle_rc)"
            fi
        else
            oracle_summary="(vitest oracle skipped — node or vitest binary not found)"
        fi

        _oe_vals=$(mktemp "${TMPDIR:-/tmp}/qa-oracle-vals-XXXXXX.json")
        jq_vals \
              --arg oracle_summary "$oracle_summary" \
              --arg spec_prompt "$spec_prompt" \
              '{"__ORACLE_SUMMARY__":$oracle_summary,"__SPEC_PROMPT__":$spec_prompt}' > "$_oe_vals"
        spec_prompt="$(render_engine_prompt qa-oracle-evidence "$_oe_vals" test_results)"
        rm -f "$_oe_vals"

        # ── Story Oracle: inject the criteria the story is JUDGED against ──
        # Not acceptanceCriteria specifically: brownfield stories carry
        # verificationCriteria, and run 8 scored 100% over an empty set because
        # this read the wrong field. lib/story_oracle.py decides and labels.
        local story_oracle=""
        story_oracle=$(python3 "$SCRIPT_DIR/lib/story_oracle.py" "$PRD_FILE" "$phase_id" \
            2>/dev/null || echo "(story oracle unavailable)")
        spec_prompt="## Story Criteria (hard evidence from prd.json — classify each criterion)
$story_oracle

$_spec_impl_evidence

$spec_prompt"

        _run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator" "${PHASE:-unknown}" "$spec_log"
    } &
    local spec_pid=$!
    _emit_agent start "spec-validator" "Spec Validator"

    # Wait for both agents
    wait $sast_pid || sast_exit=$?
    { [ $sast_exit -eq 0 ] && _emit_agent complete "sast-sentinel"; } || _emit_agent fail "sast-sentinel" "exit $sast_exit"
    wait $spec_pid || spec_exit=$?
    { [ $spec_exit -eq 0 ] && _emit_agent complete "spec-validator"; } || _emit_agent fail "spec-validator" "exit $spec_exit"

    local end_ts
    end_ts=$(date +%s%3N 2>/dev/null || date +%s)
    local duration_ms=$(( end_ts - start_ts ))

    # Evaluate results
    if [ $sast_exit -ne 0 ]; then
        error "  SAST sentinel FAILED (exit $sast_exit)"
        failed=1
    else
        # Check for blocker findings in SAST output.
        # Trust blockerCount from the oracle-injected evidence, not the LLM's self-reported verdict
        # field — the LLM defaults to "fail" when it can't run tools, even with 0 blockers.
        local _sast_blockers
        # WHICH DEPENDENCIES DID THIS STORY ADD?
        #
        # On brownfield the blocker counter treats a dependency CVE the story did not introduce as
        # advisory — pre-existing repository debt is not a defect in the work under review, and no
        # writer output can change `npm audit`. It still blocks for a package the story ADDS. That
        # distinction needs the manifest delta, computed here from the phase baseline: every
        # dependency line the change ADDS, name only.
        local _introduced_deps=""
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -n "${PROJECT_ROOT:-}" ]; then
            _introduced_deps="$(story_introduced_deps "$PROJECT_ROOT")"
            [ -n "$_introduced_deps" ] && \
                log "  [sast] dependencies introduced by this story: ${_introduced_deps}"
        fi
        _sast_blockers=$(EPAM_STORY_INTRODUCED_DEPS="$_introduced_deps" \
            python3 "$SCRIPT_DIR/lib/handlers/sast-blockers.py" "$sast_log" 2>/dev/null || echo "-1")
        if [ "$_sast_blockers" = "-1" ]; then
            # Fallback: no parseable JSON — check raw verdict string
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$sast_log" 2>/dev/null; then
                step_emit "22a" "fail" "Step 22a: SAST sentinel"
                error "  SAST sentinel: FAIL verdict (could not parse blockerCount)"
                failed=1
                _failing_logs+=("$sast_log")
                _log_labels+=("sast-sentinel")
            else
                # THE RECORD SAID warn AND THE OPERATOR WAS TOLD "PASS". blockerCount could not
                # be parsed and the raw verdict held no "fail", so nothing was READ — on the
                # security gate, of all of them. The step stays a warn, which is the policy
                # already chosen here; what changes is that the sentence matches it. A gate whose
                # findings could not be parsed has not cleared anything.
                step_emit "22a" "warn" "Step 22a: SAST sentinel" "no parseable findings"
                warning "  SAST sentinel: findings could not be parsed and no fail verdict was present — NOT a pass; nothing was checked"
            fi
        elif [ "$_sast_blockers" -gt 0 ]; then
            step_emit "22a" "fail" "Step 22a: SAST sentinel"
            error "  SAST sentinel: FAIL — $_sast_blockers blocker finding(s) detected"
            failed=1
            # sast_exit=0 here (agent exited clean) so the later exit-code check
            # in the remediation-log collector won't pick this up — add it
            # explicitly so the self-heal remediation pipeline actually fires
            # (same fix already applied to perf-sentinel below; this failure mode
            # — agent runs fine, content says fail — is the COMMON case, not the
            # exception, so skipping remediation for it defeated self-heal for
            # the majority of real testing-gate failures).
            _failing_logs+=("$sast_log")
            _log_labels+=("sast-sentinel")
        else
            step_emit "22a" "pass" "Step 22a: SAST sentinel"
            success "  SAST sentinel: PASS (blockerCount=$_sast_blockers)"
        fi
    fi

    if [ $spec_exit -ne 0 ]; then
        step_emit "22b" "fail" "Step 22b: Spec validator"
        error "  Spec validator FAILED (exit $spec_exit)"
        failed=1
    else
        # Check for actual failing stories, not just the top-level overallVerdict.
        # An empty stories[] with overallVerdict:fail means the agent had no data — treat as warn.
        local _spec_failing
        # BUG (found live, 2026-07-07): '$spec_log' was single-quoted — bash never
        # expanded it, so python3 received the literal 8-character string
        # "$spec_log" as sys.argv[1], not the real log path. open() then raised
        # FileNotFoundError every single time, caught by the blanket except and
        # mapped to the generic "no story data"/"error" path — meaning a REAL
        # spec-validator "fail" verdict (e.g. SKY-004 missing /search, /cheapest,
        # dashboard) was silently downgraded to a non-blocking warning on every
        # run, never once actually parsed. Fixed: double-quote so bash expands it.
        _spec_failing=$(python3 "$SCRIPT_DIR/lib/handlers/spec-extractor.py" "$spec_log" 2>/dev/null || echo "error")
        if [ "$_spec_failing" = "no-data" ] || [ "$_spec_failing" = "no-json" ] || [ "$_spec_failing" = "error" ]; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "no story data"
            warning "  Spec validator: WARN — agent returned no story data (oracle injection needed)"
        elif [ "$_spec_failing" -gt 0 ]; then
            step_emit "22b" "fail" "Step 22b: Spec validator"
            error "  Spec validator: FAIL — $_spec_failing story/stories failed criteria"
            failed=1
            # spec_exit=0 here (agent exited clean) — append explicitly so
            # self-heal remediation fires; see the SAST fix above for why.
            _failing_logs+=("$spec_log")
            _log_labels+=("spec-validator")
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"warn"' "$spec_log" 2>/dev/null; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "partial"
            warning "  Spec validator: WARN — some criteria partially met (non-blocking)"
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"fail"' "$spec_log" 2>/dev/null; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "ungrounded findings downgraded"
            warning "  Spec validator: FAIL verdict downgraded to WARN — every criterion in every failing story was self-reported as 'untestable' (agent had no real evidence, likely didn't use its tools; re-check manually)"
        else
            step_emit "22b" "pass" "Step 22b: Spec validator"
            success "  Spec validator: PASS"
        fi
    fi

    # ── Phase B: review-ranger + mutant-hunter (parallel, only if Phase A passed) ──
    local review_exit=0
    local mutant_exit=0
    if [ $failed -eq 0 ]; then
        local review_log="$LOG_DIR/review-ranger-${phase_id}.log"
        local mutant_log="$LOG_DIR/mutant-hunter-${phase_id}.log"

        local review_profile=""
        local mutant_profile=""
        if [ -f "$profiles_file" ]; then
            review_profile=$(jq -r '.["review-ranger"] // ""' "$profiles_file")
            mutant_profile=$(jq -r '.["mutant-hunter"] // ""' "$profiles_file")
        fi

        # ── Review Ranger ──
        step_emit "22c" "running" "Step 22c: Review ranger"
        log "  Step 4.3a: Running review-ranger..."
        {
            # ── Git diff oracle: inject changed files and their content ──
            local review_diff_summary=""
            local _git_bin
            _git_bin=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                # Use the pre-story-loop baseline SHA when available so the diff
                # covers ALL commits from this run, not just the last one.
                local _baseline_sha=""
                if [ -f "$LOG_DIR/phase-baseline-sha.txt" ]; then
                    _baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
                fi
                local _diff_ref
                if [ -n "$_baseline_sha" ]; then
                    _diff_ref="${_baseline_sha}..HEAD"
                else
                    _diff_ref="HEAD~1"
                fi
                # Scope from the writers' output when the story loop recorded it
                # (lib/story-outputs.sh); the diff below stays as the fallback.
                # shellcheck disable=SC1090
                [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
                local _diff_files
                _diff_files=$(story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null || echo "")
                [ -z "$_diff_files" ] && \
                    _diff_files=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --name-only "$_diff_ref" 2>/dev/null || echo "")
                local _diff_stat
                _diff_stat=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --stat "$_diff_ref" 2>/dev/null || echo "(no diff available)")
                local _diff_patch
                local _rr_ex; mapfile -t _rr_ex < <(_gate_diff_excludes)
                _diff_patch=$(cd "$PROJECT_ROOT" && "$_git_bin" diff -U3 "$_diff_ref" -- . ${_rr_ex[0]+"${_rr_ex[@]}"} 2>/dev/null | head -300 || echo "")
                set -e
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/qa-evidence-labels-vals-XXXXXX.json")
                jq_vals \
                      --arg diff_patch "$_diff_patch" \
                      --arg diff_stat "$_diff_stat" \
                      '{"__DIFF_PATCH__":$diff_patch,"__DIFF_STAT__":$diff_stat}' > "$_cp_vals"
                review_diff_summary="$(render_engine_prompt qa-evidence-labels "$_cp_vals" review_diff)"
                rm -f "$_cp_vals"
            else
                review_diff_summary="(git diff oracle skipped — git not found or no .git directory)"
            fi

            # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
            local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-review-ranger-vals-XXXXXX.json")
            jq_vals --arg gate_scope "$(_brownfield_gate_scope review-ranger)" \
                  --arg phase_id "$phase_id" \
                  --arg project_root "$PROJECT_ROOT" \
                  --arg review_diff_summary "$review_diff_summary" \
                  '{"__GATE_SCOPE__":$gate_scope,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root,"__REVIEW_DIFF_SUMMARY__":$review_diff_summary}' > "$_qa_vals" 2>/dev/null
            local review_prompt
            if ! review_prompt=$(render_engine_prompt qa-review-ranger "$_qa_vals"); then
                error "  [review-ranger] cannot render its prompt — refusing to gate with no instructions" >&2
                rm -f "$_qa_vals"; return 1
            fi
            rm -f "$_qa_vals"

            if [ -n "$review_profile" ]; then
                review_prompt="$review_profile

$review_prompt"
            fi

            _run_qa_gate_with_retry "$review_prompt" "qa-gate:review-ranger" "${PHASE:-unknown}" "$review_log"
        } &
        local review_pid=$!
        _emit_agent start "review-ranger" "Review Ranger"

        # ── Mutant Hunter ──
        step_emit "22d" "running" "Step 22d: Mutant hunter"
        log "  Step 4.3b: Running mutant-hunter..."
        {
            # ── Source + test oracle: inject changed files and test files ──
            local mutant_oracle_summary=""
            local _git_bin2
            _git_bin2=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin2" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                # Use the same pre-story baseline SHA as review-ranger for consistency.
                local _mut_baseline_sha=""
                if [ -f "$LOG_DIR/phase-baseline-sha.txt" ]; then
                    _mut_baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
                fi
                local _mut_diff_ref
                if [ -n "$_mut_baseline_sha" ]; then
                    _mut_diff_ref="${_mut_baseline_sha}..HEAD"
                else
                    _mut_diff_ref="HEAD~1"
                fi
                # shellcheck disable=SC1090
                [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
                local _changed_src
                # story_outputs_sources ALREADY excludes test files, using the broad convention
                # regex that knows .spec., _test, test_* and __tests__/. Re-filtering to `.ts`
                # threw away every source file on any other stack — and the fallback re-derived a
                # narrower test rule (`.test.ts`) that the same library had already generalised.
                local _mh_ex; mapfile -t _mh_ex < <(_gate_diff_excludes)
                _changed_src=$(story_outputs_sources "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | head -10 || echo "")
                [ -z "$_changed_src" ] && \
                    _changed_src=$(cd "$PROJECT_ROOT" && "$_git_bin2" diff --name-only "$_mut_diff_ref" -- . ${_mh_ex[0]+"${_mh_ex[@]}"} 2>/dev/null | \
                                   grep -vE "$_STORY_OUTPUTS_TEST_RE" | head -10 || echo "")
                set -e
                local _src_content=""
                if [ -n "$_changed_src" ]; then
                    while IFS= read -r _f; do
                        [ -f "$PROJECT_ROOT/$_f" ] || continue
                        local _mut_src_total_lines _mut_src_marker=""
                        _mut_src_total_lines=$(wc -l < "$PROJECT_ROOT/$_f" 2>/dev/null || echo 0)
                        # Full agent audit, 2026-07-31: this excerpt was silently
                        # capped with no signal to the agent, unlike review-ranger's
                        # diff injection (which appends a "[TRUNCATED...]" marker
                        # when its own cap is hit). A file longer than 100 lines
                        # was invisible past that point with no indication anything
                        # was cut — the agent could confidently judge mutations
                        # against a partial file and never know it.
                        # THE DECLARED WINDOW, not a second copy of it. This literal 100 sat
                        # beside `head -n "$(evidence_window mutationSourceLines)"`, so widening
                        # the declaration silently stopped the notice from firing.
                        local _mut_src_win; _mut_src_win=$(evidence_window mutationSourceLines 2>/dev/null || echo 0)
                        if [ "${_mut_src_total_lines:-0}" -gt "${_mut_src_win:-0}" ]; then
                            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/qa-evidence-labels-vals-XXXXXX.json")
                            jq_vals \
                                  --arg mut_src_total_lines "${_mut_src_total_lines}" \
                                  '{"__MUT_SRC_TOTAL_LINES__":$mut_src_total_lines}' > "$_cp_vals"
                            _mut_src_marker="$(render_engine_prompt qa-evidence-labels "$_cp_vals" truncation_notice_source)"
                            rm -f "$_cp_vals"
                        fi
                        # CENTRED ON THE CHANGE. `head -n` showed the first N lines of the file,
                        # so a 436-line component fixed at line 306 was out of reach at any window
                        # size — the mutant hunter said so itself and could only answer WARN.
                        _src_content="$_src_content
$(qa_gate_excerpt "$PROJECT_ROOT" "$LOG_DIR" "$_f" mutationSourceLines)${_mut_src_marker}"
                    done <<< "$_changed_src"
                fi
                # The tests to judge are THIS RUN'S tests. This used to be
                # `find -name "*.test.ts"` over the whole tree, which (a) picked
                # arbitrary unrelated tests when it matched and (b) matched
                # NOTHING on a codeline whose tests are named `.spec.ts` — as
                # the live metrolinx one is. It reported "(no test files found)"
                # on a run that had just written a reproducing spec, so the
                # mutation oracle judged the change against no tests at all.
                local _test_files
                _test_files=$(story_outputs_tests "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | \
                              sed "s#^#$PROJECT_ROOT/#" | head -5 || echo "")
                [ -z "$_test_files" ] && \
                    _test_files=$(find "$PROJECT_ROOT" \( -name "*.test.ts" -o -name "*.spec.ts" \) \
                                       -not -path "*/node_modules/*" 2>/dev/null | head -5)
                local _test_content=""
                while IFS= read -r _tf; do
                    [ -f "$_tf" ] || continue
                    local _mut_test_total_lines _mut_test_marker=""
                    _mut_test_total_lines=$(wc -l < "$_tf" 2>/dev/null || echo 0)
                    local _mut_test_win; _mut_test_win=$(evidence_window mutationTestLines 2>/dev/null || echo 0)
                    if [ "${_mut_test_total_lines:-0}" -gt "${_mut_test_win:-0}" ]; then
                        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/qa-evidence-labels-vals-XXXXXX.json")
                        jq_vals \
                              --arg mut_test_total_lines "${_mut_test_total_lines}" \
                              '{"__MUT_TEST_TOTAL_LINES__":$mut_test_total_lines}' > "$_cp_vals"
                        _mut_test_marker="$(render_engine_prompt qa-evidence-labels "$_cp_vals" truncation_notice_test)"
                        rm -f "$_cp_vals"
                    fi
                    _test_content="$_test_content
$(qa_gate_excerpt "$PROJECT_ROOT" "$LOG_DIR" "$_tf" mutationTestLines)${_mut_test_marker}"
                done <<< "$_test_files"
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/qa-evidence-labels-vals-XXXXXX.json")
                jq_vals \
                      --arg src_content "${_src_content:-  (none — no TypeScript source changes in this phase)}" \
                      --arg test_content "${_test_content:-  (no test files found)}" \
                      '{"__SRC_CONTENT__":$src_content,"__TEST_CONTENT__":$test_content}' > "$_cp_vals"
                mutant_oracle_summary="$(render_engine_prompt qa-evidence-labels "$_cp_vals" mutant_oracle)"
                rm -f "$_cp_vals"
            else
                mutant_oracle_summary="(mutation oracle skipped — git not found or no .git directory)"
            fi

            # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
            local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-mutant-hunter-vals-XXXXXX.json")
            jq_vals --arg gate_scope "$(_brownfield_gate_scope mutant-hunter)" \
                  --arg mutant_oracle_summary "$mutant_oracle_summary" \
                  --arg phase_id "$phase_id" \
                  --arg project_root "$PROJECT_ROOT" \
                  '{"__GATE_SCOPE__":$gate_scope,"__MUTANT_ORACLE_SUMMARY__":$mutant_oracle_summary,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root}' > "$_qa_vals" 2>/dev/null
            local mutant_prompt
            if ! mutant_prompt=$(render_engine_prompt qa-mutant-hunter "$_qa_vals"); then
                error "  [mutant-hunter] cannot render its prompt — refusing to gate with no instructions" >&2
                rm -f "$_qa_vals"; return 1
            fi
            rm -f "$_qa_vals"

            if [ -n "$mutant_profile" ]; then
                mutant_prompt="$mutant_profile

$mutant_prompt"
            fi

            _run_qa_gate_with_retry "$mutant_prompt" "qa-gate:mutant-hunter" "${PHASE:-unknown}" "$mutant_log"
        } &
        local mutant_pid=$!
        _emit_agent start "mutant-hunter" "Mutant Hunter"

        # Wait for both Phase B agents
        wait $review_pid || review_exit=$?
        { [ $review_exit -eq 0 ] && _emit_agent complete "review-ranger"; } || _emit_agent fail "review-ranger" "exit $review_exit"
        wait $mutant_pid || mutant_exit=$?
        { [ $mutant_exit -eq 0 ] && _emit_agent complete "mutant-hunter"; } || _emit_agent fail "mutant-hunter" "exit $mutant_exit"

        # Evaluate Phase B results
        if [ $review_exit -ne 0 ]; then
            step_emit "22c" "fail" "Step 22c: Review ranger"
            error "  Review-ranger FAILED (exit $review_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$review_log" 2>/dev/null; then
                # Full agent audit re-audit, 2026-07-31: this used to trust a bare
                # self-reported "verdict":"fail" with NO check that any named
                # file:line actually exists — unlike sast-sentinel (real
                # Semgrep/tsc/npm-audit oracle) or perf-sentinel (codeSnippet
                # verified against the real file). An agent could cite a
                # plausible but fabricated file:line and still block the
                # pipeline. Same "quote it, then verify the quote" pattern now
                # applied here: require at least one blocker finding whose
                # codeSnippet is a literal substring of the real file on disk.
                _review_grounded=$(python3 "$SCRIPT_DIR/lib/handlers/review.py" "$review_log" "$PROJECT_ROOT" 2>/dev/null || echo "0")
                if [ "${_review_grounded:-0}" -gt 0 ]; then
                    step_emit "22c" "fail" "Step 22c: Review ranger"
                    error "  Review-ranger: FAIL — confirmed blocker (codeSnippet verified against the real file)"
                    failed=1
                    # review_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$review_log")
                    _log_labels+=("review-ranger")
                else
                    step_emit "22c" "warn" "Step 22c: Review ranger" "unverified findings downgraded"
                    warning "  Review-ranger: FAIL verdict downgraded to WARN — no blocker finding's codeSnippet could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$review_log" 2>/dev/null; then
                step_emit "22c" "warn" "Step 22c: Review ranger" "non-blocking findings"
                warning "  Review-ranger: WARN — non-blocking findings (continuing)"
            else
                step_emit "22c" "pass" "Step 22c: Review ranger"
                success "  Review-ranger: PASS"
            fi
        fi

        if [ $mutant_exit -ne 0 ]; then
            step_emit "22d" "fail" "Step 22d: Mutant hunter"
            error "  Mutant-hunter FAILED (exit $mutant_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$mutant_log" 2>/dev/null; then
                # Full agent audit re-audit, 2026-07-31: mutationScore/survived
                # counts were entirely self-reported with zero independent
                # verification — an agent could report a low score with no
                # basis in its own listed mutations and still block the
                # pipeline. Now requires: (1) summary.survived agrees with the
                # actual count of status:survived entries in the mutations
                # array (self-consistency — catches a score disconnected from
                # its own detail), AND (2) at least one survived mutation's
                # originalCode is a literal substring of the real file on disk
                # (catches a fabricated file/line/code claim, same "quote it,
                # verify it" pattern as review-ranger/perf-sentinel).
                _mutant_grounded=$(python3 "$SCRIPT_DIR/lib/handlers/mutant.py" "$mutant_log" "$PROJECT_ROOT" 2>/dev/null || echo "0")
                if [ "${_mutant_grounded:-0}" -gt 0 ]; then
                    step_emit "22d" "fail" "Step 22d: Mutant hunter"
                    error "  Mutant-hunter: FAIL — confirmed surviving mutation (originalCode verified against the real file, survived count self-consistent)"
                    failed=1
                    # mutant_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$mutant_log")
                    _log_labels+=("mutant-hunter")
                else
                    step_emit "22d" "warn" "Step 22d: Mutant hunter" "unverified findings downgraded"
                    warning "  Mutant-hunter: FAIL verdict downgraded to WARN — survived count disagreed with its own mutations detail, or no surviving mutation's originalCode could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$mutant_log" 2>/dev/null; then
                step_emit "22d" "warn" "Step 22d: Mutant hunter" "score 50-69%"
                warning "  Mutant-hunter: WARN — mutation score 50-69% (non-blocking)"
            else
                step_emit "22d" "pass" "Step 22d: Mutant hunter"
                success "  Mutant-hunter: PASS"
            fi
        fi
    else
        step_emit "22c" "skip" "Step 22c: Review ranger" "Phase A failed"
        step_emit "22d" "skip" "Step 22d: Mutant hunter" "Phase A failed"
        info "  Phase B (review-ranger + mutant-hunter) skipped — Phase A had failures"
    fi

    # ── Phase C: fuzz-weaver + perf-sentinel (parallel, only if A+B passed) ──
    local fuzz_exit=0
    local perf_exit=0
    if [ $failed -eq 0 ]; then
        local fuzz_log="$LOG_DIR/fuzz-weaver-${phase_id}.log"
        local perf_log="$LOG_DIR/perf-sentinel-${phase_id}.log"

        local fuzz_profile=""
        local perf_profile=""
        if [ -f "$profiles_file" ]; then
            fuzz_profile=$(jq -r '.["fuzz-weaver"] // ""' "$profiles_file")
            perf_profile=$(jq -r '.["perf-sentinel"] // ""' "$profiles_file")
        fi

        # ── Fuzz Weaver ──
        step_emit "22e" "running" "Step 22e: Fuzz-weaver"
        log "  Step 4.4a: Running fuzz-weaver..."
        {
            # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
            local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-fuzz-weaver-vals-XXXXXX.json")
            jq_vals --arg force_lightpanda "$force_lightpanda" \
                  --arg force_playwright "$force_playwright" \
                  --arg gate_scope "$(_brownfield_gate_scope fuzz-weaver)" \
                  --arg phase_id "$phase_id" \
                  --arg project_root "$PROJECT_ROOT" \
                  --arg routing_decision "$routing_decision" \
                  '{"__FORCE_LIGHTPANDA__":$force_lightpanda,"__FORCE_PLAYWRIGHT__":$force_playwright,"__GATE_SCOPE__":$gate_scope,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root,"__ROUTING_DECISION__":$routing_decision}' > "$_qa_vals" 2>/dev/null
            local fuzz_prompt
            # The codeline's own facts — this template declares them and nothing supplied them.
            # Stack facts are the RENDERER's job — engine-prompt.js adds exactly the stack
            # placeholders this template DECLARES. Pre-merging all seven here made the
            # renderer throw "was given values it does not use" on every template that
            # declares fewer, and the caller reported "cannot render its prompt". Four
            # seams could not run at all, the fuzz-weaver among them.
            if ! fuzz_prompt=$(render_engine_prompt qa-fuzz-weaver "$_qa_vals"); then
                error "  [fuzz-weaver] cannot render its prompt — refusing to gate with no instructions" >&2
                rm -f "$_qa_vals"; return 1
            fi
            rm -f "$_qa_vals"

            if [ -n "$fuzz_profile" ]; then
                fuzz_prompt="$fuzz_profile

$fuzz_prompt"
            fi

            _run_qa_gate_with_retry "$fuzz_prompt" "qa-gate:fuzz-weaver" "${PHASE:-unknown}" "$fuzz_log"
        } &
        local fuzz_pid=$!
        _emit_agent start "fuzz-weaver" "Fuzz Weaver"

        # ── Perf Sentinel ──
        step_emit "22f" "running" "Step 22f: Perf sentinel"
        log "  Step 4.4b: Running perf-sentinel..."
        {
            # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
            local _qa_vals; _qa_vals=$(mktemp "${TMPDIR:-/tmp}/qa-perf-sentinel-vals-XXXXXX.json")
            jq_vals --arg force_lightpanda "$force_lightpanda" \
                  --arg force_playwright "$force_playwright" \
                  --arg gate_scope "$(_brownfield_gate_scope perf-sentinel)" \
                  --arg phase_id "$phase_id" \
                  --arg project_root "$PROJECT_ROOT" \
                  --arg routing_decision "$routing_decision" \
                  '{"__FORCE_LIGHTPANDA__":$force_lightpanda,"__FORCE_PLAYWRIGHT__":$force_playwright,"__GATE_SCOPE__":$gate_scope,"__PHASE_ID__":$phase_id,"__PROJECT_ROOT__":$project_root,"__ROUTING_DECISION__":$routing_decision}' > "$_qa_vals" 2>/dev/null
            local perf_prompt
            if ! perf_prompt=$(render_engine_prompt qa-perf-sentinel "$_qa_vals"); then
                error "  [perf-sentinel] cannot render its prompt — refusing to gate with no instructions" >&2
                rm -f "$_qa_vals"; return 1
            fi
            rm -f "$_qa_vals"

            if [ -n "$perf_profile" ]; then
                perf_prompt="$perf_profile

$perf_prompt"
            fi

            _run_qa_gate_with_retry "$perf_prompt" "qa-gate:perf-sentinel" "${PHASE:-unknown}" "$perf_log"
        } &
        local perf_pid=$!
        _emit_agent start "perf-sentinel" "Perf Sentinel"

        # ── Runtime Boundary ──
        #
        # THE QUESTION NO OTHER GATE ASKS: can this change execute, where it will execute, as this
        # codeline is configured? Live metrolinx AMSD-2041 shipped three implementations in three
        # runs; two defects survived all of them — a page-level module importing a service that
        # throws at load in a context where its credentials are absent, and configuration that
        # forbade the embedding the feature required. SAST judges vulnerabilities, review-ranger
        # judges the diff, and the client/server scanner reads changed files only.
        step_emit "22g" "running" "Step 22g: Runtime boundary"
        log "  Step 4.4c: Running runtime-boundary review..."
        {
            local _rb_log="$LOG_DIR/runtime-boundary-${phase_id}.log"
            local _rb_profile=""
            [ -f "$profiles_file" ] && _rb_profile=$(jq -r '.["runtime-boundary"] // ""' "$profiles_file")
            # The configuration this codeline carries, resolved from its OWN manifest by the
            # adapter that already knows the stack. Empty for a stack no adapter recognises.
            local _rb_config
            _rb_config=$("${NODE_CMD:-node}" -e '
              try {
                const p = require(process.argv[1]);
                const f = p.configSurface(process.argv[2]) || [];
                process.stdout.write(f.length ? f.map((x) => "- " + x).join("\n")
                                              : "(this codeline declares no configuration this engine recognises)");
              } catch { process.stdout.write("(configuration could not be resolved)"); }
            ' "$AUTOMATION_DIR/plugins/client-env-boundary-plugin.js" "$PROJECT_ROOT" 2>/dev/null || echo "")
            local _rb_vals; _rb_vals=$(mktemp "${TMPDIR:-/tmp}/qa-runtime-boundary-vals-XXXXXX.json")
            # THIS PHASE'S DIFF, not the last commit. `${_rev_base:-HEAD~1}` had no assignment
            # anywhere in this file, so the fallback WAS the behaviour — and repro-test-writer
            # commits after the writer, so that window held the reproducing test and never the fix.
            # Live 2026-09-09: this gate reported "CheckoutForm.tsx itself is unmodified (git diff
            # confirms no changes)" about a run that had just changed it.
            # THE SCOPE GOES IN __GATE_SCOPE__, as in every other gate. It went into __STORY_TITLE__,
            # a slot that may not be empty, so on a greenfield phase — where the scope IS empty by
            # design — this gate refused to render and reported "no structured output, non-blocking
            # warn": a gate failing open (£0 greenfield harness run 23, 2026-09-14).
            jq_vals --arg story_id "${phase_id}" \
                  --arg gate_scope "$(_brownfield_gate_scope runtime-boundary)" \
                  --arg story_diff "$(qa_gate_diff "$PROJECT_ROOT" "$LOG_DIR")" \
                  --arg config_surface "$_rb_config" \
                  --arg project_root "$PROJECT_ROOT" \
                  --arg review_profile "$_rb_profile" \
                  '{"__STORY_ID__":$story_id,"__GATE_SCOPE__":$gate_scope,"__STORY_DIFF__":$story_diff,"__CONFIG_SURFACE__":$config_surface,"__PROJECT_ROOT__":$project_root,"__REVIEW_PROFILE__":$review_profile}' > "$_rb_vals" 2>/dev/null
            local _rb_prompt
            if ! _rb_prompt=$(render_engine_prompt runtime-boundary-review "$_rb_vals"); then
                error "  [runtime-boundary] cannot render its prompt — refusing to gate with no instructions" >&2
                rm -f "$_rb_vals"; return 1
            fi
            rm -f "$_rb_vals"
            _run_qa_gate_with_retry "$_rb_prompt" "qa-gate:runtime-boundary" "${PHASE:-unknown}" "$_rb_log"
        } &
        local _rb_pid=$!
        _emit_agent start "runtime-boundary" "Runtime Boundary"

        # Wait for both Phase C agents
        wait $fuzz_pid || fuzz_exit=$?
        { [ $fuzz_exit -eq 0 ] && _emit_agent complete "fuzz-weaver"; } || _emit_agent fail "fuzz-weaver" "exit $fuzz_exit"
        wait $perf_pid || perf_exit=$?
        { [ $perf_exit -eq 0 ] && _emit_agent complete "perf-sentinel"; } || _emit_agent fail "perf-sentinel" "exit $perf_exit"
        # An unwaited background job is a gate that reports nothing: the phase moves on while it is
        # still running, and its verdict lands after anyone could act on it.
        local _rb_exit=0
        wait $_rb_pid || _rb_exit=$?
        { [ $_rb_exit -eq 0 ] && _emit_agent complete "runtime-boundary"; } || _emit_agent fail "runtime-boundary" "exit $_rb_exit"
        # THE EXIT CODE ONLY SAYS THE AGENT RAN. What it FOUND is in the log, and until
        # 2026-08-28 nothing read it: a grounded report that the change cannot execute printed
        # "pass" here because the process exited 0.
        if [ $_rb_exit -ne 0 ]; then
            # No structured output after retries. A gate that could not run is not a confirmed
            # failure, and is not a pass either.
            step_emit "22g" "warn" "Step 22g: Runtime boundary" "no structured output (exit ${_rb_exit})"
            warning "  Runtime-boundary: no structured output after all retries — non-blocking warn"
        else
            case "$(runtime_boundary_verdict "$_rb_log" "$PROJECT_ROOT")" in
                fail)
                    step_emit "22g" "fail" "Step 22g: Runtime boundary"
                    error "  Runtime-boundary: FAIL — the change cannot execute as this codeline is configured."
                    error "    See ${_rb_log}"
                    failed=1
                    _failing_logs+=("$_rb_log")
                    _log_labels+=("runtime-boundary")
                    ;;
                warn)
                    step_emit "22g" "warn" "Step 22g: Runtime boundary" "findings not grounded in real files"
                    warning "  Runtime-boundary: WARN — findings could not be grounded in real files (non-blocking)"
                    ;;
                *)
                    step_emit "22g" "pass" "Step 22g: Runtime boundary"
                    success "  Runtime-boundary: PASS"
                    ;;
            esac
        fi

        # Evaluate Phase C results
        # Fuzz-weaver: validate that any "fail" verdict is grounded in real files.
        # An agent with no tool access will hallucinate findings about non-existent files.
        # We downgrade "fail" to "warn" when no vulnerability finding references a file
        # that actually exists under PROJECT_ROOT/src.
        if [ $fuzz_exit -ne 0 ]; then
            # exit 1 means _run_qa_gate_with_retry exhausted all retries with no
            # structured output — the model produced nothing parseable. Treat as
            # non-blocking warn: a gate that couldn't run is NOT a confirmed failure.
            # Only a grounded "verdict":"fail" in the log (exit 0 path below) blocks.
            warning "  Fuzz-weaver: no structured output after all retries — treating as non-blocking warn"
            fuzz_exit=0
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$fuzz_log" 2>/dev/null; then
                # Ground-truth check, two layers:
                #  1. File-exists — same as before, catches claims about non-existent files.
                #  2. Executable-evidence — a claim referencing a REAL file can still be
                #     wrong about that file's actual behavior (e.g. misreading a regex).
                #     Each vulnerability case must supply an "executableTest" (a real vitest
                #     test the agent wrote asserting the SAFE/expected behavior); we actually
                #     RUN it against the real code. If the assertion FAILS, the code really
                #     doesn't behave safely — the vulnerability is confirmed. If it PASSES,
                #     the code was already correct and the claim was a hallucination. Cases
                #     with no executableTest (or where vitest isn't available) are treated
                #     as unverified and do not block the gate — this only counts claims that
                #     were actually demonstrated against the real source, not merely asserted.
                local _node_bin
                _node_bin=$(detect_node 2>/dev/null || true)
                _fuzz_grounded=$(python3 "$SCRIPT_DIR/lib/handlers/fuzz-verify.py" "$fuzz_log" "$PROJECT_ROOT" "${_node_bin:-}" 2>/dev/null || echo "0")
                if [ "${_fuzz_grounded:-0}" -gt 0 ]; then
                    step_emit "22e" "fail" "Step 22e: Fuzz-weaver"
                    error "  Fuzz-weaver: FAIL — ${_fuzz_grounded} confirmed vulnerability/vulnerabilities (verified by actually running the agent's own test against the real code)"
                    failed=1
                    # fuzz_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$fuzz_log")
                    _log_labels+=("fuzz-weaver")
                else
                    step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "unverified findings downgraded"
                    warning "  Fuzz-weaver: FAIL verdict downgraded to WARN — no vulnerability finding could be verified by executing a real test against the real code (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$fuzz_log" 2>/dev/null; then
                step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "gaps>30%"
            warning "  Fuzz-weaver: WARN — coverage gaps > 30% (non-blocking)"
            else
                step_emit "22e" "pass" "Step 22e: Fuzz-weaver"
                success "  Fuzz-weaver: PASS"
            fi
        fi

        if [ $perf_exit -ne 0 ]; then
            # exit 1 means _run_qa_gate_with_retry exhausted all retries with no
            # structured output — the model produced nothing parseable. Treat as
            # non-blocking warn: a gate that couldn't run is NOT a confirmed failure.
            # Only a grounded "verdict":"fail" in the log (exit 0 path below) blocks.
            step_emit "22f" "warn" "Step 22f: Perf sentinel" "no structured output — non-blocking warn"
            warning "  Perf-sentinel: no structured output after all retries — treating as non-blocking warn"
            perf_exit=0
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$perf_log" 2>/dev/null; then
                # Ground-truth check: a "fail" is only valid if the agent found real blocker
                # findings. An agent with no tool access reports verdict:fail with empty findings
                # and null/zero summary — downgrade these hallucinated fails to WARN.
                # Full agent audit, 2026-07-31: the old check only verified the
                # agent's OWN summary numbers were internally self-consistent
                # (blockerCount>0 and filesAnalysed>0/blockerCount>0) — never
                # confirmed the claimed hotspot actually exists in the named
                # file at the named line. An agent could hallucinate a
                # self-consistent blocker and it would pass grounding and
                # block a clean pipeline. Now requires, for at least one
                # blocker finding: the referenced file exists on disk AND its
                # codeSnippet is a literal substring of that file's real
                # content — same "quote it, then we verify the quote"
                # pattern already used for the code-graph-detective's
                # brokenLine field.
                _perf_grounded=$(python3 "$SCRIPT_DIR/lib/handlers/perf.py" "$perf_log" "$PROJECT_ROOT" 2>/dev/null || echo "0")
                if [ "${_perf_grounded:-0}" -gt 0 ]; then
                    step_emit "22f" "fail" "Step 22f: Perf sentinel"
                    error "  Perf-sentinel: FAIL — confirmed performance blocker (codeSnippet verified against the real file)"
                    failed=1
                    # perf_exit=0 here (agent exited clean) so _failing_logs won't pick it up
                    # via the exit-code check below — add it explicitly so remediation fires.
                    _failing_logs+=("$perf_log")
                    _log_labels+=("perf-sentinel")
                else
                    step_emit "22f" "warn" "Step 22f: Perf sentinel" "unverified findings downgraded"
                    warning "  Perf-sentinel: FAIL verdict downgraded to WARN — no blocker finding's codeSnippet could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$perf_log" 2>/dev/null; then
                step_emit "22f" "warn" "Step 22f: Perf sentinel" "concerns non-blocking"
                warning "  Perf-sentinel: WARN — performance concerns (non-blocking)"
            else
                step_emit "22f" "pass" "Step 22f: Perf sentinel"
                success "  Perf-sentinel: PASS"
            fi
        fi
    else
        step_emit "22e" "skip" "Step 22e: Fuzz-weaver" "Phase A/B failed"
step_emit "22f" "skip" "Step 22f: Perf sentinel" "Phase A/B failed"
        info "  Phase C (fuzz-weaver + perf-sentinel) skipped — earlier phases had failures"
    fi

    # ── Step 4.6: Browser E2E routing execution (Lightpanda / Playwright) ──
    if [ $failed -eq 0 ]; then
        run_browser_e2e_routing
    else
        info "  Step 4.6: Skipped — earlier testing phases failed"
    fi

    # Recalculate duration to include all phases
    end_ts=$(date +%s%3N 2>/dev/null || date +%s)
    duration_ms=$(( end_ts - start_ts ))

    # Log gate result to JSONL
    local verdict="pass"
    [ $failed -ne 0 ] && verdict="fail"
    echo "{\"timestamp\":\"$(date -Iseconds)\",\"phase_id\":\"$phase_id\",\"event\":\"testing_gate\",\"sast_exit\":$sast_exit,\"spec_exit\":$spec_exit,\"review_exit\":$review_exit,\"mutant_exit\":$mutant_exit,\"fuzz_exit\":$fuzz_exit,\"perf_exit\":$perf_exit,\"verdict\":\"$verdict\",\"duration_ms\":$duration_ms,\"routingDecision\":\"$routing_decision\",\"routingReason\":\"$routing_reason\",\"forceLightpanda\":$force_lightpanda,\"forcePlaywright\":$force_playwright,\"e2eRouteRuns\":$e2e_route_runs,\"e2eRouteLightpanda\":$e2e_route_lightpanda,\"e2eRoutePlaywright\":$e2e_route_playwright,\"e2eRouteFailures\":$e2e_route_failed}" >> "$gate_jsonl"

    echo "=== Testing Gate Result: $([ $failed -eq 0 ] && echo PASS || echo FAIL) ===" >> "$gate_log"

    "$SCRIPT_DIR/update-monitor.sh" event "testing_gate_${verdict}" \
        "Testing gates $verdict for $phase_id (${duration_ms}ms)" "" "main" "test-coordinator-agent" 2>/dev/null || true

    if [ $failed -ne 0 ]; then
        # ── Self-healing: three-agent pipeline feeds gate findings back into PRD + profiles ──
        # Agent 1 (gate-finding-analyst):  extracts grounded structured finding from gate log
        # Agent 2 (story-ac-remediator):   augments the owning story's ACs in PRD
        # Agent 3 (profile-augmentor):     appends novel anti-pattern to the relevant profile

        # Collect all failing gate logs for this phase. _failing_logs/_log_labels
        # were already declared at the top of this function (not re-declared here
        # with `local`, which would wipe the content-based-failure appends made
        # during each gate's own evaluation above) — this only adds the
        # complementary case of a genuine agent-process crash (exit code != 0),
        # which is mutually exclusive with the content-based appends since those
        # only run in the exit-code-0 branch.
        [ "${sast_exit:-0}"   -ne 0 ] && _failing_logs+=("$sast_log")   && _log_labels+=("sast-sentinel")
        [ "${spec_exit:-0}"   -ne 0 ] && _failing_logs+=("$spec_log")   && _log_labels+=("spec-validator")
        [ "${review_exit:-0}" -ne 0 ] && _failing_logs+=("$review_log") && _log_labels+=("review-ranger")
        [ "${mutant_exit:-0}" -ne 0 ] && _failing_logs+=("$mutant_log") && _log_labels+=("mutant-hunter")
        [ "${fuzz_exit:-0}"   -ne 0 ] && _failing_logs+=("$fuzz_log")   && _log_labels+=("fuzz-weaver")
        [ "${perf_exit:-0}"   -ne 0 ] && _failing_logs+=("$perf_log")   && _log_labels+=("perf-sentinel")

        local _profiles_file="${EPAM_AGENTS_DIR:-${AUTOMATION_DIR}/agents}/profiles.json"

        if ! is_truthy "${SKIP_GATE_REMEDIATION:-}" && [ ${#_failing_logs[@]} -gt 0 ]; then
            warning "Step 4.2: Testing gates FAILED — running self-healing remediation pipeline..."
            local _remediation_applied=0
            # Set when profile-augmentor successfully (reviewer-approved) updates
            # the OFFENDING story's own agentRole profile — a genuine "the agent
            # who'll rewrite this code now has new guidance" signal, just as
            # real as an AC addition, and must retry the same way (found live,
            # 2026-07-09: this used to be silently dropped, so a successful
            # profile fix — the more common outcome of this pipeline in
            # practice — never led to a retry, only a hard stop).
            local _profile_remediation_applied=0
            local _rem_log="$LOG_DIR/gate-remediation-${phase_id}.log"

            for i in "${!_failing_logs[@]}"; do
                local _glog="${_failing_logs[$i]}"
                local _glabel="${_log_labels[$i]}"
                [ -f "$_glog" ] || continue

                info "  [gate-finding-analyst] Extracting grounded finding from ${_glabel} log..."

                # ── Agent 1: gate-finding-analyst ──────────────────────────────────
                # Reads gate log + PRD, emits JSON { gate, story_id, file, line, rule, message, suggested_fix }
                local _finding_prompt
                # RENDERED FROM THE TEMPLATE LAYER. The role instructions come from the project's own
                # profiles, supplied as a VALUE — they used to be a command substitution piping
                # profiles.json through python inside the heredoc, which fails to an empty string in
                # silence, so the agent could be given no role at all and nothing would say so.
                local _fp_vals; _fp_vals=$(mktemp "${TMPDIR:-/tmp}/gate-finding-analyst-vals-XXXXXX.json")
                local _fp_role; _fp_role=$(jq -r --arg r "gate-finding-analyst" '.[$r] // ""' "$_profiles_file" 2>/dev/null || echo "")
                jq_vals --arg profile "$_fp_role" \
                      --arg gate_label "$_glabel" \
                      --arg gate_log "$_glog" \
                      --arg prd_file "$PRD_FILE" \
                      --arg phase_id "$phase_id" \
                      '{"__PROFILE__":$profile,"__GATE_LABEL__":$gate_label,"__GATE_LOG__":$gate_log,"__PRD_FILE__":$prd_file,"__PHASE_ID__":$phase_id}' > "$_fp_vals"
                _finding_prompt="$(render_engine_prompt gate-finding-analyst "$_fp_vals")"
                rm -f "$_fp_vals"
                local _finding_json="" _gfa_attempt=0
                while [ "$_gfa_attempt" -lt 2 ] && [ -z "$_finding_json" ]; do
                    local _gfa_prompt="$_finding_prompt"
                    local _gfa_model
                    _gfa_model="$(seam_model_or_fail "gate-finding-analyst")"
                    if [ "$_gfa_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _gfa_model="${ESCALATION_MODEL_HIGH}"
                        _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                        jq_vals \
                              --arg finding_prompt "$_finding_prompt" \
                              --arg glog "${_glog}" \
                              '{"__FINDING_PROMPT__":$finding_prompt,"__GLOG__":$glog}' > "$_rp_vals"
                        _gfa_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" gate_finding_analyst)"
                        rm -f "$_rp_vals"
                    fi
                    local _gfa_raw
                    # Set for the child process invoked below, or for a script that sources this file. The
                    # analyser cannot see the consumer, so it reports these unused; removing them takes the value away.
                    # shellcheck disable=SC2034
                    # NO PROVIDER DEFAULT. This read `:-minimax`, which no configuration
                    # the literal was both unreachable in practice and wrong when reached,
                    # and routing the same model through another provider is a different
                    # setup, not a detail (MiniMax direct vs via a gateway differed 99.8%
                    # on cache hits alone). Unset now fails loudly in ai-run.sh instead.
                    #
                    # ONE COMMAND. That comment sat between a continuation line and the rest of
                    # the command, so `AI_GATE_ALLOW_TOOLS=1` stood alone as the whole of the
                    # pipeline's right-hand side — it received the prompt on stdin and did
                    # nothing with it — and the runner below ran as a separate command with no
                    # prompt and no tool grant (found 2026-09-14 with the pre-phase assessment's
                    # export, the same defect).
                    _gfa_raw=$(echo "$_gfa_prompt" | \
                        AI_GATE_ALLOW_TOOLS=1 \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-}" \
                        AI_MODEL="${_gfa_model}" \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        CLAUDE_CMD="$CLAUDE_CMD" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-}" \
                            --model    "${_gfa_model}" \
                        2>&1 | tee -a "$_rem_log")
                    if [ -n "$_gfa_raw" ]; then
                        _finding_json="$_gfa_raw"
                    else
                        [ "$_gfa_attempt" -lt 1 ] && warning "  [gate-finding-analyst] attempt 1 returned no output — retrying with escalated model" || warning "  [gate-finding-analyst] all 2 attempts returned no output"
                    fi
                    _gfa_attempt=$(( _gfa_attempt + 1 ))
                done
                if [ -z "$_finding_json" ]; then
                    warning "  [gate-finding-analyst] returned no output after 2 attempt(s) — skipping remediation for ${_glabel}"
                    continue
                fi

                # Check analyst returned a grounded finding (has story_id and rule)
                local _story_id
                _story_id=$(echo "$_finding_json" | python3 "$SCRIPT_DIR/lib/handlers/story-id.py" 2>/dev/null || true)

                if [ -z "$_story_id" ] || [ "$_story_id" = "null" ]; then
                    # Deterministic fallback (found live 2026-07-08): the analyst
                    # can't ground a finding into a story_id when the finding's
                    # `file` isn't listed in any story's technicalNotes.files —
                    # e.g. shared scaffold config (tsconfig.json, package.json)
                    # that no single story "owns" on paper. But every file that
                    # was ever actually written IS attributable, deterministically,
                    # via git: post-story commits always use the exact message
                    # "<id>: story complete (N file(s))" — ticket ID leads,
                    # colon-separated, to satisfy commit-message linters that
                    # require it there (see claude.sh's post-story commit
                    # step). Ask git who last touched the finding's file
                    # instead of asking the LLM to guess.
                    local _gf_file
                    # A gate log with more than one "file" match SIGPIPEs grep when head -1 exits.
                    local _gf_matches
                    _gf_matches=$(grep -o '"file"[[:space:]]*:[[:space:]]*"[^"]*"' "$_glog" 2>/dev/null || true)
                    _gf_file=$(head -1 <<< "$_gf_matches" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
                    if [ -n "$_gf_file" ] && [ -f "$_gf_file" ]; then
                        local _gf_commit_subject
                        _gf_commit_subject=$(git -C "$PROJECT_ROOT" log --follow -1 --format=%s -- "$_gf_file" 2>/dev/null || echo "")
                        _story_id=$(echo "$_gf_commit_subject" | grep -oP '^\K[^:]+(?=: story complete)' 2>/dev/null || echo "")
                    fi
                    if [ -z "$_story_id" ]; then
                        warning "  [gate-finding-analyst] No grounded finding for ${_glabel} — skipping remediation for this gate"
                        continue
                    fi
                    info "  [gate-finding-analyst] LLM could not ground the finding, but git history attributes ${_gf_file} to: ${_story_id}"
                fi
                info "  [gate-finding-analyst] Finding mapped to story: ${_story_id}"

                # The story's OWN agentRole — ground truth for which agent
                # actually wrote the offending code, used below by
                # profile-augmentor instead of guessing from the gate name
                # (found live, 2026-07-09: profile-augmentor's own prompt
                # hardcoded a static "sast-sentinel finding -> typescript-
                # engineer profile" table, which only happens to be right
                # when the story's real role IS typescript-engineer — for
                # any other role, it silently updates a profile no agent
                # who touches this story will ever read).
                local _story_agent_role
                _story_agent_role=$(jq -r --arg id "$_story_id" \
                    '.stories[] | select(.id == $id) | .agentRole // ""' \
                    "$PRD_FILE" 2>/dev/null || echo "")

                # ── Agent 2: story-ac-remediator ───────────────────────────────────
                # Reads the finding JSON + PRD, proposes ACs for the owning story.
                #
                # Deterministic-apply, NOT agent-tool-write (fixed 2026-07-11, after
                # a live run: the agent's own response contained a well-formed
                # {"acs_added":2,"acs":[...]} with genuinely concrete, verifiable ACs
                # for a real tsconfig.json typo -- but the PRD was never actually
                # updated (confirmed directly via jq afterward), because the prior
                # version trusted the agent's own tool call (AI_GATE_ALLOW_TOOLS=1,
                # instructed to "write the updated PRD back to the file") instead of
                # applying the change ourselves. An LLM narrating "I wrote the file"
                # in its final text response is not the same as it having actually
                # called a write tool -- same class of bug already fixed for
                # run_plan_mode and run_pre_phase_assessment. This now mirrors the
                # Step 3.8 lint-gate remediator just above, which already applies ACs
                # deterministically in Python rather than trusting the agent to.
                info "  [story-ac-remediator] Augmenting ACs for story ${_story_id}..."
                local _ac_prompt
                # RENDERED FROM THE TEMPLATE LAYER. The role instructions come from the project's own
                # profiles, supplied as a VALUE — they used to be a command substitution piping
                # profiles.json through python inside the heredoc, which fails to an empty string in
                # silence, so the agent could be given no role at all and nothing would say so.
                local _fp_vals; _fp_vals=$(mktemp "${TMPDIR:-/tmp}/story-ac-remediator-vals-XXXXXX.json")
                local _fp_role; _fp_role=$(jq -r --arg r "story-ac-remediator" '.[$r] // ""' "$_profiles_file" 2>/dev/null || echo "")
                jq_vals --arg profile "$_fp_role" \
                      --arg finding_json "$_finding_json" \
                      --arg story_id "$_story_id" \
                      --arg existing_acs "$(jq -c --arg id "$_story_id" '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | map(.)' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")" \
                      '{"__PROFILE__":$profile,"__FINDING_JSON__":$finding_json,"__STORY_ID__":$story_id,"__EXISTING_ACS__":$existing_acs}' > "$_fp_vals"
                _ac_prompt="$(render_engine_prompt story-ac-remediator "$_fp_vals")"
                rm -f "$_fp_vals"
                local _ac_result="" _acr_attempt=0
                while [ "$_acr_attempt" -lt 2 ] && [ -z "$_ac_result" ]; do
                    local _acr_prompt="$_ac_prompt"
                    local _acr_model
                    _acr_model="$(seam_model_or_fail "story-ac-remediator")"
                    if [ "$_acr_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _acr_model="${ESCALATION_MODEL_HIGH}"
                        _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                        jq_vals \
                              --arg ac_prompt "$_ac_prompt" \
                              '{"__AC_PROMPT__":$ac_prompt}' > "$_rp_vals"
                        _acr_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" ac_remediator)"
                        rm -f "$_rp_vals"
                    fi
                    local _acr_raw
                    _acr_raw=$(echo "$_acr_prompt" | \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-}" \
                        AI_MODEL="${_acr_model}" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-}" \
                            --model    "${_acr_model}" \
                        2>&1 | tee -a "$_rem_log")
                    if [ -n "$_acr_raw" ]; then
                        _ac_result="$_acr_raw"
                    else
                        [ "$_acr_attempt" -lt 1 ] && warning "  [story-ac-remediator] attempt 1 returned no output — retrying with escalated model" || warning "  [story-ac-remediator] all 2 attempts returned no output — skipping AC augmentation for ${_story_id}"
                    fi
                    _acr_attempt=$(( _acr_attempt + 1 ))
                done

                local _ac_result_tmp
                _ac_result_tmp=$(mktemp)
                echo "$_ac_result" > "$_ac_result_tmp"
                local _acs_added
                _acs_added=$( ( flock -w 10 200 || { error "  [story-ac-remediator] Could not acquire lock on ${MAIN_PRD_FILE:-$PRD_FILE}"; return 1; }
                python3 "$SCRIPT_DIR/lib/handlers/ac-apply.py" "${MAIN_PRD_FILE:-$PRD_FILE}" "$_story_id" "$_ac_result_tmp" 2>/dev/null || echo 0
                ) 200>"${MAIN_PRD_FILE:-$PRD_FILE}.lock" )
                rm -f "$_ac_result_tmp"

                if [ "${_acs_added:-0}" -gt 0 ]; then
                    success "  [story-ac-remediator] ${_acs_added} AC(s) added to ${_story_id}"
                    _remediation_applied=1
                else
                    info "  [story-ac-remediator] No new ACs added (already covered or agent skipped)"
                fi

                # ── Agent 3: profile-augmentor ─────────────────────────────────────
                # Checks if the pattern is novel; if so, appends to the relevant profile
                #
                # KNOWN GAP (2026-07-11, file-locking pass): unlike every other
                # profiles.json/PRD writer in this file, this agent still has its
                # own Bash/WriteFile tool access (AI_GATE_ALLOW_TOOLS=1 below) and
                # writes profiles.json itself, mid-LLM-call -- that write can't be
                # wrapped in a shell-level flock the way the deterministic
                # story-ac-remediator/lint-gate/skills-audit writes above are,
                # since we don't control the exact moment the agent's own tool call
                # happens. Two parallel worktree stories both triggering this path
                # around the same time could still race on profiles.json (the disk-
                # verification check just below catches a NO-OP claim, but not a
                # genuine lost-update race between two real concurrent writes).
                # Converting this to the same deterministic-apply pattern used for
                # story-ac-remediator would close this gap; out of scope for this
                # pass.
                info "  [profile-augmentor] Checking if pattern is novel for profiles..."
                # Snapshot profiles.json before augmentor writes so reviewer can compare + revert
                local _profiles_before
                _profiles_before=$(cat "$_profiles_file" 2>/dev/null || echo "{}")
                local _prof_prompt
                # THE CHANGE, NOT A TAIL.
                #
                # This showed the reviewer the LAST 500 CHARACTERS of each version of a 148 KB
                # roster. JSON key order means the addendum it was asked to approve was almost
                # never in that window — the reviewer was judging a change it could not see,
                # and a truncation this arbitrary reads as evidence.
                #
                # A diff is the whole change and drops only what did not change, which is the
                # difference between summarising and cutting.
                local _profiles_change
                _profiles_change=$(diff <(printf '%s' "$_profiles_before") <(printf '%s' "$_profiles_after") 2>/dev/null || true)
                [ -z "$_profiles_change" ] && _profiles_change="(no textual difference between before and after)"
                # RENDERED FROM THE TEMPLATE LAYER. The role instructions come from the project's own
                # profiles, supplied as a VALUE — they used to be a command substitution piping
                # profiles.json through python inside the heredoc, which fails to an empty string in
                # silence, so the agent could be given no role at all and nothing would say so.
                local _fp_vals; _fp_vals=$(mktemp "${TMPDIR:-/tmp}/profile-augmentor-vals-XXXXXX.json")
                local _fp_role; _fp_role=$(jq -r --arg r "profile-augmentor" '.[$r] // ""' "$_profiles_file" 2>/dev/null || echo "")
                jq_vals --arg profile "$_fp_role" \
                      --arg finding_json "$_finding_json" \
                      --arg profiles_file "$_profiles_file" \
                      --arg story_id "$_story_id" \
                      --arg story_agent_role "$_story_agent_role" \
                      '{"__PROFILE__":$profile,"__FINDING_JSON__":$finding_json,"__PROFILES_FILE__":$profiles_file,"__STORY_ID__":$story_id,"__STORY_AGENT_ROLE__":$story_agent_role}' > "$_fp_vals"
                _prof_prompt="$(render_engine_prompt profile-augmentor "$_fp_vals")"
                rm -f "$_fp_vals"
                local _prof_result="" _pfa3_attempt=0 _pfa3_disk_changed=0
                local _profiles_after=""
                while [ "$_pfa3_attempt" -lt 2 ] && [ "$_pfa3_disk_changed" = "0" ]; do
                    local _pfa3_prompt="$_prof_prompt"
                    [ "$_pfa3_attempt" -ge 1 ] && _pfa3_prompt="RETRY (attempt 2): You claimed profile_updated:true but profiles.json is byte-identical to before your call — you did not actually write the file. Use WriteFile to write the updated profiles.json to ${_profiles_file} now, then emit the JSON summary.

$_prof_prompt"
                    _prof_result=$(echo "$_pfa3_prompt" | \
                        AI_GATE_ALLOW_TOOLS=1 \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-}" \
                        AI_MODEL="$(seam_model_or_fail "profile-augmentor")" \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_MAX_TOOL_CALLS="${PROFILE_AUGMENTOR_MAX_TOOL_CALLS:-10}" \
                        CLAUDE_CMD="$CLAUDE_CMD" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-}" \
                            --model    "$(seam_model_or_fail "profile-augmentor")" \
                        2>&1 | tee -a "$_rem_log")
                    if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true'; then
                        _profiles_after=$(cat "$_profiles_file" 2>/dev/null || echo "{}")
                        if [ "$_profiles_after" != "$_profiles_before" ]; then
                            _pfa3_disk_changed=1
                        else
                            [ "$_pfa3_attempt" -lt 1 ] && warning "  [profile-augmentor] Claimed profile_updated:true but profiles.json unchanged on disk — retrying with corrective note" || warning "  [profile-augmentor] Claimed profile_updated:true but profiles.json still unchanged on disk after 2 attempt(s) — treating as no-op, not applied"
                        fi
                    else
                        _pfa3_disk_changed=1
                    fi
                    _pfa3_attempt=$(( _pfa3_attempt + 1 ))
                done
                # If both attempts claimed profile_updated but disk never changed, skip this gate
                if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true' && [ "$_pfa3_disk_changed" = "0" ]; then
                    continue
                fi

                if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true'; then
                    # GROUNDING PRE-CHECK — is the proposed rule TRUE of this repo?
                    #
                    # The LLM reviewer below is handed the last 500 chars of
                    # profiles.json before/after, with no tools and no access to
                    # the repo under work. It cannot verify a claim about the
                    # codebase, only judge whether the wording looks reasonable.
                    # Live 2026-07-26 it approved a rule hardcoding
                    # `${file%.ts}.test.ts` for a codebase where every test is
                    # .spec.ts — encoding, as permanent guidance, the exact
                    # naming assumption that had blinded mutant-hunter, derived
                    # from a finding that was itself an artefact of a manifest
                    # bug. `.test.ts` is entirely plausible in isolation; it is
                    # false only against code the reviewer never sees.
                    #
                    # A file-convention claim is verifiable, so verify it. Runs
                    # first so an unfounded rule costs no LLM call, and fails
                    # OPEN on any error of its own.
                    # Guarded against unset SCRIPT_DIR/PROJECT_ROOT: this check
                    # must never be the reason remediation breaks.
                    local _pa_ground_lib="${SCRIPT_DIR:-}/lib/profile_rule_grounding.py"
                    if [ -n "${SCRIPT_DIR:-}" ] && [ -n "${PROJECT_ROOT:-}" ] && [ -f "$_pa_ground_lib" ]; then
                        local _pa_before_f _pa_after_f
                        _pa_before_f=$(mktemp); _pa_after_f=$(mktemp)
                        printf '%s' "$_profiles_before" > "$_pa_before_f"
                        printf '%s' "$_profiles_after"  > "$_pa_after_f"
                        # NOT piped into tee: `cmd | tee` yields TEE's exit
                        # status, so the rejection below would never fire. That
                        # pipe-masking is the same defect that made the
                        # repro-gate and review-escalation log a block without
                        # enforcing one.
                        local _pa_ground_out _pa_ground_rc=0
                        _pa_ground_out=$(python3 "$_pa_ground_lib" "$_pa_before_f" "$_pa_after_f" "${PROJECT_ROOT:-}" 2>&1) || _pa_ground_rc=$?
                        [ -n "$_pa_ground_out" ] && printf '%s\n' "$_pa_ground_out" >> "${LOG_DIR:-/tmp}/profile-grounding-${PHASE:-core}.log"
                        if [ "$_pa_ground_rc" -ne 0 ]; then
                            [ -n "$_pa_ground_out" ] && warning "  [profile-augmentor] $_pa_ground_out"
                            warning "  [profile-augmentor] Profile change REJECTED — it asserts a file convention this repo does not use; reverting profiles.json"
                            echo "$_profiles_before" > "$_profiles_file" 2>/dev/null || true
                            rm -f "$_pa_before_f" "$_pa_after_f"
                            continue
                        fi
                        rm -f "$_pa_before_f" "$_pa_after_f"
                    fi

                    # Reviewer gate — validate the change before accepting it
                    local _reviewer_profile
                    _reviewer_profile=$(echo "$_profiles_after" | \
                        python3 "$SCRIPT_DIR/lib/handlers/json-field.py" 'prd-change-reviewer' 2>/dev/null || echo "")
                    local _review_verdict="pass"  # fail-safe only when reviewer not configured
                    if [ -n "${ORCH_GATE_PROVIDER:-}" ] && [ -n "$_reviewer_profile" ]; then
                        local _pa_rev_raw="" _pa_rev_attempt=0
                        while [ "$_pa_rev_attempt" -lt 2 ] && [ -z "$_pa_rev_raw" ]; do
                            local _pa_corrective=""
                            [ "$_pa_rev_attempt" -gt 0 ] && _pa_corrective="CORRECTION: Your previous response did not contain parseable JSON with a verdict field. Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}

"
                            local _pa_model
                            _pa_model=$(seam_model_or_fail "prd-change-reviewer") || _pa_model=""
                            [ "$_pa_rev_attempt" -ge 1 ] && _pa_model=$(seam_next_model "prd-change-reviewer" "$_pa_model")
                            _pa_rev_raw=$(echo "${_pa_corrective}${_reviewer_profile}

                            $(_render_change_reviewer "gate-remediation" "profile_addendum" "THE CHANGE ITSELF (unified diff of the roster before and after):\n${_profiles_change}")" | \
                                AI_PROVIDER="${ORCH_GATE_PROVIDER:-}" \
                                AI_MODEL="${_pa_model}" \
                                EPAM_CLI="${EPAM_CLI:-epam}" \
                                "$AI_RUNNER_CMD" \
                                    --provider "${ORCH_GATE_PROVIDER:-}" \
                                    --model    "${_pa_model}" \
                                2>/dev/null | \
                                python3 "$SCRIPT_DIR/lib/handlers/run-testing-gates.py" 2>/dev/null || true)
                            _pa_rev_attempt=$(( _pa_rev_attempt + 1 ))
                        done
                        if [ "$_pa_rev_raw" = "pass" ] || [ "$_pa_rev_raw" = "fail" ]; then
                            _review_verdict="$_pa_rev_raw"
                        else
                            warning "  [profile-augmentor] Reviewer failed to produce a valid verdict after 2 attempt(s) — defaulting to fail (fail-safe)"
                            _review_verdict="fail"
                        fi
                    fi
                    if [ "$_review_verdict" = "fail" ]; then
                        warning "  [profile-augmentor] Profile change REJECTED by reviewer — reverting profiles.json"
                        echo "$_profiles_before" > "$_profiles_file" 2>/dev/null || true
                    else
                        success "  [profile-augmentor] Profile updated with new rule for ${_glabel} pattern (reviewer approved)"
                        _profile_remediation_applied=1
                    fi
                else
                    info "  [profile-augmentor] No profile update (pattern already covered)"
                fi

            done  # end per-gate loop

            if [ "$_remediation_applied" = "1" ] || [ "$_profile_remediation_applied" = "1" ]; then
                # Signal the caller (tier3 runner) to prd-remediate and retry the phase
                warning "Step 4.2: Remediation applied — caller should reset stories and retry phase"
                error "Step 4.2: Testing gates FAILED — remediation applied, retry required"
                error "  Remediation log: $_rem_log"
                error "  Bypass (skip remediation): SKIP_GATE_REMEDIATION=1 $0 --phase $phase_id"
                return 2  # exit code 2 = "remediated, retry the phase"
            fi
        fi

        error "Step 4.2: Testing gates FAILED — fix findings and re-run"
        error "  SAST log: $sast_log"
        error "  Spec log: $spec_log"
        error "  Bypass: SKIP_TESTING_GATES=true $0 --phase $phase_id"
        return 1
    fi

    success "Step 4.2: Testing gates PASSED"
    return 0
}

# ── _create_bug_fix_phase <vitest_output> <parent_phase> <bug_phase> <model> <provider> ──
# Writes BUG-* stories into PRD and registers them under implementationOrder[$bug_phase].
# Returns 1 if no failing files could be parsed.
_create_bug_fix_phase() {
    local vitest_output="$1"
    local parent_phase="$2"
    local bug_phase="$3"
    local model_override="$4"
    local provider_override="$5"

# _failure_is_tolerated <failing_file> <phase>
#
# WAS THIS ALREADY BROKEN BEFORE THE RUN TOUCHED IT? The regression guard records the codeline's
# pre-existing failures at run start, so later stages can tell "this change broke it" from
# "inherit what the codeline already had, never add to it". Exactly one consumer read that record
# — the regression DELTA gate — so a tolerated failure could still be parsed out of the test
# output and turned into a bug-fix story, putting a writer on a defect the run had already decided
# was not its business.
#
# The same file the delta gate reads. Tolerates nothing when there is no baseline (writer-only
# mode skips the guard), when the recorded set was UNSTABLE (it proved nothing), or when the file
# is unreadable — every one of those errs toward treating a failure as real.
_failure_is_tolerated() {
    local _f="${1:-}" _phase="${2:-}"
    [ -n "$_f" ] && [ -n "$_phase" ] || return 1
    local _bl="${LOG_DIR:-}/regression-guard-baseline-${_phase}.json"
    [ -f "$_bl" ] || return 1
    jq -e --arg f "$_f" '
        (.stable == true) and ((.failures // []) | index($f) != null)
    ' "$_bl" >/dev/null 2>&1
}

    local failing_files
    failing_files=$(_parse_failing_test_files "$vitest_output")
    if [ -z "$failing_files" ]; then
        error "  Could not parse failing test files from vitest output"
        return 1
    fi

    local seen_owners=""
    while IFS= read -r failing_file; do
        [ -z "$failing_file" ] && continue

        # A failure the run was told to tolerate is not this change's to fix. See
        # _failure_is_tolerated — same record the regression delta gate reads.
        if _failure_is_tolerated "$failing_file" "$parent_phase"; then
            info "  [bug-fix] $failing_file was already failing before this run (regression baseline) — not opening a story for it"
            continue
        fi

        local owner_story
        owner_story=$(jq -r --arg rel "$failing_file" --arg phase "$parent_phase" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories[] |
             select(.id as $id | $ids | index($id)) |
             select(.technicalNotes.files // [] | any(endswith($rel) or . == $rel)) |
             .id' \
            "$PRD_FILE" 2>/dev/null | head -1)

        if [ -z "$owner_story" ]; then
            warning "  No owner found for '$failing_file' — skipping"
            continue
        fi
        echo "$seen_owners" | grep -qw "$owner_story" && continue
        seen_owners="$seen_owners $owner_story"

        local bug_id="BUG-${owner_story}-${bug_phase}"
        # Root cause this fixes (2026-07-09 pipeline audit): a 45-line cap
        # (grep -A 40 + head -45) on the failure excerpt fed into the bug-fix
        # story's own description risked truncating a genuinely long test
        # failure (multiple assertion failures for the same file, or a long
        # stack trace) before the actual root cause ever appeared — the
        # bug-fix story would then be given an incomplete picture of what's
        # broken. Cap raised substantially; truncation (if it still happens)
        # is now an explicit marker, not silent.
        local failure_excerpt _failure_excerpt_full _failure_excerpt_lines
        _failure_excerpt_full=$(echo "$vitest_output" | grep -A 150 "$failing_file")
        _failure_excerpt_lines=$(printf '%s\n' "$_failure_excerpt_full" | wc -l)
        if [ "$_failure_excerpt_lines" -gt 150 ]; then
            # HERESTRING, NOT A PIPE. `printf ... | head -150` kills this script: head takes its
            # lines and exits, printf gets SIGPIPE and dies 141, pipefail promotes it and set -e
            # ends the run -- silently. Measured at 141; it is what killed run 5 in the reviewer.
            failure_excerpt=$(head -n "$(evidence_window failureExcerptLines)" <<< "$_failure_excerpt_full")
            failure_excerpt="${failure_excerpt}
[TRUNCATED — ${_failure_excerpt_lines} total lines, only the first 150 shown.]"
        else
            failure_excerpt="$_failure_excerpt_full"
        fi

        local story_model story_provider
        if [ -n "$model_override" ]; then
            story_model="$model_override"
            story_provider="$provider_override"
        else
            # THE OWNER'S OWN MODEL, then the WRITER'S LADDER — never a vendor name written
            # here. The literals meant a story that declared no model was silently written by
            # whatever the engine happened to name, on whatever provider the engine happened to
            # name, regardless of what the project configured.
            story_model=$(jq -r --arg id "$owner_story" \
                '.stories[] | select(.id == $id) | .model // empty' \
                "$PRD_FILE" 2>/dev/null)
            [ -n "$story_model" ] || story_model=$(seam_model_or_fail "story-writer") || story_model=""
            story_provider=$(jq -r --arg id "$owner_story" \
                '.stories[] | select(.id == $id) | .aiProvider // empty' \
                "$PRD_FILE" 2>/dev/null)
        fi

        local owner_notes
        # THE OWNER'S ROLE, inherited like its model and provider. A bug fix belongs to whoever
        # owns the code it is fixing; naming a role here assigns work to an agent this project may
        # never have minted.
        owner_role=$(jq -r --arg id "$owner_story" \
            '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
        [ -n "$owner_role" ] || owner_role="unassigned"

        # THE BUG-FIX STORY'S TITLE AND INSTRUCTIONS COME FROM THE TEMPLATE LAYER. They were shell
        # literals, and the writer that picks this story up reads the description AS ITS PROMPT — so
        # a prompt was living in this script where no prompt review reaches. The test runner is a
        # fact of the codeline, not of the engine: the literal here named vitest, which told a Rust
        # or Python writer to fix tests for a runner that codeline has never run.
        _bug_test_cmd=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$PROJECT_ROOT" 2>/dev/null \
            | jq -r '.testCommand // ""' 2>/dev/null || echo "")
        [ -n "$_bug_test_cmd" ] || _bug_test_cmd="<this codeline declares no test command>"

        # ONE VALUES FILE PER BODY. The renderer rejects a value the body does not use — a value
        # nobody reads means the caller believes it supplied something that had no effect — and the
        # title uses only the filename.
        _bug_vals=$(mktemp "${TMPDIR:-/tmp}/bug-story-vals-XXXXXX.json")
        _bug_vals_t=$(mktemp "${TMPDIR:-/tmp}/bug-story-title-XXXXXX.json")
        jq_vals --arg f "$failing_file" --arg tc "$_bug_test_cmd" --arg ex "$failure_excerpt" \
            '{__FAILING_FILE__: $f, __TEST_COMMAND__: $tc, __FAILING_TESTS__: $ex}' > "$_bug_vals"
        jq_vals --arg f "$failing_file" '{__FAILING_FILE__: $f}' > "$_bug_vals_t"

        # Exit status is the contract: an unrendered story would be appended to the PRD with an
        # empty description, and the writer would answer from nothing.
        if ! bug_title=$(render_engine_prompt "bug-fix-story" "$_bug_vals_t" "title") \
           || ! bug_desc=$(render_engine_prompt "bug-fix-story" "$_bug_vals" "prompt"); then
            rm -f "$_bug_vals" "$_bug_vals_t"
            error "[orch] could not render the bug-fix story for $failing_file — not appending an empty story to the PRD"
            return 1
        fi
        rm -f "$_bug_vals" "$_bug_vals_t"

        owner_notes=$(jq -c --arg id "$owner_story" \
            '.stories[] | select(.id == $id) | .technicalNotes' \
            "$PRD_FILE" 2>/dev/null || echo '{}')

        local tmp_prd
        tmp_prd=$(mktemp)
        chmod 644 "$tmp_prd" 2>/dev/null
        jq \
            --arg bid "$bug_id" \
            --arg model "$story_model" \
            --arg provider "$story_provider" \
            --arg ownerRole "$owner_role" \
            --arg title "$bug_title" \
            --arg desc "$bug_desc" \
            --arg phase "$bug_phase" \
            --arg ffile "${PROJECT_ROOT}/${failing_file}" \
            --argjson onotes "$owner_notes" \
            '
            .stories += [{
                id: $bid,
                title: $title,
                description: $desc,
                status: "pending",
                completed: false,
                aiProvider: $provider,
                model: $model,
                agentRole: $ownerRole,
                unitTests: false,
                technicalNotes: ($onotes + {
                    files: [$ffile],
                    testCommand: "echo '\''tests deferred to Step 4.5 unit test gate'\''"
                })
            }] |
            .implementationOrder[$phase] = ((.implementationOrder[$phase] // []) + [$bid])
            ' "$PRD_FILE" > "$tmp_prd" && mv "$tmp_prd" "$PRD_FILE"

        log "  Created bug story: $bug_id ($provider_override$story_provider / $model_override$story_model)"
    done <<< "$failing_files"

    [ -z "$seen_owners" ] && return 1
    return 0
}

# ── _emit_unfixed_bug_list <vitest_output> ────────────────────────────────────
# Structured output printed when Sonnet escalation did not resolve failures.
_emit_unfixed_bug_list() {
    local vitest_output="$1"
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  UNFIXED BUGS — survived Sonnet escalation               ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    # Failing test files
    _parse_failing_test_files "$vitest_output" | while read -r line; do
        echo "  FILE  $line"
    done
    echo ""
    # Individual failing test names
    echo "$vitest_output" | grep -E '^ ❯ .* > ' | while read -r line; do
        echo "  TEST  $line"
    done
    echo ""
    # Top-level error messages
    echo "$vitest_output" | grep -E '^ +→ ' | while read -r line; do
        echo "  WHY   $line"
    done
    echo ""
}

# ── run_unit_tests_gate <phase_id> ────────────────────────────────────────────
# Step 4.5: Run vitest + tsc after all phase stories complete.
# On failure: creates BUG-* stories, runs them through the full pipeline
# (openspec → story agent → QA gates) in a bug_fix sub-phase.
# Round 1 uses the original story model; round 2 escalates to
# ESCALATION_MODEL (same model the InferenceLadder uses, default z-ai/glm-5.2)
# via the openrouter (OpenRouter) provider.
# If the escalated model cannot fix it → hard fail with structured bug list.
# UNIT_TEST_BUG_DEPTH env var prevents recursive bug story creation.
run_unit_tests_gate() {
    local phase_id="$1"
    local gate_log="$LOG_DIR/unit-test-gate-${phase_id}.log"
    local bug_depth="${UNIT_TEST_BUG_DEPTH:-0}"

    if is_truthy "${SKIP_UNIT_TEST_GATE:-}"; then
        info "Step 4.5: Unit test gate skipped (SKIP_UNIT_TEST_GATE=true)"
        return 0
    fi

    local phase_has_unit_tests
    phase_has_unit_tests=$(jq -r --arg phase "$phase_id" \
        '(.implementationOrder[$phase] // []) as $ids |
         [.stories[] | select(.id as $id | $ids | index($id)) | select(.unitTests == true)] | length' \
        "$PRD_FILE" 2>/dev/null || echo "0")
    if [ "${phase_has_unit_tests:-0}" -eq 0 ]; then
        info "Step 4.5: No unit-test stories in phase '$phase_id' — skipping unit test gate"
        return 0
    fi

    # THE ECOSYSTEM DECIDES, AND "CANNOT RUN" IS NOT A PASS.
    #
    # This checked for package.json and returned 0 — so on any codeline that is not Node, the unit
    # test gate reported SUCCESS for stories that explicitly declare unitTests:true, having run
    # nothing. Below it hardcoded `npm install` and then REQUIRED node_modules/.bin/vitest, so a
    # Node project using any other runner hard-failed instead.
    # TWO CAUSES, TWO MESSAGES. An empty test command can mean the PROJECT declares none, or that
    # the ENGINE could not ask — an unresolvable handler path, a missing node. Those are fixed by
    # different people in different files, and collapsing them into one message blames the
    # customer's repository for the engine's own failure.
    local _ut_facts _ut_facts_rc=0 _ut_test_cmd _ut_install_cmd _ut_install_dir
    _ut_facts=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$PROJECT_ROOT" 2>/dev/null) || _ut_facts_rc=$?
    if [ "$_ut_facts_rc" -ne 0 ] || [ -z "$_ut_facts" ]; then
        error "Step 4.5: could not read the ecosystem of ${PROJECT_ROOT} (codeline-ecosystem.js exited ${_ut_facts_rc})."
        error "  This is an engine fault, not a fact about the project — refusing to certify unit tests that were never run."
        return 1
    fi
    _ut_test_cmd=$(printf '%s' "$_ut_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" testCommand 2>/dev/null || echo "")
    _ut_install_cmd=$(printf '%s' "$_ut_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" installCommand 2>/dev/null || echo "")
    _ut_install_dir=$(printf '%s' "$_ut_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" installDir 2>/dev/null || echo "")

    if [ -z "$_ut_test_cmd" ]; then
        error "Step 4.5: ${phase_id} has stories declaring unitTests:true, but ${PROJECT_ROOT} declares no way to run its tests."
        error "  The gate cannot verify them and will not report that as a pass. Declare a test command for this codeline, or set unitTests:false on those stories."
        return 1
    fi

    local _node_bin
    _node_bin="$(detect_node)"
    if [ -z "$_node_bin" ]; then
        warning "Step 4.5: Node binary not found — skipping unit test gate"
        return 0
    fi

    echo "=== Unit Test Gate: $phase_id @ $(date -Iseconds) ===" > "$gate_log"
    log "Step 4.5: Running unit test gate for '$phase_id'..."

    # ── Ensure this ecosystem's dependencies are present before running its tests ─────────────
    if [ -n "$_ut_install_dir" ] && [ -n "$_ut_install_cmd" ] && [ ! -d "$PROJECT_ROOT/$_ut_install_dir" ]; then
        log "  ${_ut_install_dir} missing — running: ${_ut_install_cmd}"
        local install_output install_exit=0
        install_output=$(cd "$PROJECT_ROOT" && timeout "${EPAM_INSTALL_TIMEOUT_SECS:-180}" sh -c "$_ut_install_cmd" 2>&1) || install_exit=$?
        echo "$install_output" >> "$gate_log"
        if [ "$install_exit" -eq 124 ]; then
            error "  '${_ut_install_cmd}' TIMED OUT after ${EPAM_INSTALL_TIMEOUT_SECS:-180}s — cannot run the tests"
            echo "$install_output" | tail -20 >&2
            return 1
        fi
        if [ "$install_exit" -ne 0 ]; then
            error "  '${_ut_install_cmd}' failed — cannot run the tests"
            echo "$install_output" | tail -20 >&2
            return 1
        fi
        log "  '${_ut_install_cmd}' completed"
    fi

    # ── The project's own test command ────────────────────────────────────────
    # Was: require node_modules/.bin/vitest, then exec it directly. A Node project using jest,
    # mocha, node --test or anything else hard-failed here with "vitest may not be in
    # package.json" — a message about the engine's expectation, not about the project.
    log "  Running: ${_ut_test_cmd}"
    local vitest_output vitest_exit=0
    vitest_output=$(cd "$PROJECT_ROOT" && run_test_bounded "$(resolve_test_workers)" timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" sh -c "$_ut_test_cmd" 2>&1) || vitest_exit=$?
    echo "$vitest_output" >> "$gate_log"

    if [ "$vitest_exit" -eq 0 ]; then
        log "  Running the project's declared type check..."
        local tsc_exit=0
        # Bounded like the npm install and vitest calls above. tsc was the one unbounded
        # command in this gate, so a type-check that never returns hung the phase with no
        # watchdog over it.
        # `timeout` EXECS A BINARY — it cannot see a shell function, so wrapping
        # _run_project_verification directly made this fail with "command not found" on every
        # run, i.e. the gate's type check reported FAILED unconditionally. Re-entering bash with
        # the function exported keeps the bound (an unbounded type check hangs the phase with no
        # watchdog above it) while actually invoking the function.
        # AUTOMATION_DIR and NODE_CMD are carried EXPLICITLY. A child `bash -c` inherits only
        # EXPORTED variables, and both are ordinarily plain assignments — so without this the
        # child resolved an empty plugin path and the helper returned 2 ("plugin missing"),
        # reported as a type-check failure on a project that type-checks fine.
        export -f _run_project_verification
        cd "$PROJECT_ROOT" && \
            AUTOMATION_DIR="${AUTOMATION_DIR:-}" NODE_CMD="${NODE_CMD:-${NODE_BIN:-node}}" \
            timeout "${EPAM_TSC_TIMEOUT_SECS:-${EPAM_TEST_TIMEOUT_SECS:-300}}" \
            bash -c 'export AUTOMATION_DIR NODE_CMD; _run_project_verification "$1"' _ "$PROJECT_ROOT" \
            >> "$gate_log" 2>&1 || tsc_exit=$?
        if [ "$tsc_exit" -eq 0 ]; then
            success "Step 4.5: Unit test gate PASSED"
            "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                "Unit tests + type check passed" "" "main" "unit-test-runner" 2>/dev/null || true
            return 0
        fi
        error "  Type check FAILED (tsc) — not retryable via bug stories"
        error "Log: $gate_log"
        return 1
    fi

    error "  Unit tests FAILED (vitest)"
    "$SCRIPT_DIR/update-monitor.sh" event "unit_test_fail" \
        "Unit tests FAILED (vitest)" "" "main" "unit-test-runner" 2>/dev/null || true

    # ── If we are already inside a bug-fix phase, hard-fail immediately ────────
    if [ "$bug_depth" -ge 1 ]; then
        error "Step 4.5: Tests still failing inside bug-fix phase — escalation limit reached"
        _emit_unfixed_bug_list "$vitest_output"
        error "Log: $gate_log"
        return 1
    fi

    # ── Bug-fix rounds: round 1 = original model, round 2 = escalated model ───
    # Uses the same ESCALATION_MODEL as the InferenceLadder (claude.sh Rung 2/3)
    # rather than a separate hardcoded model/provider — this pipeline's model
    # roster is deliberately scoped to MiniMax + OpenRouter (kimi-k2/GLM); a
    # hardcoded Anthropic model here would be a third, inconsistent path.
    local bug_round model_override provider_override
    for bug_round in 1 2; do
        if [ "$bug_round" -eq 1 ]; then
            model_override=""
            provider_override=""
            log "Step 4.5: Creating bug fix stories (round $bug_round — original model)..."
        else
            # Round 2 climbs the WRITER'S OWN ladder rather than jumping to one run-wide
            # escalation model, and names no provider: the provider follows the model through
            # EPAM_MODEL_PROVIDER_MAP, which is where the project already declares it.
            model_override=$(seam_next_model "story-writer" "$(seam_model_or_fail "story-writer")")
            provider_override=""
            log "Step 4.5: Creating bug fix stories (round $bug_round — escalated model: ${model_override})..."
        fi

        local bug_phase="bug_fix_${phase_id}_r${bug_round}"

        _create_bug_fix_phase \
            "$vitest_output" "$phase_id" "$bug_phase" \
            "$model_override" "$provider_override" || {
            error "  Could not create bug fix stories — giving up"
            break
        }

        log "Step 4.5: Running bug fix phase '$bug_phase' through full pipeline..."
        UNIT_TEST_BUG_DEPTH=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
            --phase "$bug_phase" --reset \
            2>&1 | tee -a "$gate_log" || true

        # Re-run THE SAME COMMAND after the bug-fix phase completes. This still exec'd vitest
        # directly, so on a project using any other runner the verification of the fix ran a
        # different thing from the check that found the failure — or nothing at all.
        vitest_exit=0
        vitest_output=$(cd "$PROJECT_ROOT" && run_test_bounded "$(resolve_test_workers)" timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" sh -c "$_ut_test_cmd" 2>&1) || vitest_exit=$?
        echo "=== Post-bug-fix test run (round $bug_round): ${_ut_test_cmd} ===" >> "$gate_log"
        echo "$vitest_output" >> "$gate_log"

        if [ "$vitest_exit" -eq 0 ]; then
            log "  Running the project's declared type check..."
            tsc_exit=0
            _run_project_verification "$PROJECT_ROOT" >> "$gate_log" 2>&1 || tsc_exit=$?
            if [ "$tsc_exit" -eq 0 ]; then
                success "Step 4.5: Unit test gate PASSED after bug fix round $bug_round"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                    "Unit tests passed after bug fix round $bug_round" "" "main" "unit-test-runner" 2>/dev/null || true
                return 0
            fi
            error "  Type check FAILED (tsc) after bug fix round $bug_round — not retryable"
            return 1
        fi

        error "  Tests still failing after bug fix round $bug_round"
    done

    # ── Both rounds exhausted — emit structured list ───────────────────────────
    _emit_unfixed_bug_list "$vitest_output"
    error "Step 4.5: Unit test gate FAILED — Sonnet could not fix remaining bugs"
    error "Bypass (non-code phases): SKIP_UNIT_TEST_GATE=true $0 --phase $phase_id"
    error "Log: $gate_log"
    return 1
}
