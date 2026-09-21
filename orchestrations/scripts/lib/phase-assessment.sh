#!/usr/bin/env bash
# phase-assessment.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (11 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# Minimal JSON string escaping for step_emit's label/reason fields — both can
# carry dynamic content (model names, story counts, gate verdict summaries)
# that may contain a literal quote or backslash and would otherwise produce
# malformed step-status.json.
_json_escape_str() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# review_feedback_is_incomplete
# True when the REVIEWER failed rather than the code being wrong. Re-running the
# review is the right answer then; re-implementing is not.
#
# B24 established this, but keyed only on review-incomplete-<phase>.flag or an
# empty feedback set. team-lead-review.sh has THREE unparseable-verdict paths:
# two write the flag, and one writes only a per-story
# review-feedback-<id>.json. Live metrolinx 2026-07-26 hit that third path, so
# the flag was absent AND the feedback count was 1 — both halves of the guard
# missed, and the pipeline re-implemented a fix the bug-reproduction gate had
# just proven correct, on "feedback" whose only content was that there was none.
#
# Keys on CONTENT (reviewIncomplete in the verdict) so it cannot depend on a
# side-channel filename matching across two scripts. Unreadable feedback counts
# as incomplete too: that is not evidence the code is wrong either. A single
# genuinely-reviewed story means real findings — the re-implementation loop is
# how over-engineering gets corrected and must not be disabled.
# THE STORIES A CHANGES-REQUESTED CYCLE RE-IMPLEMENTS. The set of review-feedback files is not the
# set of rejected stories: a file whose verdict says reviewIncomplete is a story the reviewer could
# not judge, and re-implementing it is re-implementing approved work against feedback whose only
# content is that there was none. regintel 140717Z (2026-09-21): three approved reviews arrived with
# their first bytes missing; beside ten real verdicts the loop advanced their ladders and rewrote them
# — REGI-004-A and REGI-010-A ended FAILED, 004-B blocked behind them. Prints one story id per line:
# only stories with a real verdict. Unreadable feedback is not evidence the code is wrong either.
review_feedback_to_reimplement() {
    local _f _id
    for _f in "$LOG_DIR"/review-feedback-*.json; do
        [ -f "$_f" ] || continue
        jq -e . "$_f" >/dev/null 2>&1 || continue
        [ "$(jq -r '.reviewIncomplete // false' "$_f" 2>/dev/null)" = "true" ] && continue
        _id="$(basename "$_f" | sed 's/^review-feedback-//; s/\.json$//')"
        printf '%s\n' "$_id"
    done
    return 0
}

review_feedback_is_incomplete() {
    [ -f "$LOG_DIR/review-incomplete-${PHASE}.flag" ] && return 0
    local _f _any=0
    for _f in "$LOG_DIR"/review-feedback-*.json; do
        [ -f "$_f" ] || continue
        _any=1
        if [ "$(jq -r '.reviewIncomplete // false' "$_f" 2>/dev/null)" != "true" ]; then
            # jq failed (unreadable) or the verdict is a real finding.
            jq -e . "$_f" >/dev/null 2>&1 || continue
            return 1
        fi
    done
    [ "$_any" -eq 0 ] && return 0
    return 0
}

run_orch_prompt_with_tools() {
    AI_GATE_ALLOW_TOOLS=1 EPAM_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS}" run_orch_prompt "$@"
}

# _epam_prompt_version — the epam-cli repo's own short git SHA, cached for
# the life of this process. Since the guarded-step prompts live embedded in
# these scripts (no separate template files), the commit hash of the script
# IS the version proxy — a violation-rate change in the history file (below)
# can be directly correlated to "what changed in this commit." Resolved
# relative to SCRIPT_DIR (this repo), never CWD/PROJECT_ROOT — for a tier3
# run PROJECT_ROOT is the EXTERNAL target project, not this repo.
_epam_prompt_version() {
    if [ -z "${_EPAM_PROMPT_VERSION:-}" ]; then
        _EPAM_PROMPT_VERSION=$(git -C "$SCRIPT_DIR/.." rev-parse --short HEAD 2>/dev/null || echo "unknown")
        export _EPAM_PROMPT_VERSION
    fi
    echo "$_EPAM_PROMPT_VERSION"
}

# ──────────────────────────────────────────────
# Step 0.5: Pre-phase skill assessment
# ──────────────────────────────────────────────
# _pfa_capability_failed <log> — did the agent exhaust its iteration cap?
#
# AgentRunner returns "Agent reached maximum iterations (N) without completing."
# as a NORMAL result with exit 0, so an agent that produced nothing is
# indistinguishable from one that succeeded unless someone reads the text.
# claude.sh, spec-mode-runner.js and brownfield-repro-test-writer.sh all check
# for it; the pre-phase assessment did not, and it is the most expensive call in
# the pipeline — 586K tokens and 57% of mock1 run 10, for 58 bytes saying it
# failed.
#
# Deliberately does NOT match the cap number: it is configurable, and a detector
# that only recognises 25 stops working the moment someone tunes it.
_pfa_capability_failed() {
    local _log="${1:-}"
    [ -n "$_log" ] && [ -s "$_log" ] || return 1
    grep -q "reached maximum iterations" "$_log" 2>/dev/null
}

run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    local profiles_backup="${profiles_file}.original"
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    # The canonical base. tier3-*-run.sh restores profiles.json FROM this file at
    # the start of every run, so this is the thing that actually propagates.
    #
    # It used to be created here silently on first use. Because it is created
    # once and only once, it snapshotted whatever profiles.json happened to hold
    # at that moment — by then already carrying another project's "Post-Spec
    # Skill Addendum" sections — and every run since restored that faithfully.
    # Months later a Metrolinx agent was being instructed to build a Skyscanner
    # API client. Cleaning profiles.json alone would have fixed nothing; the next
    # restore would have put it straight back.
    #
    # So: creating the canonical is now a LOUD, visible event, not a silent
    # side effect. It is a git-tracked file that should be curated deliberately
    # (see the standing rule: the canonical may be updated, but only as a
    # tracked, reviewed change). If it is missing, something deleted it, and
    # minting a new one from a possibly-mutated working copy is exactly how this
    # defect was born.
    if [ ! -f "$profiles_backup" ]; then
        warning "[pre-phase-assessment] canonical profiles missing: $profiles_backup"
        warning "  Creating it from the CURRENT profiles.json — if that file already carries"
        warning "  project-specific additions, they become canonical and every future run inherits them."
        warning "  Verify it, then commit it deliberately rather than leaving it as a run artefact."
        cp "$profiles_file" "$profiles_backup"
    fi

    log "Running pre-phase skill assessment for '$phase_id'..."

    # The output schema, bound at the provider rather than requested in prose.
    # Absent/malformed => AgentRunner warns and continues unbound, and
    # assessment_apply.py still recovers a JSON object from the answer.
    # ── Tool budget: ONE source, stated to the model AND enforced at the seam ──
    # This agent had neither. It got read tools and EPAM_MAX_ITERATIONS=25, and
    # nothing ever told it to stop exploring — so how many turns it spent was a
    # property of whichever repository the lane happened to draw. Live metrolinx
    # 2026-07-29 proved it: same prompt, same cap, gotransit and metrolinx
    # converged, upexpress exhausted. The agents that DO converge (the CodeGraph
    # detective, team-lead review) are the ones given a budget they can see.
    #
    # Both halves are required. A budget the model cannot see truncates it
    # mid-thought, and the response schema then returns a valid EMPTY object —
    # a loud failure turned silent, exactly as the note below this warns.
    local _pfa_tool_budget="${PRE_ASSESSMENT_MAX_TOOL_CALLS:-10}"
    local _pfa_schema=""
    _pfa_schema=$(python3 "$SCRIPT_DIR/lib/assessment_apply.py" --print-schema 2>/dev/null || echo "")

    # The facts, computed rather than discovered.
    #
    # Live AMSD-2041 run 4: turns=1, in=3,366, out=516 — the prompt alone is
    # ~2,100 tokens, so it never read the PRD, never ran find, never touched the
    # repo. It invented story IDs (core-1..core-6 for a phase containing exactly
    # AMSD-2041) and an "authorized" file list of four files that do not exist,
    # then told sast-sentinel to suppress everything else.
    #
    # Caused by fixing its previous failure: it used to burn 25 turns writing
    # files, and making it RETURN a decision removed the only thing that forced
    # it to look at anything. Removing the prompt's worked examples took away
    # what it fabricated WITH; this takes away the need to fabricate at all.
    local _pfa_facts=""
    if [ -f "$SCRIPT_DIR/lib/assessment_context.py" ]; then
        _pfa_facts=$(python3 "$SCRIPT_DIR/lib/assessment_context.py" \
            --prd "$PRD_FILE" --repo-root "$PROJECT_ROOT" --phase "$phase_id" 2>&1) || {
            warning "[pre-phase-assessment] fact injection failed — the agent has nothing to ground its answer in"
            _pfa_facts=""
        }
    fi

    # Build assessment prompt
    local assessment_prompt
    # shellcheck disable=SC2287
    local _pfa_facts_file; _pfa_facts_file=$(mktemp "${TMPDIR:-/tmp}/pfa-facts-XXXXXX.txt")
    printf '%s' "${_pfa_facts:-}" > "$_pfa_facts_file"
      # THE GLOBALS, NOT LOWERCASE NAMES THAT EXIST NOWHERE. `prd_rel` and `profiles_rel`
      # are assigned in no line of this script; the values live in PRD_REL and
      # PROFILES_REL, computed near the top. Reading the lowercase names handed the
      # renderer two empty strings, and it correctly refused to render an analyst that
      # would then report on files it had not been told about — killing both lanes in
      # the pre-phase skill assessment. One call site three lines below already used
      # the globals, which is why only these two failed.
    _ap_vals=$(mktemp "${TMPDIR:-/tmp}/post-failure-analyst-vals-XXXXXX.json")
    jq_vals \
          --rawfile pfa_facts "$_pfa_facts_file" \
          --arg pfa_tool_budget "$_pfa_tool_budget" \
          --arg phase_id "$phase_id" \
          --arg prd_rel "${PRD_REL}" \
          --arg profiles_rel "${PROFILES_REL}" \
          '{"__PFA_FACTS__":$pfa_facts,"__PFA_TOOL_BUDGET__":$pfa_tool_budget,"__PHASE_ID__":$phase_id,"__PRD_REL__":$prd_rel,"__PROFILES_REL__":$profiles_rel}' > "$_ap_vals"
    # The codeline's own facts — this template declares them and nothing supplied them.
    # Stack facts are the RENDERER's job — engine-prompt.js adds exactly the stack
    # placeholders this template DECLARES. Pre-merging all seven here made the
    # renderer throw "was given values it does not use" on every template that
    # declares fewer, and the caller reported "cannot render its prompt". Four
    # seams could not run at all, the fuzz-weaver among them.
    assessment_prompt="$(render_engine_prompt post-failure-analyst "$_ap_vals")"
    rm -f "$_ap_vals"
    rm -f "$_pfa_facts_file"

    # Append the phase-specific context
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/phase-assessment-header-vals-XXXXXX.json")
    jq_vals \
          --arg assessment_prompt "${assessment_prompt}" \
          --arg phase_id "${phase_id}" \
          --arg prd_rel "${PRD_REL}" \
          '{"__ASSESSMENT_PROMPT__":$assessment_prompt,"__PHASE_ID__":$phase_id,"__PRD_REL__":$prd_rel}' > "$_cp_vals"
    assessment_prompt="$(render_engine_prompt phase-assessment-header "$_cp_vals")"
    rm -f "$_cp_vals"

    # Fresh pre-call snapshot for reviewer diffing (profiles_backup is the
    # canonical original floor, not necessarily the immediately-prior state).
    local _pfa_profiles_before
    _pfa_profiles_before=$(cat "$profiles_file" 2>/dev/null || echo "{}")

    # PRD-side snapshot for the new field-allowlist checker/revert below.
    # Step 0.5 is only permitted to add new keys to profiles.json or change
    # agentRole/model/aiProvider/reasoningEffort on stories in THIS phase —
    # the same invariant already stated in assert_no_story_ids_lost's own
    # error text. Anything else (status flips, technicalNotes/AC rewrites,
    # story add/remove) is a violation worth retrying, not silently
    # accepting — this is the exact class of defect (found live 2026-07-12/
    # 13) that assert_no_story_ids_lost/assert_no_illegitimate_deprecation
    # could only detect and self-heal AFTER the fact; this loop tries to get
    # a correct answer from the model directly instead.
    local _pfa_prd_before_file
    _pfa_prd_before_file=$(mktemp)
    cp "$PRD_FILE" "$_pfa_prd_before_file"

    local _pfa_final_outcome="violated"
    local _pfa_attempt=0
    local _pfa_corrective_note=""

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): the prompt above
    # instructs the agent to run real jq commands against the PRD, read/write
    # profiles.json, and flock-append to JSONL files — without tool access the
    # agent can only print what it WOULD do, and no real change ever lands
    # (found live 2026-07-08, same class of bug already fixed for run_plan_mode
    # and claude.sh's run_pre_phase_assessment).
    for _pfa_attempt in 1 2 3; do
        local _pfa_prompt_this_attempt="$assessment_prompt"
        if [ -n "$_pfa_corrective_note" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/corrective-note-vals-XXXXXX.json")
            jq_vals \
                  --arg pfa_prompt_this_attempt "${_pfa_prompt_this_attempt}" \
                  --arg pfa_corrective_note "${_pfa_corrective_note}" \
                  '{"__PFA_PROMPT_THIS_ATTEMPT__":$pfa_prompt_this_attempt,"__PFA_CORRECTIVE_NOTE__":$pfa_corrective_note}' > "$_cp_vals"
            _pfa_prompt_this_attempt="$(render_engine_prompt corrective-note "$_cp_vals" phase_assessment)"
            rm -f "$_cp_vals"
        fi

        local _pfa_call_ok=1
        # No story_id — this is a phase-level assessment, not tied to any single
        # story. Passing "${PHASE:-unknown}" here previously polluted agent-activity's
        # story_id field with the phase name ("core"), making "stories touched" counts
        # wrong (a 1-story PRD showed 2 distinct story_id values: the real story + "core").
        # B18 — write-scope. In the mock1 run (2026-07-24) this step issued
        # `write_file src/hello.ts`, editing the very application file the story was
        # about, BEFORE implementation ran — so impl no longer started from baseline.
        # The scope is now empty because the agent writes NOTHING: it returns a
        # decision and lib/assessment_apply.py applies it. Kept (empty) rather than
        # deleted so a future prompt change cannot quietly regain write access.
        # :- guards — under `set -u` an unset var here aborts the whole command and the
        # agent never runs at all (same class as the B14 bad-substitution abort).
        #
        # EPAM_RESPONSE_SCHEMA binds the output AT THE PROVIDER (AgentRunner sets
        # responseFormat strict:true) rather than asking for a shape in prose. It
        # is what makes the deterministic apply safe, and removing the writes is
        # what makes the schema safe: a schema over an agent that still exhausts
        # returns a valid EMPTY object, which is a loud failure turned silent.
        # ITS OWN IDENTITY. This passed "team-lead-agent", so the pre-phase skill assessment
        # resolved the REVIEWER's seam: the reviewer's tool grant, effort and timeout, not its
        # own. agents/invocation-profiles.json declares phase-assessment with toolGrant "write"
        # and timeoutSecs 900 precisely because this step WRITES profiles.json — and the comment
        # above records what the wrong identity cost: "It got read tools ... upexpress exhausted".
        #
        # The second argument to run_orch_prompt is the seam name (`local agent_type="${2:-...}"`),
        # so this line is the whole of the wiring. A profile nothing names cannot be applied.
        #
        # THIS CALL'S ENVIRONMENT, AND NOTHING ELSE'S. These three were `export`ed on a
        # continuation line that a comment block later cut off from the call, so the export stood
        # alone and was PERMANENT: every seam after the assessment — the writer, the gates, the
        # failure analyst — inherited a write allow-list of nothing, a ten-call tool budget and the
        # assessment's own response schema. Under a runner that enforces --json-schema the
        # analyst's diagnosis was then rejected against storyRoleAssignments/profileAdditions and
        # self-healing was reported broken (£0 greenfield harness run 26, 2026-09-14; latent since
        # 2026-07-28). A per-command prefix on the call itself is scoped to the call, and bash
        # exports it to the runner the function spawns.
        EPAM_ALLOWED_WRITE_PATHS="" \
        EPAM_MAX_TOOL_CALLS="${_pfa_tool_budget}" \
        EPAM_RESPONSE_SCHEMA="${_pfa_schema:-}" \
        run_orch_prompt_with_tools "$_pfa_prompt_this_attempt" "phase-assessment" 2>&1 | tee "$assessment_log"
        # PIPESTATUS, not `|| _pfa_call_ok=0`: this is a PIPELINE, and its exit
        # status is tee's — always 0. The `||` branch could never fire on an agent
        # failure, so every failure here reported success. `set -e` does not save
        # it either, for the same reason (no `set -o pipefail`).
        [ "${PIPESTATUS[0]}" -eq 0 ] || _pfa_call_ok=0

        # A capability failure, not a content failure. The agent hit its iteration
        # cap and returned nothing, which means the TASK did not fit — not that it
        # misbehaved. The retry loop's corrective note ("YOUR PREVIOUS ATTEMPT
        # VIOLATED YOUR OWN INSTRUCTIONS") addresses the wrong thing, and the same
        # prompt at the same cap exhausts again: run 10 spent 2 attempts and $0.21
        # proving exactly that. Report it and stop, rather than buying another
        # identical failure at full price.
        if _pfa_capability_failed "$assessment_log"; then
            error "[pre-phase-assessment] agent exhausted its iteration cap without completing — NO profile augmentation happened for phase '$phase_id'"
            error "  The agent explored past its budget without answering, so nothing was applied."
            error "  NOT a fixed capability wall: on 2026-07-29 the same prompt at the same cap"
            error "  converged for two codelines and exhausted for a third — it varies with the"
            error "  repository. If this recurs, lower PRE_ASSESSMENT_MAX_TOOL_CALLS (currently"
            error "  ${_pfa_tool_budget}) so the agent commits earlier, rather than raising the iteration cap."
            error "  Not retrying: an identical prompt costs full price for the same roll. See $assessment_log"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            echo "$_pfa_profiles_before" > "$profiles_file"
            break
        fi

        # APPLY. The agent decided; the script writes. Every rule its prompt states
        # is enforced here instead of hoped for: a role is assigned only where one
        # is missing, a profile is created only when absent, and a rule already
        # present is never appended again — which is what run 12 could not manage
        # for itself ("The addendum was duplicated 4 times!").
        if [ -f "$SCRIPT_DIR/lib/assessment_apply.py" ]; then
            if ! python3 "$SCRIPT_DIR/lib/assessment_apply.py" \
                    --result "$assessment_log" --prd "$PRD_FILE" \
                    --profiles "$profiles_file" --phase "$phase_id" \
                    --repo-root "$PROJECT_ROOT"; then
                # Nothing was written — the module fails closed. Treat it as a
                # failed attempt so the loop's existing recovery handles it,
                # rather than proceeding as though the phase was assessed.
                warning "[pre-phase-assessment] the agent's decision could not be applied — see $assessment_log"
                _pfa_call_ok=0
            fi
        fi

        if [ "$_pfa_call_ok" -eq 0 ]; then
            _pfa_corrective_note="the tool call itself failed (non-zero exit) — check $assessment_log"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            echo "$_pfa_profiles_before" > "$profiles_file"
            continue
        fi

        "$SCRIPT_DIR/update-monitor.sh" event "pre_phase_assessment" "Pre-phase assessment completed" "" "main" "team-lead-agent" 2>/dev/null || true

        # Validate profiles.json is still valid JSON — a syntax corruption is
        # not retry-able (the model can't fix malformed JSON by trying the
        # exact same prompt again), so this stays an immediate hard stop.
        if ! jq empty "$profiles_file" 2>/dev/null; then
            error "Pre-phase assessment corrupted profiles.json! Restoring backup."
            cp "$profiles_backup" "$profiles_file"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            rm -f "$_pfa_prd_before_file"
            return 1
        fi

        local _pfa_violated=0
        local _pfa_violation_reason=""

        # Reviewer gate — Step 0.5 can create brand-new profiles from scratch
        # and append arbitrary skill rules to existing ones (typescript-engineer,
        # sast-sentinel, review-ranger, etc). The jq-empty check above only
        # catches JSON syntax corruption; this catches bad CONTENT.
        if [ -n "${ORCH_GATE_PROVIDER:-}" ]; then
            local _pfa_before_tmp
            _pfa_before_tmp=$(mktemp)
            printf '%s' "$_pfa_profiles_before" > "$_pfa_before_tmp"
            local _pfa_diff
            _pfa_diff=$(python3 "$SCRIPT_DIR/lib/handlers/pfa-diff.py" "$_pfa_before_tmp" "$profiles_file"
)
            rm -f "$_pfa_before_tmp"
            local _pfa_has_changes
            _pfa_has_changes=$(echo "$_pfa_diff" | python3 -c "import sys,json; d=json.load(sys.stdin); print(1 if d['new_profiles'] or d['changed_profiles'] else 0)" 2>/dev/null || echo 0)

            if [ "${_pfa_has_changes:-0}" = "1" ]; then
                local _pfa_reviewer_profile
                _pfa_reviewer_profile=$(jq -r '."prd-change-reviewer" // ""' "$profiles_file" 2>/dev/null || echo "")
                if [ -n "$_pfa_reviewer_profile" ]; then
                    local _pfa_verdict
                    _pfa_verdict=$(echo "${_pfa_reviewer_profile}

        $(_render_change_reviewer "pre-phase-assessment-${phase_id}" "profile_creation" "BEFORE/AFTER DIFF:\n${_pfa_diff}")" | \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER}" \
                        AI_MODEL="$(seam_model_or_fail "prd-change-reviewer")" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER}" \
                            --model    "$(seam_model_or_fail "prd-change-reviewer")" \
                        2>/dev/null | \
                        python3 "$SCRIPT_DIR/lib/handlers/run-pre-phase-assessment.py" 2>/dev/null || echo "pass")
                    if [ "$_pfa_verdict" = "fail" ]; then
                        _pfa_violated=1
                        _pfa_violation_reason="${_pfa_violation_reason}profiles.json content was rejected by the reviewer (bad/vague skill rule content); "
                    else
                        success "  [pre-phase-assessment] Profile changes approved by reviewer"
                    fi
                fi
            fi
        fi

        # NEW: deterministic PRD-side field-allowlist check. Unlike the
        # profiles reviewer above (a content-quality judgment call), this is
        # a 100% mechanical invariant — same "check it in code instead of
        # asking an LLM to eyeball it" philosophy as Step 0.9's MC_REVIEW_PY.
        local _pfa_prd_stderr_file
        _pfa_prd_stderr_file=$(mktemp)
        local _pfa_prd_verdict
        _pfa_prd_verdict=$(python3 "$SCRIPT_DIR/lib/handlers/pfa-prd-diff.py" "$_pfa_prd_before_file" "$PRD_FILE" "$phase_id" 2>"$_pfa_prd_stderr_file"
)
        if [ "$_pfa_prd_verdict" = "fail" ]; then
            _pfa_violated=1
            _pfa_violation_reason="${_pfa_violation_reason}$(tr '\n' ' ' < "$_pfa_prd_stderr_file")"
        fi
        rm -f "$_pfa_prd_stderr_file"

        if [ "$_pfa_violated" -eq 0 ]; then
            _pfa_final_outcome="pass"
            step_emit "3" "pass" "Step 3: Skill assessment"
            success "Pre-phase assessment completed for '$phase_id'"
            break
        fi

        # Violated (profiles content, PRD fields, or both) — revert BOTH
        # files to this attempt's pre-call state so retries never compound
        # on top of a partially-bad write, then either retry (attempts
        # remain) or accept the reverted state (exhausted).
        echo "$_pfa_profiles_before" > "$profiles_file" 2>/dev/null || true
        cp "$_pfa_prd_before_file" "$PRD_FILE"
        _pfa_corrective_note="$_pfa_violation_reason"
        _pfa_final_outcome="reverted"
        warning "  [pre-phase-assessment] Attempt ${_pfa_attempt}/3 violated scope: ${_pfa_violation_reason}"
    done

    local _pfa_violation_types="[]"
    if [ -n "$_pfa_corrective_note" ]; then
        _pfa_violation_types=$(printf '%s' "$_pfa_corrective_note" | python3 "$SCRIPT_DIR/lib/handlers/pfa-violation-types.py" 2>/dev/null || echo "[]")
    fi

    _log_guarded_step_retry "$(jq -n -c \
        --arg step "0.5" \
        --arg phase "$phase_id" \
        --argjson attempts "$_pfa_attempt" \
        --arg outcome "$_pfa_final_outcome" \
        --arg reason "$_pfa_corrective_note" \
        --argjson violationTypes "$_pfa_violation_types" \
        '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, reason: $reason, violationTypes: $violationTypes}' \
        2>/dev/null)"
    rm -f "$_pfa_prd_before_file"

    if [ "$_pfa_final_outcome" != "pass" ]; then
        step_emit "3" "warn" "Step 3: Skill assessment" "non-critical"
        warning "Pre-phase assessment for '$phase_id' reverted after 3 attempts (non-critical, continuing): ${_pfa_corrective_note}"
    fi
}

# Step 18: Post-Parallel Skill Assessment
# (Runs immediately after parallel execution; captures mid-pipeline variance.
#  Step 6 at end of pipeline performs the final post-phase assessment.)
# ──────────────────────────────────────────────
run_phase_assessment() {
    local phase_id=$1
    local cost_file="$LOG_DIR/phase-cost.jsonl"
    local assessment_file="$LOG_DIR/phase-skill-assessments.jsonl"
    local improvement_dir="$LOG_DIR/phase-improvements"

    mkdir -p "$improvement_dir"

    # Check if phase-cost.jsonl has records for this phase
    if [ ! -s "$cost_file" ]; then
        warning "No cost records found in $cost_file — skipping assessment"
        return 0
    fi

    # grep -c already prints "0" on zero matches while also exiting 1 — `|| echo 0`
    # would double-print ("0\n0"), breaking the numeric -eq test below.
    local phase_records
    phase_records=$({ grep -c "\"phase_id\":\"$phase_id\"" "$cost_file" 2>/dev/null || true; })
    if [ "${phase_records:-0}" -eq 0 ]; then
        warning "No cost records for phase '$phase_id' — skipping assessment"
        return 0
    fi

    info "Found $phase_records cost records for phase '$phase_id'"

    local improvement_report_file="${improvement_dir}/${phase_id}.md"
    # Generic, project-supplied skill-domain guidance (see
    # _build_skill_domain_guidance's own docstring) -- falls back to a
    # conservative, non-stack-specific instruction when no
    # .epam/skill-domain-map.json is configured, rather than ever guessing
    # or hardcoding a keyword list here.
    local _skill_domain_guidance
    _skill_domain_guidance=$(_build_skill_domain_guidance "$PROJECT_ROOT")
    [ -z "$_skill_domain_guidance" ] && _skill_domain_guidance="not configured for this project (.epam/skill-domain-map.json) — use conservative judgment; only reassign a role when the mismatch between the task description and assigned agentRole is unambiguous"

    # Full agent audit, 2026-07-31 (mock1 investigation): this step used to
    # hand the agent two raw files (cost log + PRD) and ask it to read,
    # dedupe-by-latest-timestamp, cross-reference, sum, and write THREE
    # outputs (JSONL append, markdown report, conditional PRD mutation) —
    # all with only bash/read_file/list_files/search (no write_file) and a
    # 6-tool-call/300s budget. That's exactly the "unstructured, multi-file,
    # agent-does-its-own-data-gathering" pattern already fixed for every QA
    # gate this session (sast-sentinel, review-ranger, mutant-hunter,
    # perf-sentinel all get pre-computed evidence injected, never explore
    # for it themselves) — and it's what caused the mock1 timeout (attempt 1
    # exhausted 300s, attempt 2 succeeded only on an escalated model).
    #
    # Fixed the same way: the dedupe/cross-reference/arithmetic is 100%
    # deterministic (no judgment involved) and now happens here in
    # bash/python. The LLM's job is narrowed to genuine judgment only —
    # writing human-readable notes/recommendations and deciding skill-domain
    # role reassignments — and needs NO tools at all, since everything it
    # needs is injected and the orchestrator (not the agent) performs every
    # write, atomically and lock-guarded, exactly like story-ac-remediator's
    # deterministic-apply pattern.
    local _pa_summary_file
    _pa_summary_file=$(mktemp)
    # THE PRECOMPUTE IS THE EVIDENCE. Its whole purpose is that the agent no longer explores for
    # the numbers — so if it fails, the agent is handed '{}' and asked to judge a phase it can see
    # nothing of. It will still answer, fluently, about nothing. Neither the exit status nor the
    # empty result was checked.
    if ! python3 "$SCRIPT_DIR/lib/handlers/assess-precompute.py" \
            "$cost_file" "$PRD_FILE" "$phase_id" "$_pa_summary_file"; then
        rm -f "$_pa_summary_file"
        error "Step 18: could not compute the phase summary — refusing to ask for an assessment of evidence that was never gathered"
        return 1
    fi

    local _pa_summary
    _pa_summary=$(cat "$_pa_summary_file" 2>/dev/null || printf '')
    rm -f "$_pa_summary_file"
    if [ -z "$_pa_summary" ] || [ "$_pa_summary" = "{}" ]; then
        error "Step 18: the phase summary is empty — there is nothing for the assessor to read"
        return 1
    fi

    local assessment_prompt
    local _sap_guidance_file; _sap_guidance_file=$(mktemp "${TMPDIR:-/tmp}/sap-guidance-XXXXXX.txt")
    printf '%s' "${_skill_domain_guidance:-}" > "$_sap_guidance_file"
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/skill-assessment-postphase-vals-XXXXXX.json")
    # __PA_SUMMARY__ is the assessor's ONLY evidence — the template calls it "Pre-computed
    # assessment data", and the code above refuses to continue without it ("there is nothing for
    # the assessor to read"). It was computed, validated, and then never passed, so the render threw
    # "missing values for: __PA_SUMMARY__" on the runs of 2026-08-19 and -20.
    local _pa_summary_val_file; _pa_summary_val_file=$(mktemp "${TMPDIR:-/tmp}/pa-summary-XXXXXX.txt")
    printf '%s' "${_pa_summary}" > "$_pa_summary_val_file"
    jq_vals \
          --rawfile skill_domain_guidance "$_sap_guidance_file" \
          --rawfile pa_summary "$_pa_summary_val_file" \
          --arg phase_id "$phase_id" \
          '{"__SKILL_DOMAIN_GUIDANCE__":$skill_domain_guidance,"__PA_SUMMARY__":$pa_summary,"__PHASE_ID__":$phase_id}' > "$_cp_vals"
    rm -f "$_pa_summary_val_file"
    # EXIT STATUS IS THE CONTRACT — a failed render sends the assessor an empty prompt, and its
    # output feeds a PRD mutation.
    if ! assessment_prompt="$(render_engine_prompt skill-assessment-postphase "$_cp_vals")" \
       || [ -z "$assessment_prompt" ]; then
        rm -f "$_cp_vals"
        error "Step 18: could not render the phase-assessment prompt — not invoking the assessor with nothing to read"
        return 1
    fi
    rm -f "$_cp_vals"
    rm -f "$_sap_guidance_file"

    log "Running assessment agent for phase '$phase_id'..."
    local assessment_log="$LOG_DIR/assessment-${phase_id}.log"

    local _pa_attempt=0 _pa_success=0 _pa_raw=""
    local _saved_gate_timeout="${EPAM_GATE_TIMEOUT_SECS:-}"
    # No tools needed anymore (see comment above) — this is now a pure
    # text-in/JSON-out judgment call, same class as openspec/speckit. The
    # 300s cap and 2-attempt/model-escalation retry are kept as a resilience
    # backstop, not because the task is expected to need them.
    EPAM_GATE_TIMEOUT_SECS="${PHASE_ASSESSMENT_TIMEOUT_SECS:-300}"
    while [ "$_pa_attempt" -lt 2 ] && [ "$_pa_success" = "0" ]; do
        local _pa_prompt="$assessment_prompt"
        if [ "$_pa_attempt" -ge 1 ]; then
            # Climb the assessor's own chain — see the QA-gate retry for why assigning
            # ORCH_GATE_MODEL no longer does anything.
            ORCH_AGENT_MODEL_CLIMB=$(seam_next_model "team-lead-agent" "$(seam_model_or_fail "team-lead-agent" 2>/dev/null)")
            export ORCH_AGENT_MODEL_CLIMB
            _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
            jq_vals \
                  --arg assessment_prompt "$assessment_prompt" \
                  '{"__ASSESSMENT_PROMPT__":$assessment_prompt}' > "$_rp_vals"
            if ! _pa_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" phase_assessment)" \
               || [ -z "$_pa_prompt" ]; then
                warning "Step 18: could not render the retry prefix — retrying with the original prompt"
                _pa_prompt="$assessment_prompt"
            fi
            rm -f "$_rp_vals"
        fi
        local _assessment_rc=0
        run_orch_prompt "$_pa_prompt" "team-lead-agent" > "$assessment_log" 2>&1 || _assessment_rc=$?
        _pa_raw=$(cat "$assessment_log" 2>/dev/null)

        if [ "$_assessment_rc" -ne 0 ]; then
            warning "Phase assessment attempt $(( _pa_attempt + 1 )) failed for '$phase_id' (rc=${_assessment_rc})"
            _pa_attempt=$(( _pa_attempt + 1 ))
            continue
        fi

        if echo "$_pa_raw" | python3 "$SCRIPT_DIR/lib/handlers/run-phase-assessment.py" 2>/dev/null; then
            _pa_success=1
        else
            warning "Phase assessment attempt $(( _pa_attempt + 1 )) for '$phase_id' produced no valid JSON$([ "$_pa_attempt" -lt 1 ] && echo " — retrying with escalated model" || echo "")"
        fi
        _pa_attempt=$(( _pa_attempt + 1 ))
    done
    unset ORCH_AGENT_MODEL_CLIMB
    EPAM_GATE_TIMEOUT_SECS="$_saved_gate_timeout"

    if [ "$_pa_success" = "0" ]; then
        warning "Phase assessment for '$phase_id' failed after 2 attempt(s) — no assessment record written; non-critical, continuing"
        return 1
    fi

    # Deterministic apply: build the final assessment record from the
    # PRE-COMPUTED totals (never from the LLM's own arithmetic) plus the
    # LLM's judgment fields, flock-append it, write the markdown report, and
    # apply role reassignments — re-validated against the SAME
    # future_pending_stories list computed above, not blindly trusted from
    # the LLM's response. Mirrors story-ac-remediator's deterministic-apply
    # pattern (flock -w 10 200, python3 heredoc, atomic os.replace).
    local _pa_raw_tmp _pa_summary_tmp
    _pa_raw_tmp=$(mktemp); echo "$_pa_raw" > "$_pa_raw_tmp"
    _pa_summary_tmp=$(mktemp); echo "$_pa_summary" > "$_pa_summary_tmp"
    ( flock -w 10 200 || { error "  [phase-assessment] Could not acquire lock on $assessment_file"; rm -f "$_pa_raw_tmp" "$_pa_summary_tmp"; return 1; }
    python3 "$SCRIPT_DIR/lib/handlers/assess-apply.py" "$_pa_summary_tmp" "$_pa_raw_tmp" "$assessment_file" "$improvement_report_file" "${MAIN_PRD_FILE:-$PRD_FILE}"
    ) 200>"${assessment_file}.lock"
    rm -f "$_pa_raw_tmp" "$_pa_summary_tmp"

    success "Phase assessment completed for '$phase_id'"
    return 0
}

# _reset_story_for_reimplementation <story_id>
# Clears completed/status on exactly ONE story so a review-driven
# re-implementation attempt is not a guaranteed no-op against
# is_story_completed. Same semantics as the outer whole-phase reset
# (`.completed = false | .status = "pending"`, see the RESET_STORIES block
# above) — that one already resets correctly at phase-restart scope; this is
# the missing per-story equivalent at the Step 3.6 retry-cycle scope.
# Scoped to one id deliberately: a sibling that already passed review must not
# be re-run. Tolerates a missing/unknown id — jq's select simply matches
# nothing, same as every other targeted PRD mutation in this file.
_reset_story_for_reimplementation() {
    local _story_id="$1"
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    [ -f "$_prd_target" ] || return 0
    local _tmp_prd
    _tmp_prd="$(mktemp)"
    chmod 644 "$_tmp_prd" 2>/dev/null
    if jq --arg id "$_story_id" \
        '(.stories[]? | select(.id == $id)) |= (.completed = false | .status = "pending")' \
        "$_prd_target" > "$_tmp_prd" 2>/dev/null; then
        mv "$_tmp_prd" "$_prd_target"
    else
        rm -f "$_tmp_prd"
    fi
    return 0
}

# Marks ONE rejected story escalated: persists the reviewer's blockers to both
# the review-agent KB and the writer's own profile, then tags
# reviewStatus:"escalated" on the PRD. Factored out because it now fires from
# TWO places — a story whose ladder is exhausted, and (rarely) every
# still-climbable story caught by the safety valve above — and both must
# behave identically.
_escalate_review_story() {
    local _fb="$1" _fb_story="$2"
    mkdir -p "$LOG_DIR/kb-scratchpad" 2>/dev/null || true
    # Stamp provenance. A blocker sentence written once becomes a standing
    # "LEARNED REVIEW RULE" applied to all later work, so it must say which
    # story and run produced it — otherwise a rule learned from a bad input is
    # indistinguishable from a well-founded one, and neither can be expired.
    jq -r --arg sid "$_fb_story" --arg run "${ORCH_RUN_ID:-unknown}" \
        '.issues[]? | select((.severity // "") == "blocker") | "- [" + $sid + " @" + $run + "] " + (.description // "")' "$_fb" \
        >> "$LOG_DIR/kb-scratchpad/KB-review-agent.md" 2>/dev/null || true
    # Also persist the SAME lesson to the WRITER's own profile (found live,
    # 2026-08-02: only the reviewer's own KB got this — nothing ever told the
    # WRITER across runs, so a story that repeatedly fails review for the
    # identical reason had no accumulating guidance, unlike FailureAnalyst's
    # tsc/test-failure diagnoses, which already persist via
    # _persist_skill_note_simple's stricter cousin in claude.sh). Gated
    # through the same deterministic anti-pattern check (lib/story-guards.sh)
    # for consistency/safety.
    local _fb_role _fb_blockers
    _fb_role=$(jq -r --arg id "$_fb_story" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null)
    _fb_blockers=$(jq -r '.issues[]? | select((.severity // "") == "blocker") | "- " + (.description // "")' "$_fb" 2>/dev/null)
    if [ -n "$_fb_role" ] && [ -n "$_fb_blockers" ]; then
        _persist_skill_note_simple "$AGENT_PROFILES_FILE" "$_fb_role" \
            "Review REPEATEDLY rejected ${_fb_story} (ladder exhausted) for:
${_fb_blockers}"
    fi
    local _tmp_prd
    _tmp_prd="$(mktemp)"; jq --arg id "$_fb_story" \
        '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "escalated"})' \
        "$PRD_FILE" > "$_tmp_prd" 2>/dev/null && mv "$_tmp_prd" "$PRD_FILE" || rm -f "$_tmp_prd"
}

# APPROVAL AFTER AN UNRESOLVED BLOCKER, WITH THE CODE UNCHANGED, IS A GIVE-UP.
#
# Live 2026-08-07: the reviewer raised one blocker — "no tests were added" — on three
# consecutive cycles, no test file was ever created, and cycle 4 APPROVED. The story was
# marked complete with nothing verifying it.
#
# The rule needs no vocabulary and reads nothing about WHAT the blocker said: if the previous
# cycle rejected with a blocker and the codeline is byte-identical now, the verdict changed
# while the code did not. That is the reviewer relenting, not the writer fixing.
#
# Records a fingerprint of the working tree per cycle. Cheap, and it cannot be fooled by a
# reworded blocker or a reworded approval.
_review_tree_fingerprint() {
    local _root="${JIRA_CODELINE_ROOT:-}" _sum=""
    [ -n "$_root" ] && [ -d "$_root" ] || { echo "no-codeline-root"; return 0; }
    local _cl
    for _cl in "$_root"/*/; do
        [ -e "${_cl}.git" ] || continue
        _sum="${_sum}$(git -C "${_cl%/}" diff HEAD 2>/dev/null | sha1sum 2>/dev/null | cut -d' ' -f1)"
    done
    printf '%s' "$_sum" | sha1sum 2>/dev/null | cut -d' ' -f1
}

# Did the last cycle reject with a blocker AND leave the tree unchanged since?
_review_approval_is_giveup() {
    local _prev_had_blocker="$1" _prev_fp="$2" _now_fp="$3"
    [ "$_prev_had_blocker" = "1" ] || return 1
    # UNKNOWN IS NOT UNCHANGED. With no codeline root — a greenfield run — the fingerprint is a
    # constant sentinel, so it always compares equal and EVERY approval following a blocker
    # would be condemned as a give-up. "We cannot tell whether the code changed" must never be
    # read as "the code did not change".
    [ "$_prev_fp" = "no-codeline-root" ] && return 1
    [ -n "$_prev_fp" ] && [ "$_prev_fp" = "$_now_fp" ] || return 1
    return 0
}
