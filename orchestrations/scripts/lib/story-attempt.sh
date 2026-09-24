#!/usr/bin/env bash
# story-attempt.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (15 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# _coupled_pair_gate_for_story <story_id> <output_file>
# ONE AUTHOR PER COUPLED FILE PAIR. Runs the moment the rung-contribution report
# exists — that report is the only artifact that knows WHICH RUNG wrote which file,
# and a split pair is invisible to every other gate in the run: the live case
# (AMSD-2041, run 20260814T213253Z) passed `npm run test` AND `tsc`, because neither
# installs from the lockfile. It reached the reviewer, which rejected it at an
# already-exhausted ladder, and the retry hard-reset away work that had passed.
#
# Catching it HERE means the writer gets it back as a normal verification failure with
# rungs still available, instead of the reviewer catching it with none left.
#
# The pairs are the project's declaration (.epam/dependency-check.json
# `coupledFilePairs`), never this engine's knowledge — see lib/coupled-pair-gate.sh.
_coupled_pair_gate_for_story() {
    local story_id="$1" output_file="${2:-/dev/null}"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate_lib="${SCRIPT_DIR}/lib/coupled-pair-gate.sh"
    [ -f "$_gate_lib" ] || return 0
    # shellcheck source=lib/coupled-pair-gate.sh
    . "$_gate_lib"
    command -v coupled_pair_check >/dev/null 2>&1 || return 0

    local _report_file="${LOG_DIR}/rung-contribution-report-${story_id//[^A-Za-z0-9_-]/_}.json"
    # THE MANIFEST IS RESOLVED THE WAY EVERY OTHER CONSUMER RESOLVES IT.
    #
    # This read only ${PROJECT_ROOT}/.epam/dependency-check.json — a path nothing
    # provisions. A codeline's .epam/ holds codeline-facts.json, settings.json and
    # verification.json, never that file. So on 2026-08-15 the live run reported
    # "no manifest at '.../.epam/dependency-check.json' — coupledFilePairs undeclared,
    # checked nothing", while the declaration sat in EPAM_PROJECT_CONFIG_DIR, which is
    # where dependency-scan-plugin.js:72-73 and claude.sh:3875/5638 all look FIRST.
    # The gate had therefore never once run.
    #
    # Two candidates, same order as the plugin: project config, then the codeline copy.
    local _manifest="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_manifest" ] || _manifest="${PROJECT_ROOT}/.epam/dependency-check.json"
    [ -f "$_report_file" ] || return 0

    local _gate_out _gate_rc=0
    _gate_out=$(coupled_pair_check "$_report_file" "$_manifest" 2>&1) || _gate_rc=$?
    if [ "$_gate_rc" -eq 0 ]; then
        [ -n "$_gate_out" ] && log "  $_gate_out"
        return 0
    fi

    error "  [coupled-pair] $story_id: a coupled file pair had more than one author — feeding into retry loop"
    while IFS= read -r _line; do [ -n "$_line" ] && log "  $_line"; done <<< "$_gate_out"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nFiles that are only correct RELATIVE TO EACH OTHER were written by different attempts, so they now disagree:\n\n```\n%s\n```\n\nRewrite every member of the pair together, in this one attempt, so they are consistent. Do not change one and leave the other as a previous attempt left it.\n' \
        "$_gate_out")
    {
        echo ""
        echo "=== a coupled file pair had more than one author ==="
        echo "$_gate_out"
    } >> "$output_file"
    return 1
}

# _plan_fidelity_gate_for_story <story_id> <output_file>
# SCOPE IS ARITHMETIC AGAINST THE PLAN, NOT AN OPINION.
#
# lib/plan-fidelity-gate.sh was written for run 20260814T213253Z (AMSD-2041): the plan named
# FIVE sites, the implementer changed exactly those five, and the reviewer rejected it for
# modifying "6 files when the prescribed minimal fix requires only 2" — a number appearing
# nowhere in the plan it was handed. Obeying the plan was the thing being rejected, so no
# attempt could pass; four review cycles later the ladder was exhausted and the retry
# hard-reset the branch, destroying work that had passed the suite and tsc.
#
# The library shipped and NOTHING CALLED IT. This is that call site. Placed beside the
# coupled-pair gate for the same reason that one is here: the writer gets the finding back as
# an ordinary verification failure with rungs still available, instead of the reviewer forming
# an opinion about scope with none left.
#
# The gate returns 0 for a story with no prescription — UNCHECKED is not a failure — so this
# is inert on any story nobody planned.
_plan_fidelity_gate_for_story() {
    local story_id="$1" output_file="${2:-/dev/null}"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate_lib="${SCRIPT_DIR}/lib/plan-fidelity-gate.sh"
    [ -f "$_gate_lib" ] || return 0
    # shellcheck source=lib/plan-fidelity-gate.sh
    . "$_gate_lib"
    command -v plan_fidelity_check >/dev/null 2>&1 || return 0
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0

    # THE COMMIT IS THE ARTIFACT, and the baseline is resolved the way every other consumer
    # in this file resolves it — the phase baseline if one was recorded, else the run's.
    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] && \
        _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    local _changed_list
    _changed_list=$(mktemp)
    git -C "$PROJECT_ROOT" diff --name-only "$_ref" HEAD > "$_changed_list" 2>/dev/null
    if [ ! -s "$_changed_list" ]; then rm -f "$_changed_list"; return 0; fi

    # Two candidates, same order as the dependency plugin and the coupled-pair gate.
    local _manifest="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_manifest" ] || _manifest="${PROJECT_ROOT}/.epam/dependency-check.json"

    local _gate_out _gate_rc=0
    _gate_out=$(plan_fidelity_check "${MAIN_PRD_FILE:-$PRD_FILE}" "$story_id" "$_changed_list" "$_manifest" 2>&1) \
        || _gate_rc=$?
    rm -f "$_changed_list"

    if [ "$_gate_rc" -eq 0 ]; then
        [ -n "$_gate_out" ] && log "  $_gate_out"
        return 0
    fi

    # ADVISORY. IT MUST NOT REJECT WORKING CODE.
    #
    # This returned 1 and fed the retry loop. Two things disprove that, both from this repo's
    # own record rather than from reasoning:
    #
    #   1. gotransit SHIPPED AMSD-2041 as e780a8b7 — NINE files, +379. The prescription names
    #      six sites, three of them changeRequired:false. The real, working, merged fix was
    #      therefore out of plan, and a blocking gate would have rejected it on every attempt
    #      until the ladder exhausted — the exact outcome this gate exists to prevent, inverted.
    #
    #   2. The writer is TOLD the list is not binding. prompts/templates/story-implementation
    #      .json: "The list is a STARTING POINT, not a fence ... If your change genuinely
    #      requires another file in this repository, write it." A gate that blocks what the
    #      prompt instructs is unwinnable by construction — the writer cannot satisfy both.
    #
    # The same file already carries this lesson twice: the helper-ABSENCE veto rejected working
    # code at 7.3M tokens and $2.25 per false rejection before it was narrowed to duplication.
    # A false-positive gate is worse than the silence it replaced.
    #
    # So the finding is RECORDED, in the log and in the attempt output where the reviewer and
    # the operator both see it, and the story proceeds. Making it blocking is a decision for
    # after a run has shown what it actually flags — not before.
    error "  [plan-fidelity] $story_id: the change went outside the plan of record (advisory — not blocking)"
    while IFS= read -r _line; do [ -n "$_line" ] && log "  $_line"; done <<< "$_gate_out"
    {
        echo ""
        echo "=== ADVISORY: the change went outside the plan of record ==="
        echo "$_gate_out"
        echo "This is recorded, not enforced. The prescribed file list is a starting point, not a fence."
    } >> "$output_file"
    return 0
}

# resolve_model_from_story <story_id>
# a .model field directly.  If set, it overrides the effort-based STORY_MODEL.
# _tc_writer_phase — which phase the TC writer is generating for.
#
# CURRENT_PHASE is a claude.sh-internal global: declared empty at the top of this file and assigned
# in exactly ONE place, the phase-filter path. PHASE is what run-agent-orchestration.sh exports and
# passes per invocation. Reading only CURRENT_PHASE and falling back to the literal 'unknown' meant
# that on every ordinary run the writer was asked for a phase no story is in — live metrolinx
# AMSD-2041, 2026-08-18:
#   [tc-writer] Generating TCs for phase 'unknown' (post-impl, pre-test)...
#   [tc-writer] No test stories need TCs in phase 'unknown' — skipping
#   [tc-writer] TC generation complete — test stories have testCriteria
# and the story's testCriteria stayed empty while the log reported completion.
#
# Emits EMPTY when neither is set, never a literal that looks like an answer: the caller can detect
# an absent phase, but 'unknown' is indistinguishable from a phase that simply has no test stories.
_tc_writer_phase() {
    printf '%s' "${CURRENT_PHASE:-${PHASE:-}}"
}

# provider_to_cli <provider>
# Returns the CLI binary name for a given aiProvider value.
# Exits with an error for unknown providers — no silent Claude fallback.
#
# The mapping lives in providers.json's `cliBinary`, not here — see
# change-log/SEAM-CONSISTENCY-ANALYSIS.md Section 5. This used to be a hardcoded `case`
# statement naming every vendor, a second, independently-maintained list next to
# providers.json's `known` — the two could (and did) drift.
# _declared_read_roots <prd-file>
# Every ABSOLUTE, EXISTING DIRECTORY named anywhere in the PRD's `configuration` object (author
# comment keys, $-prefixed, excluded), one per line. Which key holds it is the project's business.
_declared_read_roots() {
    local _prd="${1:-}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    jq -r '(.configuration // {}) | with_entries(select(.key | startswith("$") | not)) | .. | strings | select(startswith("/"))' "$_prd" 2>/dev/null \
        | sed 's:/*$::' | sort -u | while IFS= read -r _p; do [ -n "$_p" ] && [ -d "$_p" ] && printf '%s\n' "$_p"; done
}

provider_to_cli() {
    local _providers_json="${PROVIDERS_JSON:-$SCRIPT_DIR/../config/providers.json}"
    local cli
    cli=$(jq -r --arg p "$1" '.cliBinary[$p] // empty' "$_providers_json" 2>/dev/null)
    if [ -z "$cli" ]; then
        local known
        known=$(jq -r '.known | join("|")' "$_providers_json" 2>/dev/null)
        error "Unknown aiProvider '$1' — set aiProvider in prd.json to one of: ${known:-see config/providers.json}"
        return 1
    fi
    if [ "$cli" = '$EPAM_CLI' ]; then
        echo "$EPAM_CLI"
    else
        echo "$cli"
    fi
}

# normalize_provider_json <provider> <raw_jsonl_file> <out_json_file>
# Converts provider-specific JSONL output into a normalized JSON object
# matching Claude's format: {result, total_cost_usd, usage.{input_tokens,output_tokens}}
normalize_provider_json() {
    local provider="$1"
    local raw_file="$2"
    local out_file="$3"
    case "$provider" in
        opencode)
            # OpenCode emits JSONL stream; try step_finish first, then fall back to any cost/usage field
            local sf_line
            sf_line=$(grep '"type":"step_finish"' "$raw_file" 2>/dev/null | tail -1)
            if [ -z "$sf_line" ]; then
                sf_line=$(grep -E '"cost"|"total_cost"' "$raw_file" 2>/dev/null | tail -1 || echo '{}')
            fi
            sf_line="${sf_line:-{\}}"
            # Extract text parts for result summary
            local result_text
            result_text=$(grep '"type":"text"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].part.text // .[].text // ""] | join("")' 2>/dev/null || echo "opencode run completed")
            # --rawfile: a full model turn can exceed ARG_MAX, and argv would fail with 126
            # ("Argument list too long") leaving an empty result that reads as "no output".
            local _rt_file; _rt_file=$(mktemp "${TMPDIR:-/tmp}/rt-XXXXXX")
            printf '%s' "$result_text" > "$_rt_file"
            jq -n \
                --rawfile rt "$_rt_file" \
                --argjson sf "$sf_line" \
                '{result: $rt,
                  total_cost_usd: ($sf.cost // $sf.part.cost // $sf.total_cost // 0),
                  usage: {
                      input_tokens:  ($sf.tokens.input  // $sf.part.tokens.input  // $sf.usage.input_tokens  // 0),
                      output_tokens: ($sf.tokens.output // $sf.part.tokens.output // $sf.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codex)
            # Codex emits JSONL stream; turn.completed has usage (no cost field)
            local tc_line
            tc_line=$(grep '"type":"turn.completed"' "$raw_file" 2>/dev/null | tail -1)
            tc_line="${tc_line:-{\}}"
            local result_text
            result_text=$(grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].item.text // ""] | join("")' 2>/dev/null || echo "codex exec completed")
            # --rawfile: a full model turn can exceed ARG_MAX, and argv would fail with 126
            # ("Argument list too long") leaving an empty result that reads as "no output".
            local _rt_file; _rt_file=$(mktemp "${TMPDIR:-/tmp}/rt-XXXXXX")
            printf '%s' "$result_text" > "$_rt_file"
            jq -n \
                --rawfile rt "$_rt_file" \
                --argjson tc "$tc_line" \
                '{result: $rt,
                  total_cost_usd: 0,
                  usage: {
                      input_tokens:  ($tc.usage.input_tokens  // 0),
                      output_tokens: ($tc.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codemie-claude)
            # codemie-claude: same output format as Claude — nothing to normalize
            ;;
        epam)
            # epam: same output format as Claude — nothing to normalize
            ;;
        epam-run)
            # epam run --json output: {result, cost_usd, usage:{inputTokens,outputTokens}}
            # Pick the last JSON object that has a "result" field (guards against pino log lines,
            # which never carry a "result" key). Do NOT filter on result != "" — agents that only
            # write files produce result:"" legitimately, and excluding them drops real cost data.
            jq -s '[.[] | select(has("result"))] | last // {result:"",cost_usd:0,usage:{inputTokens:0,outputTokens:0}} | {
                result:          (.result // ""),
                total_cost_usd:  (.cost_usd // 0),
                usage: ({
                    input_tokens:  (.usage.inputTokens  // 0),
                    output_tokens: (.usage.outputTokens // 0)
                }
                # Carry the cached subset THROUGH. Rebuilding usage from scratch discarded it, so
                # the cost ledger recorded cache_read_tokens: 0 and the cost line printed
                # "cached 0 = 0.0%" for an attempt the per-turn trace measured at 98.9% cached
                # (live 2026-08-10). Caching is the largest efficiency change made to this
                # pipeline and every cost figure was blind to it.
                #
                # `if has` rather than `// 0`: a provider that reports nothing about caching has
                # not reported ZERO caching, and an unmeasured value recorded as a measured zero
                # is the defect this pipeline keeps reproducing. Absent stays absent; the display
                # side is what chooses how to render it.
                + (if (.usage | has("cached_input_tokens"))
                   then {cached_input_tokens: .usage.cached_input_tokens} else {} end))
            }' "$raw_file" > "$out_file" 2>/dev/null || true
            ;;
        *)
            # Claude: already emits normalized JSON; nothing to do
            ;;
    esac
}

# Check prerequisites
check_prerequisites() {
    # Check for jq
    if ! command -v jq &> /dev/null; then
        error "jq is required but not installed. Install with: sudo apt install jq"
        exit 1
    fi

    # Check for Claude CLI only when actually needed (provider=claude or codemie-claude)
    if command -v "$CLAUDE_CMD" &> /dev/null; then
        : # claude is available — all paths work
    else
        # TWO INDEPENDENT WAYS A STORY CAN NEED CLAUDE, both checked — this used to check only
        # the second and assumed "codex" for the first, so a PRD where every story leaves
        # aiProvider unset (the normal case) short-circuited straight to "OK, no story needs
        # claude" on the SAME machine where every unassigned story is about to resolve to claude.
        #
        # 1. THE ACTIVE SET'S OWN DEFAULT. What resolve_provider_settings() gives an UNASSIGNED
        #    story is exactly what resolve_primary_provider resolves with no candidate — if that
        #    is claude-family, every unassigned story needs the CLI, full stop.
        _default_needs_claude=0
        case "$(resolve_primary_provider)" in
            claude|codemie-claude) _default_needs_claude=1 ;;
        esac
        # 2. AN EXPLICIT PER-STORY OVERRIDE. A story can name claude/codemie-claude even when the
        #    set's own default is something else, as long as the active set can route it — the
        #    same routability question resolve_primary_provider answers for the DEFAULT case, but
        #    jq cannot call a bash function, so this stays a direct field check. `// empty`, not
        #    `// "codex"`: an unset field is genuinely unset, not a second, competing default.
        if [ "$_default_needs_claude" = "1" ] || \
           { grep -q '"aiProvider"' "${PRD_FILE:-/dev/null}" 2>/dev/null && \
             jq -e '.stories[].aiProvider // empty | select(. == "claude" or . == "codemie-claude")' \
                 "${PRD_FILE:-/dev/null}" >/dev/null 2>&1; }; then
            error "Claude CLI not found. Expected command: $CLAUDE_CMD"
            error "Install Claude Code CLI or set CLAUDE_CMD environment variable"
            exit 1
        fi
        log "Claude CLI not found — OK since no stories use the claude provider"
    fi

    # Check PRD file
    if [ ! -f "$PRD_FILE" ]; then
        error "PRD file not found at $PRD_FILE"
        exit 1
    fi

    # Validate PRD JSON
    if ! jq empty "$PRD_FILE" 2>/dev/null; then
        error "PRD file is not valid JSON"
        exit 1
    fi

    success "Prerequisites check passed"
}

# ──────────────────────────────────────────────
# check_plan_mode_required <story_id>
# Returns 0 (true) when the story's complexity triggers plan mode.
# Triggers: estimatedHours >= 6, OR deps >= 2, OR planModeRequired flag.
# Bypass: SKIP_PLAN_MODE=true env var.
# ──────────────────────────────────────────────
check_plan_mode_required() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    is_truthy "${SKIP_PLAN_MODE:-}" && return 1

    local estimated_hours dep_count plan_flag
    estimated_hours=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target" 2>/dev/null || echo 0)
    dep_count=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.dependencies // []) | length' "$prd_target" 2>/dev/null || echo 0)
    plan_flag=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.planModeRequired // false' "$prd_target" 2>/dev/null || echo false)

    [ "$plan_flag" = "true" ] && return 0
    # Use awk for float comparison (avoids bc dependency for this check)
    awk -v h="$estimated_hours" 'BEGIN{exit !(h >= 6)}' && return 0
    [ "${dep_count:-0}" -ge 2 ] && return 0
    return 1
}

# ──────────────────────────────────────────────
# run_plan_mode <story_id>
# Invokes Claude in planning mode to produce execution-ready artifacts.
# Posts a plan_summary message to agent-messages.jsonl when complete.
# ──────────────────────────────────────────────
run_plan_mode() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local plan_log
    plan_log="$CLAUDE_OUTPUT_DIR/${story_id}_plan_$(date +'%Y%m%d_%H%M%S').log"
    local plan_json="${plan_log%.log}_result.json"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"

    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local plan_prompt
    # RENDERED FROM THE TEMPLATE LAYER. Both provider scripts render the same document —
    # they carried separate copies that had already drifted, and the copy here had the
    # messages path written into the prompt text rather than passed as data.
    _pp_vals=$(mktemp "${TMPDIR:-/tmp}/story-plan-agent-vals-XXXXXX.json")
    jq_vals --arg story_id "$story_id" \
          --arg messages_jsonl "$messages_jsonl" \
          --arg agent_role "$agent_role" \
          --arg current_phase "${CURRENT_PHASE:-unknown}" \
          '{"__STORY_ID__":$story_id,"__MESSAGES_JSONL__":$messages_jsonl,"__AGENT_ROLE__":$agent_role,"__CURRENT_PHASE__":$current_phase}' > "$_pp_vals"
    plan_prompt="$(render_engine_prompt story-plan-agent "$_pp_vals")"
    rm -f "$_pp_vals"

    log "Plan mode: generating execution plan for $story_id..."
    touch "$messages_jsonl"
    cd "$PROJECT_ROOT"

    local plan_ok=false
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        # SDK path: extended thinking enabled for plan mode (high-complexity reasoning)
        if echo "$plan_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                --cache-system \
                --model "$STORY_MODEL" \
                --thinking-budget 8000 \
                --output "$plan_json" 2>/dev/null; then
            plan_ok=true
        fi
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model
        _orch_model="$(seam_model_or_fail "phase-assessment" 2>/dev/null || true)"
        if [ -z "$_orch_provider" ]; then
            warning "Plan mode: EPAM_ORCHESTRATION_PROVIDER not set — skipping plan"
        # AI_GATE_ALLOW_TOOLS=1: the plan_prompt below explicitly instructs the
        # agent to "Read orchestrations/prd.json for story ${story_id}" — without
        # this, ai-run.sh's epam-umbrella branch defaults to --no-tools and the
        # agent has no way to actually read anything, so the plan gets
        # fabricated from whatever it happens to guess (found live 2026-07-08).
        elif echo "$plan_prompt" | \
                EPAM_AGENT_NAME="story-plan-agent" EPAM_STORY_ID="${story_id}" \
                AI_GATE_ALLOW_TOOLS=1 \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                > "$plan_json" 2>>"$plan_log"; then
            # Wrap plain text output into the expected {result:...} shape
            plan_text_raw=$(cat "$plan_json")
            printf '{"result":%s}' "$(echo "$plan_text_raw" | jq -Rs .)" > "$plan_json"
            plan_ok=true
        fi
    fi

    if [ "$plan_ok" = true ]; then
        jq -r '.result // empty' "$plan_json" 2>/dev/null >> "$plan_log" || true
        success "Plan mode completed for $story_id — see $plan_log"
    else
        warning "Plan mode failed for $story_id — continuing with direct implementation"
    fi
}

# ──────────────────────────────────────────────
# post_completion_message <story_id> <status>
# Appends a status message to agent-messages.jsonl after each story run.
# Only writes when ORCH_MODE=hybrid OR the bus file already exists.
# ──────────────────────────────────────────────
post_completion_message() {
    local story_id="$1"
    local status="$2"   # "completed" | "failed"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"
    local lock_file="${messages_jsonl}.lock"

    # Always write — file is created by orchestration init for both bash and hybrid modes
    touch "$messages_jsonl"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local phase_id="${CURRENT_PHASE:-unknown}"
    local timestamp
    timestamp=$(date -Iseconds)
    local epoch
    epoch=$(date +%s)
    local msg_id="status_${story_id}_${epoch}"

    local message
    message=$(jq -cn \
        --arg id      "$msg_id" \
        --arg ts      "$timestamp" \
        --arg from    "$agent_role" \
        --arg to      "orchestrator" \
        --arg sid     "$story_id" \
        --arg pid     "$phase_id" \
        --arg subj    "Story $story_id $status" \
        --arg body    "Story $story_id finished with status: $status" \
        --arg sstatus "$status" \
        '{
            id: $id, timestamp: $ts,
            from_agent: $from, to_agent: $to,
            story_id: $sid, phase_id: $pid,
            message_type: "status",
            priority: "normal",
            subject: $subj, body: $body,
            story_status: $sstatus,
            status: "new"
        }')

    touch "$messages_jsonl"
    (
        flock -w 10 200 || return 0
        echo "$message" | jq -c '.' >> "$messages_jsonl"
    ) 200>"$lock_file"
}

# _rejection_repeat_check <story_id> <key>
# Returns 0 when this exact rejection was ALSO the previous attempt's rejection.
#
# An identical rejection twice is evidence about the model, not the prompt.
# Live AMSD-2041 2026-07-30: metrolinx produced the same prescribed-helper
# rejection on attempts 2, 3 and 4 while the corrective sat in the prompt 21
# times over. Nothing about the next attempt differed, so nothing about its
# outcome could — $2.29 across three lanes, none delivered.
#
# Keyed on a STABLE key rather than the warning text, which carries the attempt
# number ("[attempt 2/8]") and so would never match itself. State lives in a
# file because the caller sits several scopes below the story loop; an empty key
# is never a repeat, so an attempt that failed for some other reason cannot
# inherit the last rejection and trigger a spurious escalation.
_rejection_repeat_check() {
    local _story_id="$1" _key="${2:-}"
    [ -z "$_key" ] && return 1
    local _state_dir="${LOG_DIR:-/tmp}"
    local _state_file="${_state_dir}/.rejection-${_story_id//[^A-Za-z0-9_-]/_}"
    local _prev=""
    [ -f "$_state_file" ] && _prev=$(cat "$_state_file" 2>/dev/null || echo "")
    printf '%s' "$_key" > "$_state_file" 2>/dev/null || true
    [ "$_key" = "$_prev" ] && return 0
    return 1
}

# run_tsc_verification <story_id> <output_file>
# Runs `tsc --noEmit` inside the retry loop (not after it) so a TypeScript
# compile failure re-enters the same failure-analyst/InferenceLadder path as
# any other verification failure, instead of silently exiting the phase with
# zero retries. The one-and-done exit at the outer story_tsc_gate() in
# run-agent-orchestration.sh remains only as a defensive last-resort check —
# this function is what actually gives tsc failures a chance to self-heal.
# Returns 0 (pass or skipped) or 1 (tsc errors found).
# _run_project_verification <project_root>
# Runs whatever the project declared in .epam/verification.json, via the verification plugin.
# Prints the checker's own output; exit status is the checker's. An undeclared project exits
# non-zero with a clear reason — never a silent pass, which is what the old
# `[ ! -f tsconfig.json ] && return 0` did for every non-TypeScript stack.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then
        echo "verification plugin missing at $_plugin"; return 2
    fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}

run_tsc_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    is_truthy "${SKIP_STORY_TSC_GATE:-}" && return 0
    # No stack precondition. runVerification reports UNKNOWN for a project that has declared
    # no check, and every caller treats non-zero as failure — so an undeclared repo is
    # refused rather than skipped. Counting a language's files here meant "skip", which
    # callers read as PASS: the fail-open the verification plugin exists to remove, moved
    # from the invocation to the condition.

    # NOTE: this gate used to skip test-engineer-role stories entirely ("they
    # extend existing files, not create TS modules"). That reasoning doesn't
    # hold: a .test.ts file is compiled/type-checked by tsc exactly like any
    # other .ts file, and a syntax error inside one is exactly what `tsc
    # --noEmit` catches. Removed 2026-07-12 after a live run showed EVERY
    # syntax-class error observed (unterminated strings, mismatched parens, a
    # stray-token typo) was in a .test.ts file written by a test-engineer
    # story — precisely the case this skip disabled the check for, forcing
    # each one through a full external `npm test` run + FailureAnalyst LLM
    # call + model-tier escalation to catch what tsc would have caught for
    # free in the same turn.

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"

    local _tsc_output _tsc_exit=0
    # The PROJECT's declared check, not a tool this engine names. Metrolinx's repos define
    # `check-types` as `tsc --noEmit --incremental` (gotransit) and plain `tsc` (metrolinx, which
    # EMITS) — so the hardcoded `./node_modules/.bin/tsc --noEmit` was running a different check
    # than the project's own, on every repo, for the life of this pipeline.
    # THE MANIFEST IS DETECTED FROM WHAT THE CODELINE HOLDS NOW. Provisioning detects it at run
    # start, when a greenfield codeline holds nothing — its first story CREATES the manifest the
    # detection reads (requirements.txt, package.json). Detected again here, after the attempt,
    # so a codeline that has just acquired an ecosystem is checked by that ecosystem's own
    # command rather than failed for a check nobody could run (£0 greenfield harness, 2026-09-13).
    # Idempotent and precedence-preserving: what the project or the operator declared still wins.
    _epam_write_verification_manifest "$PROJECT_ROOT" >/dev/null 2>&1 || true
    _tsc_output=$(_run_project_verification "$PROJECT_ROOT" 2>&1) || _tsc_exit=$?

    # NOT DECLARED IS NOT FAILED. _run_project_verification exits 2 when the project declares no
    # typecheck command, and every non-zero exit used to become "TypeScript errors — fix them so
    # tsc exits 0". There are none to fix: live 2026-08-18, mock-a's `npx tsc --noEmit` exited 0
    # while the plugin's own verdict was "verification manifest declares no typecheck command".
    # The writer spent its attempts hunting errors that did not exist, HealingBroken fired on the
    # repeated diagnosis, and the analyst eventually said so outright. The sibling lane proves the
    # remedy: mock-b's writer added the block and its verification returns pass.
    #
    # Refusing an undeclared check stays — an undeclared repo must never silently pass. Only what
    # the writer is TOLD changes: declare the command, do not chase type errors.
    if [ "$_tsc_exit" -eq 2 ]; then
        warning "  [typecheck] $story_id: the project declares no typecheck command — the check could not run"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator could not run this project'"'"'s type check because the verification manifest does not declare one. This is NOT a type error in your code — nothing was checked.\n\nDeclare the command in `.epam/verification.json` alongside the existing `test` entry, taking it from the project'"'"'s own manifest — read it and use whatever this project already declares — in this shape:\n\n```json\n"typecheck": { "command": "<the project'"'"'s own type-check command>" }\n```\n\nThe orchestrator reported:\n\n```\n%s\n```\n' \
            "$_tsc_output")
        return 1
    fi

    if [ "$_tsc_exit" -ne 0 ]; then
        # Brownfield: a large existing repo can have pre-existing tsc errors in
        # files no story ever touches (live, 2026-07-22 — Redis/Stripe/OTel type
        # declarations, a jsonwebtoken signature mismatch, unrelated to AMSD-1820's
        # Mozio/promo-discount work). Whole-project `tsc --noEmit` fails identically
        # for every story regardless of what it changed, and no amount of model
        # escalation can fix errors in files the story never touches — confirmed by
        # HealingBroken firing 4+ times on the exact same unrelated diagnosis before
        # exhausting all 8 retries. Fix: diff against a baseline error set captured
        # from JIRA_BASELINE_BRANCH (the same baseline review-ranger/mutant-hunter
        # already use) — only fail on errors NEW relative to that baseline, i.e.
        # errors this story's own changes actually introduced.
        # ONE IMPLEMENTATION, in lib/tsc-baseline-gate.sh. This block was one of four copies of
        # the same baseline-delta logic, each with its own tsc error regex and its own
        # node_modules literal. On a repo whose checker speaks a different dialect the regex
        # matched nothing, the baseline set came back empty, there was nothing to subtract, and
        # the gate reported PASS having verified nothing — four independent fail-open paths.
        #
        # The already-captured output is handed in: this runs per ATTEMPT, up to 8 times a story,
        # and re-running the check here would multiply the most expensive gate in the run.
        local _new_errors="$_tsc_output"
        if command -v baseline_new_failures >/dev/null 2>&1; then
            local _tsc_out_file _delta_rc=0 _delta_out
            _tsc_out_file=$(mktemp)
            printf '%s' "$_tsc_output" > "$_tsc_out_file"
            _delta_out=$(baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                "$LOG_DIR" typecheck "$_tsc_out_file") || _delta_rc=$?
            rm -f "$_tsc_out_file"
            [ "$_delta_rc" -eq 0 ] && _new_errors="" || _new_errors="$_delta_out"
        fi

        # EVERY FAILURE WAS PRE-EXISTING. The check is red, but nothing here is this story's
        # doing, so the story passes — that is the entire purpose of the baseline diff, and the
        # operator policy it implements: inherit what the codeline already had, never add to it.
        #
        # This guard was lost when the inline baseline block was replaced by the shared library,
        # and an empty delta fell straight through to the failure branch below — reporting
        # "TypeScript errors" with an EMPTY error list, which is how it was caught.
        if [ -z "$(echo "$_new_errors" | tr -d '[:space:]')" ]; then
            success "  [typecheck] $story_id: the type check has only pre-existing baseline errors — none introduced by this story"
            return 0
        fi

        warning "  [typecheck] $story_id: the project type check rejects the change — feeding into retry loop"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran the project type check after your files were written and it failed (exit code %d). Fix the errors so the declared type check exits 0.\n\n```\n%s\n```\n' \
            "$_tsc_exit" "$_new_errors")
        {
            echo ""
            echo "=== the project type check failed (exit $_tsc_exit) — new errors introduced by this story ==="
            echo "$_new_errors" | head -n "$(evidence_window typecheckErrorLines)"
        } >> "$output_file"
        return 1
    fi

    success "  [typecheck] $story_id: the project type check passed"
    return 0
}

# review_and_correct_plan <story_id> <plan_text>
# Gate between the plan-turn and the execute-turn: catches a hallucinated file
# path/API in the plan BEFORE any code is written, using the same ground-truth
# dependency contracts (.contracts/<dep_id>.md) already proven to fix this class
# of bug for implementation prompts (see the "Spec-reality cross-check" comment
# in build_implementation_prompt()). Without this gate, run_planning_phase()'s
# output was previously injected as fixed context completely unreviewed — a
# wrong plan would be followed just as faithfully as a right one.
# Bounded to exactly ONE corrective re-plan (same "one bounded retry" pattern as
# the split-mandate gate and escalation-resolution elsewhere in this file) —
# never an unbounded loop.
# Echoes the final plan text (corrected if a fix was applied, original otherwise).
review_and_correct_plan() {
    local story_id="$1"
    local plan_text="$2"
    [ -z "$plan_text" ] && { echo "$plan_text"; return; }

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")

    # Extract declared output files — needed to catch output-path hallucinations
    # even when there are no dependency contracts to check against.
    local _review_declared_files
    _review_declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")

    local dependency_contracts=""
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        if [ -f "$_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
        fi
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    # Skip the LLM review if there are no dependency contracts AND no declared
    # output files — nothing ground-truth to check the plan against.
    if [ -z "$dependency_contracts" ] && [ -z "$_review_declared_files" ]; then
        echo "$plan_text"
        return
    fi

    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    [ -z "$_orch_provider" ] && { echo "$plan_text"; return; }

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-reviewer-vals-XXXXXX.json")
    jq_vals \
          --arg declared_output_files "$([ -n "$_review_declared_files" ] && printf '\n## Declared Output Files (EXACT paths the plan MUST write to)\n%s\n' "$_review_declared_files" || true)" \
          --arg dependency_contracts "${dependency_contracts}" \
          --arg plan_text "${plan_text}" \
          --arg story_id "${story_id}" \
          '{"__DECLARED_OUTPUT_FILES__":$declared_output_files,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__PLAN_TEXT__":$plan_text,"__STORY_ID__":$story_id}' > "$_cp_vals"
    local review_prompt
    review_prompt="$(render_engine_prompt plan-reviewer "$_cp_vals")"
    rm -f "$_cp_vals"

    # Tool access (HEAL-BLIND, 2026-07-31): this gate exists specifically to
    # catch a plan that CONTRADICTS reality, but until now had no way to check
    # anything beyond what dependency_contracts happens to cover (a story's
    # declared internal dependencies) — the identical gap that let the
    # failure-analyst confidently misdiagnose a fully-installed package as
    # missing. Reuses ORCH_GATE_ALLOWED_TOOLS verbatim, same shared allowlist
    # every other gate agent draws from. Bounded: this runs before EVERY
    # story's implementation, not just on retry.
    local review_output
    # Tool budgets below are 24, raised from 6 on 2026-08-09: codegraph_query states in its own
    # description that "5-10 times is normal", so a budget of 6 was exhausted by one tool's
    # documented usage with nothing read afterwards, leaving the one-shot grep as the only
    # affordable option. These bound TOOL calls, not model turns — a read is cheap next to the
    # wrong answer it prevents.
    #
    # NOT inside the continuation chain below: a `\` followed by a comment TERMINATES the
    # command. Placing it there silently split the pipeline, and the invocation ran with
    # nothing on stdin — which is exactly how the writer burned 8 attempts at $0 cost.
    review_output=$(echo "$review_prompt" | \
        EPAM_AGENT_NAME="plan-reviewer" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${EPAM_MODEL:-}" \
        EPAM_CLI="$EPAM_CLI" \
        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
        EPAM_MAX_TOOL_CALLS="${PLAN_REVIEW_MAX_TOOL_CALLS:-24}" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${EPAM_MODEL:+--model "$EPAM_MODEL"} \
        2>/dev/null || echo "")

    # Robust JSON extraction (not a flat-object regex — see the identical bug
    # fixed live in team-lead-review.sh/code-review-cycle.sh, 2026-07-07: a
    # pretty-printed or otherwise non-single-line response silently fails a
    # naive '{.*"verdict".*}' grep). raw_decode correctly parses regardless of
    # formatting/whitespace.
    local review_json
    review_json=$(echo "$review_output" | python3 "$SCRIPT_DIR/lib/handlers/plan-review-json.py" 2>/dev/null || echo "")
    [ -z "$review_json" ] && { echo "$plan_text"; return; }

    local verdict corrections
    verdict=$(echo "$review_json" | jq -r '.verdict // "ok"' 2>/dev/null || echo "ok")
    if [ "$verdict" != "mismatch" ]; then
        echo "$plan_text"
        return
    fi

    corrections=$(echo "$review_json" | jq -r '.corrections // ""' 2>/dev/null || echo "")
    warning "  PlanReview: mismatch detected for $story_id against dependency contracts — one corrective re-plan"

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-corrective-vals-XXXXXX.json")
    jq_vals \
          --arg corrections "${corrections}" \
          --arg plan_text "${plan_text}" \
          --arg story_id "${story_id}" \
          '{"__CORRECTIONS__":$corrections,"__PLAN_TEXT__":$plan_text,"__STORY_ID__":$story_id}' > "$_cp_vals"
    local corrective_prompt
    corrective_prompt="$(render_engine_prompt plan-corrective "$_cp_vals")"
    rm -f "$_cp_vals"

    local corrected_plan
    corrected_plan=$(echo "$corrective_prompt" | \
        EPAM_AGENT_NAME="plan-corrective" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${STORY_PLANNER_MODEL:-${EPAM_MODEL:-}}" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${STORY_PLANNER_MODEL:+--model "$STORY_PLANNER_MODEL"} \
        2>/dev/null || echo "")

    if [ -n "$corrected_plan" ]; then
        echo "$corrected_plan"
    else
        echo "$plan_text"
    fi
}

classify_invocation_refusal() {
    local _out="${1:-}" _exit="${2:-1}"
    [ "$_exit" -ne 0 ] || return 1
    [ -n "$_out" ] && [ -f "$_out" ] || return 1

    # The CLI's own argument-parser wording. Anchored on "option ... argument ... invalid" rather
    # than on any one flag: the next flag to move its accepted range must land here too.
    local _line
    _line=$(grep -m1 -aE "^error: (option|unknown option|required option)" "$_out" 2>/dev/null || true)
    [ -n "$_line" ] || return 1

    local _opt
    # NO `| head -1`: under pipefail head closes the pipe, grep dies of SIGPIPE and the assignment
    # fails on a line that matched perfectly well. grep -m1 already stops at the first match, so the
    # head was redundant as well as harmful. Caught by sigpipe-under-pipefail.bats — a suite that had
    # never executed until the day this line was written.
    _opt=$(printf '%s' "$_line" | grep -oE -m1 -- "--[a-z0-9-]+" || true)
    warning "  Coordinator[L1]: the CLI REFUSED its own command line -- ${_opt:-<option>} is not"
    warning "    acceptable to the installed binary, so every retry fails identically before any"
    warning "    token is sent. Not retryable. Fix the flag, then re-run."
    warning "    ${_line}"
    return 0
}

# Invoke Claude CLI to implement a story
implement_story() {
    local story_id=$1

    # WHO MAY AUTHOR CODE — checked before any work, not after.
    #
    # Capability comes from the seam: anything running here holds write_file and bash, which
    # is correct for an agent whose job is to author code. So the boundary that matters is
    # WHICH agent reaches this seam. Until now that was guarded in exactly one place —
    # assignment offering only registered implementers — and perimeter_role_may_write, which
    # exists and is tested, was called by nothing in production.
    #
    # Single-layer protection is thin now that the roster is GENERATED rather than curated.
    # A hand-edited PRD at the roster pause, a resume carrying a stale assignment, or any
    # future path that bypasses candidateRoles would put a read-only investigator at the
    # writer seam with full writer tools, and nothing would object: the chmod perimeter
    # decides by branch and worktree, never by who.
    #
    # Fails CLOSED and LOUD. A story whose role may not write stops here rather than
    # producing changes nobody sanctioned.
    if command -v perimeter_role_may_write >/dev/null 2>&1; then
        local _iw_role
        # PER CODELINE. A story spanning three repositories carries one role per codeline in
        # agentRoles; agentRole is only the primary. Reading the primary in every lane is how a
        # role briefed for one codeline ends up working in another.
        _iw_role=$(jq -r --arg id "$story_id" --arg cl "${EPAM_CODELINE:-}" \
            '.stories[] | select(.id == $id)
             | (.agentRoles[$cl] // .agentRole // "")' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ -n "$_iw_role" ] && ! perimeter_role_may_write "$_iw_role"; then
            error "Story ${story_id} is assigned to '${_iw_role}', which is not permitted to author code."
            error "  Implementers are registered in project-roles.json; investigators are read-only by design."
            error "  Refusing to run the writer — an agent that may not write must not reach the writer seam."
            return 1
        fi
    fi
    # Seeded from persisted state, NOT hardcoded 0 — a Step 3.6 review
    # rejection re-invokes this whole script as a brand-new process, and
    # without this the ladder silently restarted at rung 0 every review
    # cycle (see lib/story-retry-state.sh's docstring for the live incident
    # this fixes). Cleared for free by teardown at the start of every run,
    # since the state file lives under LOG_DIR.
    local retry_count
    retry_count="$(escalation_start_retry_count "$(read_story_retry_count "$LOG_DIR" "$story_id")" "$MAX_RETRIES")"
    if [ "$retry_count" -gt 0 ] 2>/dev/null; then
        log "  [InferenceLadder] $story_id resuming at retry_count=$retry_count (persisted from an earlier invocation)"
    fi
    # Shadows the script-global MAX_RETRIES for the duration of THIS story
    # only. run_retry_extension_coordinator() (below) can bump this local
    # copy when it grants a bounded extension -- shadowing it here (rather
    # than mutating and manually restoring the global) means bash itself
    # guarantees the original value comes back on EVERY exit path from this
    # function (success mid-loop return, or the failure path at the bottom),
    # with no risk of a granted extension leaking into the NEXT story's
    # budget in the same claude.sh process.
    local MAX_RETRIES="$MAX_RETRIES"
    local _retry_extension_used=0
    local _budget_warned=0
    # Set by _rejection_repeat_check below when the SAME rejection fires twice
    # in a row — same input, same wrong output is exactly what temperature
    # exists to break out of. Read once, right after the rung case statement
    # sets its own baseline temperature, so the bump applies on top regardless
    # of which rung fired.
    local _repeat_rejection_detected=false
    # These are GLOBALS (set by verify_story_deliverables, no `local` there —
    # same pattern as STORY_REJECTION_KEY), so a fresh story must not inherit
    # whatever the PREVIOUS story's last verification call left behind before
    # this story has ever called verify_story_deliverables itself.
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    # Which rung's contribution the NEXT attribution call should credit
    # changes to (backlog #113) — updated every rung transition, read at the
    # NEXT one and again at the story's own success path.
    local _last_attributed_rung=0
    # Caps free retries granted for deterministic-check failures (see
    # DETERMINISTIC_CHECK_FAILURE) — these don't count against retry_count/the
    # ladder, but an unbounded free-retry loop is still a real risk if a check
    # keeps finding a violation the agent can't seem to fix. After this many
    # free retries, fall through to a normal counted retry instead.
    local _free_retry_count=0
    # Counts every actual invocation (unlike retry_count, which free retries
    # deliberately do NOT advance) — used to gate COORDINATOR_PROMPT_AMENDMENT
    # injection below ("is this the first attempt of THIS story or not").
    local _total_attempts=0
    # FREE RETRIES ARE FREE OF THE ESCALATION BUDGET TOO. A retry granted as free — after an
    # escalation this story raised was resolved, or a deterministic check — went back to the loop
    # condition, which counted it against an escalated call's budget (1): the promised retry never
    # ran, so a fix brought in from a nested escalation was never tried (£0 escalation-chain run 6:
    # "Resolved — free retry for ESC-002", then "did not converge" with no attempt between).
    local _free_attempts=0
    # Tracks the last deterministic-check violation message for this story, so a
    # repeat can be detected WITHOUT going through run_failure_analyst (which
    # deterministic-check failures deliberately skip). Confirmed live (run #15,
    # 2026-07-05): without this, the SAME relative-import-check violation
    # repeated 5 times across free AND counted retries with no escalation at
    # all, because check_healing_effectiveness's repeat detector only runs
    # inside run_failure_analyst.
    local _prev_deterministic_violation=""
    # run_implementation() processes multiple stories in one claude.sh
    # invocation; COORDINATOR_PROMPT_AMENDMENT is a script-global set by the
    # previous story's failure-analyst/deterministic-check path and was never
    # reset between stories, so a stale amendment from story A could otherwise
    # leak into story B's first attempt.
    # AN ESCALATED FIX IS TOLD WHAT TO FIX, FROM ITS FIRST ATTEMPT: resolve_escalation hands the
    # brief in EPAM_ESCALATION_BRIEF for this call only, and it seeds the amendment that every
    # attempt of this call carries (see the injection below).
    local _escalation_brief="${EPAM_ESCALATION_BRIEF:-}"
    COORDINATOR_PROMPT_AMENDMENT="$_escalation_brief"
    local output_file
    output_file="$CLAUDE_OUTPUT_DIR/${story_id}_$(date +'%Y%m%d_%H%M%S').log"
    local story_started_at
    story_started_at=$(date -Iseconds)

    local title
    title=$(get_story_title "$story_id")
    log "Implementing story: $story_id - $title"
    update_monitor_status "start" "$story_id"

    # Check dependencies first
    if ! are_dependencies_satisfied "$story_id"; then
        local deps
        deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
        error "Cannot implement $story_id - dependencies not satisfied: $deps"
        return 1
    fi

    # Plan mode check: run planning agent before implementation if complexity thresholds met
    if check_plan_mode_required "$story_id"; then
        log "Plan mode required for $story_id (estimatedHours>=6, deps>=2, or flag set)"
        run_plan_mode "$story_id"
    fi

    # Resolve effort -> model + max-turns for this story (stable across retries)
    resolve_effort_settings "$story_id"
    # Resolve generator mode — overrides effort settings when agentRole=generator
    resolve_generator_settings "$story_id"
    # Bump the iteration/token budget one tier for test-engineer stories —
    # see resolve_test_engineer_effort_floor's own docstring for why.
    resolve_test_engineer_effort_floor "$story_id"
    # Floor the output/iteration budget for brownfield reasoning-model runs so
    # the <think> block + the actual edit both fit in one response — see
    # resolve_brownfield_effort_floor's docstring (found live: reasoning
    # truncated mid-think before writing → "deliverables UNCHANGED").
    resolve_brownfield_effort_floor "$story_id"
    log "  Effort[final] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"

    # ── Self-heal KB (pillar 3: enforcement) ─────────────────────────────────
    # Applied AFTER effort resolution and BEFORE the invocation, so a learned
    # constraint overrides the computed default rather than being overwritten by
    # it. Arrives as parameters, never as prompt text. Flag-guarded and inert by
    # Always on — self-heal is not optional (switch removed 2026-07-25).
    if true; then
        local _kb_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_lib"
            kb_apply_constraints "${STORY_ROLE:-}" "story:${story_id:-}" || true
            # Pillar 2: rules that fired stay alive, rules that did not age toward
            # their TTL and are archived for re-validation instead of trusted forever.
            kb_tick "${KB_LAST_FIRED:-}" || true
            [ -n "${KB_LAST_FIRED:-}" ] && \
                log "  Effort[KB] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS} (${KB_LAST_FIRED})"
        fi
    fi
    # Resolve aiProvider -> which CLI binary to use
    resolve_provider_settings "$story_id"
    # Resume the MODEL the ladder had climbed to, not just the counter.
    #
    # MUST sit AFTER resolve_provider_settings: that function re-derives STORY_MODEL from the
    # PRD, so seeding before it had the persisted model silently overwritten and the ladder
    # restarted its climb on every re-invocation. Observed live 2026-08-10 — the .model file
    # was written correctly and the 'resuming on' line never appeared once.
    STORY_ITERATION_BUMP_TOTAL="$(read_story_iteration_bump "$LOG_DIR" "$story_id")"
    export STORY_ITERATION_BUMP_TOTAL
    local _persisted_model
    _persisted_model="$(read_story_retry_model "$LOG_DIR" "$story_id")"
    # A PERSISTED RUNG FROM A DIFFERENT PROVIDER SET IS NOT A RUNG TO RESUME. See
    # change-log/SEAM-CONSISTENCY-ANALYSIS.md — an operator swaps EPAM_PROVIDER_SET because a
    # provider ran out of tokens mid-run, and the persisted model name (e.g. "MiniMax-M3") is
    # meaningless once the set changes: it names a vendor's own namespace, not a portable model
    # id. Trusting it under a DIFFERENT set pairs a valid new-set provider with a model name that
    # provider has never heard of — the same "model and provider are one decision" defect this
    # file already fixed once for a different cause (2026-08-18), reintroduced here by a swap
    # instead of a missed re-derivation.
    #
    # An EMPTY persisted set is NOT evidence of a mismatch — it means this state predates the
    # marker (a run in flight when this shipped) or the launch itself declares no set. Either way
    # there is nothing to contradict, so the existing model is still trusted, exactly as before.
    local _persisted_set
    _persisted_set="$(read_story_retry_provider_set "$LOG_DIR" "$story_id")"
    if [ -n "$_persisted_set" ] && [ "$_persisted_set" != "${EPAM_PROVIDER_SET:-}" ]; then
        log "  [InferenceLadder] $story_id: persisted rung '$_persisted_model' was chosen under set '$_persisted_set', but this launch is '${EPAM_PROVIDER_SET:-<none>}' — discarding it and starting this set's own ladder from the top"
        _persisted_model=""
    fi
    if [ -n "$_persisted_model" ] && [ "$_persisted_model" != "${STORY_MODEL:-}" ]; then
        log "  [InferenceLadder] $story_id resuming on '$_persisted_model' (escalated in an earlier invocation; PRD model is '${STORY_MODEL:-}')"
        STORY_MODEL="$_persisted_model"
        # A RESTORED RUNG IS NOT A DEFAULT TO BE RE-DERIVED.
        #
        # resolve_model_from_story() runs further down this same function and assigns STORY_MODEL
        # straight from prd.json whenever the story declares one — it cannot know a ladder position
        # was just restored. Live 2026-08-19 (AMSD-2041): the ladder reached moonshotai/kimi-k3,
        # produced the story's best attempt and committed it; the next re-implementation cycle
        # resumed on kimi-k3, was silently re-derived back to MiniMax-M3, and escalated from THERE
        # to z-ai/glm-5.2 — a step DOWN, immediately after reaching the top. Every re-implementation
        # crosses an invocation boundary, so the ladder could climb within an invocation and never
        # hold ground across one.
        #
        # This is the same defect the comment above already fixed for resolve_provider_settings,
        # recurring at the SECOND re-derivation below it.
        STORY_MODEL_LADDER_RESUMED="$_persisted_model"
        export STORY_MODEL_LADDER_RESUMED
        local _resumed_provider
        _resumed_provider=$(resolve_model_provider "$_persisted_model")
        [ -n "$_resumed_provider" ] && STORY_PROVIDER="$_resumed_provider"
    fi

    # Capture original model so phase R3 can detect whether R2 escalated it
    STORY_MODEL_ORIGINAL="${STORY_MODEL:-}"
    # Reset reasoning effort to default at story start (previous story's setting must not leak)
    export EPAM_REASONING_EFFORT="${EPAM_RUNG0_REASONING_EFFORT:-medium}"
    # Reset temperature override at story start (previous story's FailureDiversity
    # or escalation-triggered override must not leak into an unrelated story) —
    # but restore the launcher-provided floor (_claude_temperature_floor, captured
    # once at process start) rather than unsetting to nothing. Without this, a
    # project-wide pin (e.g. tier3-travel-app-run.sh's EPAM_TEMPERATURE=0 for GLM
    # models) would be wiped before the very first model call of every story.
    if [ -n "$_claude_temperature_floor" ]; then
        export EPAM_TEMPERATURE="$_claude_temperature_floor"
    else
        unset EPAM_TEMPERATURE
    fi
    # For epam-run providers, prd.json .model field overrides effort-based model
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    # A RECORDING OWNS THE CALL. This dispatch invokes the vendor CLI directly and never execs
    # ai-run.sh, so a rehearsal set EPAM_REPLAY_CASSETTE_DIR and the writer called claude anyway —
    # five attempts, ladder climbed to opus-5, "REHEARSAL: replaying" printed zero times.
    # Delegated, never reimplemented: llm-handler.sh owns replay and keeps owning it.
    if EPAM_AGENT_NAME="${STORY_WRITER_SEAM}" EPAM_STORY_ID="${story_id}" replay_delegate "$prompt" "$json_result_file" "$output_file" "${STORY_MODEL:-}"; then
        invoke_success=true
    else
    case "$STORY_PROVIDER" in
        codex) resolve_codex_model_settings "$story_id" ;;
        copilot|openai|openrouter|cursor|minimax) resolve_model_from_story "$story_id" ;;
    esac
    fi
    # prd-model-coordinator's .reasoningEffort field overrides the "low" reset above
    resolve_reasoning_effort_from_story "$story_id"
    # Resolve optional plannerModel — runs a planning pass before execution
    resolve_planner_settings "$story_id"
    # Resolve dynamic constitution rules for this story (appends to AGENT_CONSTITUTION)
    resolve_dynamic_constitution "$story_id"
    # Brownfield surgeon preamble — injected when EPAM_BROWNFIELD=1; never active in greenfield.
    # Rules numbered from 6 to extend the five already in AGENT_CONSTITUTION without overlap.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        # Rules 6-9 branch on storyKind — same lookup already used above for reasoning
        # effort (line ~5402), same story, reused rather than a second query. Found live
        # 2026-08-05 on AMSD-2041 (storyKind: novel, description is its own title
        # repeated): rule 6 as written asked the writer to "locate the existing code path
        # that handles the behavior" for a capability that does not exist yet, and rule 8
        # required the description to literally contain the word "create"/"add new"/
        # "build new" before permitting a new file — a trigger AMSD-2041's bare-title
        # description could never contain. A defect DOES have a known, bounded fix site;
        # a novel story does not, and forcing the same "find it, fix minimally, no new
        # files" framing onto both is the same defect-only-prompt blind spot already fixed
        # in the code-graph-detective (spec-mode-runner.js) and SPEC_AGENT prompts.
        _bfw_story_kind=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .storyKind // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        # Surgeon-mode rules come from orchestrations/config/agent-contract.json, rendered by
        # lib/render-prompt-section.js — a real file, not `node -e`, because the inline form
        # broke this script three times: the JS carries braces and quotes that must survive a
        # double-quoted shell string inside a command substitution.
        #
        # The two rules shared by both modes are defined ONCE in the catalog. They were
        # copy-pasted into each arm of this branch, byte-identical, nine lines apart, and each
        # copy then had to be maintained separately.
        _bfw_section="brownfieldExisting"
        [ "$_bfw_story_kind" = "novel" ] && _bfw_section="brownfieldNovel"
        _bfw_rules=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
            "$SCRIPT_DIR/../config/agent-contract.json" "$_bfw_section" "_startIndex=6" 2>/dev/null || echo "")
        if [ -n "$_bfw_rules" ]; then
            DYNAMIC_CONSTITUTION="${DYNAMIC_CONSTITUTION}"$'\n\n'"${_bfw_rules}"
        fi
    fi
    # GAP-P17: inject outputSchema instruction when story defines one
    local schema_block=""
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_output_schema
    story_output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_output_schema" ]; then
        schema_block=$'\n\nOUTPUT SCHEMA REQUIREMENT:\nYou MUST conclude your response with a JSON object that conforms to the following JSON Schema. Wrap it in a ```json code block.\n```json\n'"$story_output_schema"$'\n```'
        log "  OutputSchema: structured output required for $story_id"
    fi
    # Build effective constitution = static base + dynamic rules + optional schema block.
    # Mirrors CLAUDE_PERMISSIONS: empty in interactive mode (no skip-permissions).
    local effective_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}${schema_block}"
    local effective_permissions=()
    if [ ${#CLAUDE_PERMISSIONS[@]} -gt 0 ]; then
        effective_permissions=(
            "--dangerously-skip-permissions"
            "--append-system-prompt"
            "$effective_constitution"
        )
    fi
    local model_flag=()
    [ -n "${STORY_MODEL:-}" ] && model_flag=(--model "$STORY_MODEL")

    # THE CAPS THIS PATH NEVER HAD. `--max-turns` was built here from STORY_MAX_TURNS, and
    # BOTH halves were dead: the flag no longer exists in Claude Code (the env var
    # CLAUDE_CODE_MAX_TURNS replaced it), and STORY_MAX_TURNS was hardcoded "" in every effort
    # branch so it was never emitted. A flag that cannot fire is not a cap — which is how one
    # seam ran 1,486 generations in 44 minutes with nothing able to stop it.
    #
    # What replaces it names no knob: the runner's DECLARATION says which env vars and flags it
    # takes, and apply_runner_settings passes exactly those. A runner that declares nothing
    # gets nothing, so every other path behaves exactly as before.
    RUNNER_FLAGS=()
    apply_runner_settings "$(runner_name_for "${STORY_PROVIDER:-}" "$(basename "${CLAUDE_CMD:-}")")" "${EPAM_PROJECT_CONFIG_DIR:-}" || true
    local story_cli
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    story_cli=$(provider_to_cli "$STORY_PROVIDER")
    # THE DIRECTORIES THE PRD DECLARES ARE REACHABLE BY THE RUNNER. A runner confines its tools
    # to the working directory; regintel 20260916T200108Z (2026-09-17): the writer, now told the
    # PRD's configuration.sourceRepoReadOnly, was refused both Read and Bash on that path and
    # reported the wall instead of copying. Every absolute directory the PRD's configuration
    # names — whatever the key, the engine names none — is granted with the flag the installed
    # runner advertises for it (the same --help probe the schema and budget bindings use).
    local _rr _rr_flag=""
    if "$(runner_bin_for "${STORY_PROVIDER:-}" "${CLAUDE_CMD:-claude}")" --help 2>/dev/null | grep -q -- '--add-dir'; then _rr_flag="--add-dir"; else _rr_flag=""; fi
    if [ -n "$_rr_flag" ]; then
        while IFS= read -r _rr; do
            [ -n "$_rr" ] || continue
            RUNNER_FLAGS+=("$_rr_flag" "$_rr")
            log "  Runner may reach $_rr — a directory the PRD's configuration declares"
        done <<< "$(_declared_read_roots "$prd_target")"
    fi

    # Planning phase: when plannerModel is set, run one planning invocation first.
    # The returned plan is injected into every execution attempt as fixed context.
    local story_plan=""
    if [ -n "${STORY_PLANNER_MODEL:-}" ]; then
        log "  Running planning phase with $STORY_PLANNER_MODEL..."
        story_plan=$(run_planning_phase "$story_id" "$STORY_PLANNER_MODEL")
        story_plan=$(review_and_correct_plan "$story_id" "$story_plan")
        local plan_words
        plan_words=$(echo "$story_plan" | wc -w)
        log "  Planning phase complete ($plan_words words, reviewed)"
    fi

    while true; do
    # An escalated fix is bounded per escalation (escalation_budget_allows, story-retry-state.sh);
    # the rung persisted below is where the next escalation resumes. No budget → no effect.
    while [ $retry_count -le $MAX_RETRIES ] && escalation_budget_allows "$((_total_attempts - _free_attempts))"; do
        _total_attempts=$((_total_attempts + 1))
        # Inference ladder: on retry, escalate to a stronger model + increase reasoning effort.
        # Priority: PRD retryModel > EPAM_RETRY_MODEL env var > built-in get_model_ladder_step().
        # Principle: NEVER retry with the same model — every failure steps up. Logged visibly.
        if [ "$retry_count" -gt 0 ]; then
            # ── Rung-based inference ladder ────────────────────────────────────────
            # 2 attempts per rung: attempt 1 (cold), self-healing fires, attempt 2
            # (informed). Escalate only when entering a new rung.
            #
            # Rung 0 (retries 0-1): base model, base effort
            # Rung 1 (retries 2-3): same model, reasoning effort → medium
            # Rung 2 (retries 4-5): escalated model, reasoning effort → medium
            # Rung 3 (retries 6-7): escalated model, reasoning effort → high
            # ──────────────────────────────────────────────────────────────────────
            local _rung=$(( retry_count / 2 ))
            local _entering_rung=$(( retry_count % 2 == 0 ))   # 1 = first attempt of rung

            # A rung normally gets two attempts: the model's answer, then a
            # re-ask with self-heal guidance. That second attempt is only worth
            # paying for if something about it can differ. When the LAST attempt
            # was rejected for the exact same reason as the one before it, the
            # model has already read the corrective and declined it — live
            # AMSD-2041 2026-07-30 produced byte-identical prescribed-helper
            # rejections on attempts 2, 3 and 4 while the prompt named the helper
            # 21 times. Re-asking buys a copy of the last answer, so step the
            # ladder instead and put a different model on it.
            #
            # This does not make any model comply — that requires the requirement
            # to be structural rather than advisory (IMPL-PROSE). It stops paying
            # for the same refusal twice.
            if _rejection_repeat_check "$story_id" "${STORY_REJECTION_KEY:-}"; then
                _repeat_rejection_detected=true
                if [ "$_entering_rung" -ne 1 ]; then
                    log "  InferenceLadder[R${retry_count}]: identical rejection twice (${STORY_REJECTION_KEY}) — advancing the rung early rather than re-asking a model that already refused"
                    _entering_rung=1
                fi
            fi

            # skipLadder: set by spec-mode-runner.js (veryHighComplexity AC-count)
            # or lib/tc-writer-gate.sh (TC-fact-density). Both pre-assign the
            # ceiling model before the first attempt. skipLadder=true means
            # DOWNGRADE PREVENTION ONLY — if a higher ladder step exists above the
            # current model, escalation proceeds normally. Only when the ladder has
            # no higher step (get_model_ladder_step returns same or empty) does the
            # story stay at its current ceiling. Effort/iteration-budget escalation
            # always applies regardless of skipLadder.
            local _skip_ladder
            _skip_ladder=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .skipLadder // false' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo false)

            local _prev_model="${STORY_MODEL:-}"
            if [ "$_entering_rung" -eq 1 ]; then
                case "$_rung" in
                    1)
                        # Rung 1: same model, effort → medium. Temperature is
                        # env-overridable (EPAM_RUNG1_TEMPERATURE), not a fixed
                        # policy choice baked into the engine — a project may
                        # find its models need a different value here (e.g.
                        # GLM-5.1's own vendor guidance recommends 0.6-0.8 for
                        # complex multi-file work to avoid instruction drift;
                        # this project currently defaults lower). Default (0)
                        # preserves existing behavior for anything that hasn't
                        # opted in.
                        # FLOOR, not assignment. A rung transition used to overwrite effort outright, so rung 1
                        # set medium AFTER the per-retry escalation had raised it to max —
                        # de-escalating a struggling story. Operator rule: a retry never lowers
                        # effort. Rung 0 still ASSIGNS, because it is the story's starting point
                        # and must not inherit the previous story's ceiling.
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG1_REASONING_EFFORT:-medium}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG1_TEMPERATURE:-0}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung1"
                        # EVERY rung steps the model. Rung 1 used to hold the model fixed and
                        # raise effort only — so a story that failed twice retried on the SAME
                        # model, which is not a ladder. Observed live 2026-08-10: four attempts,
                        # MiniMax-M3 throughout, and the run read as "the ladder is stuck".
                        # Same resolution order as the other rungs: an explicit PRD retryModel or
                        # EPAM_RETRY_MODEL wins, otherwise the tier's configured chain.
                        local _retry_model_prd_r1 _ladder_step_r1 _escalated_r1
                        _retry_model_prd_r1=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        _escalated_r1="${_retry_model_prd_r1:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$_escalated_r1" ]; then
                            # Delegated to next_ladder_step — the ladder decision as a pure
                            # function, covered by next-ladder-step.test.ts (14 tests, three
                            # mutation-verified invariants). The arm keeps its logging and
                            # provider resolution; it no longer carries its own copy of the rules.
                            local _ladder_tier_r1 _decided_r1
                            _ladder_tier_r1=$(classify_ladder_tier "$story_id")
                            _decided_r1=$(next_ladder_step 1 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier_r1")
                            _ladder_step_r1="${_decided_r1%%|*}"
                            [ -n "$_ladder_step_r1" ] && [ "$_ladder_step_r1" != "${STORY_MODEL:-}" ] && _escalated_r1="$_ladder_step_r1"
                            local _decided_effort_r1="${_decided_r1#*|}"; _decided_effort_r1="${_decided_effort_r1%%|*}"
                            [ -n "$_decided_effort_r1" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r1"
                        fi
                        if [ -n "$_escalated_r1" ] && [ "$_escalated_r1" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung1/R${retry_count}]: model '${STORY_MODEL:-default}' → '$_escalated_r1'"
                            STORY_MODEL="$_escalated_r1"
                            local _prov_r1
                            _prov_r1=$(resolve_model_provider "$_escalated_r1")
                            [ -n "$_prov_r1" ] && STORY_PROVIDER="$_prov_r1"
                        else
                            log "  InferenceLadder[Rung1/R${retry_count}]: at the top of its chain — effort is the remaining lever"
                        fi
                        ;;
                    2)
                        # Rung 2: model escalation, effort → medium
                        # skipLadder=true means the story was pre-assigned a ceiling model by
                        # tc-writer-gate or spec-mode (very-high-complexity). We still compute the
                        # next ladder step — if one exists ABOVE the current model we apply it
                        # (upward escalation is always allowed). We only stay put when the ladder
                        # has nowhere higher to go (same model returned or no step found).
                        local retry_model_prd ladder_step_r2
                        retry_model_prd=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        local escalated_model_r2="${retry_model_prd:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$escalated_model_r2" ]; then
                            # Delegated to next_ladder_step — the ladder decision as a pure
                            # function (next-ladder-step.test.ts: 14 tests, 3 mutation-verified
                            # invariants). This arm keeps its skipLadder/HealingBroken handling,
                            # its logging and its provider resolution; it no longer carries its
                            # own copy of the escalation rules.
                            local _ladder_tier _decided_r2 _decided_effort_r2
                            _ladder_tier=$(classify_ladder_tier "$story_id")
                            _decided_r2=$(next_ladder_step 2 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier")
                            ladder_step_r2="${_decided_r2%%|*}"
                            [ -n "$ladder_step_r2" ] && [ "$ladder_step_r2" != "${STORY_MODEL:-}" ] && escalated_model_r2="$ladder_step_r2"
                            _decided_effort_r2="${_decided_r2#*|}"; _decided_effort_r2="${_decided_effort_r2%%|*}"
                            [ -n "$_decided_effort_r2" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r2"
                            log "  InferenceLadder[Rung2/R${retry_count}]: tier=${_ladder_tier}"
                        fi
                        if [ -n "$escalated_model_r2" ] && [ "$escalated_model_r2" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung2/R${retry_count}]: model '${STORY_MODEL:-default}' → '$escalated_model_r2' — effort → medium"
                            STORY_MODEL="$escalated_model_r2"
                            local _resolved_provider_r2
                            _resolved_provider_r2=$(resolve_model_provider "$escalated_model_r2")
                            [ -n "$_resolved_provider_r2" ] && STORY_PROVIDER="$_resolved_provider_r2"
                        else
                            # Stuck at ceiling — check if HealingBroken is confirmed in
                            # healing-events.jsonl. When skipLadder=true pre-assigns the ceiling
                            # model and self-healing hasn't converged, model diversity is the only
                            # remaining lever. Force HIGH-tier escalation so a different model
                            # gets a chance — skipLadder is downgrade-prevention, not a lock
                            # against upward escalation under confirmed healing failure.
                            local _healed_count=0
                            if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                _healed_count=$(python3 "$SCRIPT_DIR/lib/handlers/healing-event-count.py" "${LOG_DIR}/healing-events.jsonl" "$story_id" 2>/dev/null || echo 0)
                            fi
                            local _high_step=""
                            if [ "${_healed_count:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ]; then
                                # Forced HIGH-tier escalation under confirmed healing failure. Routed through
                                    # next_ladder_step so it obeys the same floor and
                                    # cannot-move rules as every other escalation.
                                    _high_step=$(next_ladder_step 2 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "high")
                                    _high_step="${_high_step%%|*}"
                                    [ "$_high_step" = "${STORY_MODEL:-}" ] && _high_step=""
                                if [ -n "$_high_step" ] && [ "$_high_step" != "${STORY_MODEL:-}" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step' for model diversity"
                                    STORY_MODEL="$_high_step"
                                    local _resolved_provider_r2h
                                    _resolved_provider_r2h=$(resolve_model_provider "$_high_step")
                                    [ -n "$_resolved_provider_r2h" ] && STORY_PROVIDER="$_resolved_provider_r2h"
                                fi
                            fi
                            if [ -z "$_high_step" ] || [ "$_high_step" = "${STORY_MODEL:-}" ]; then
                                if [ "$_skip_ladder" = "true" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → medium"
                                else
                                    log "  InferenceLadder[Rung2/R${retry_count}]: no ladder step — keeping model, effort → medium"
                                fi
                            fi
                        fi
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG2_REASONING_EFFORT:-high}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG2_TEMPERATURE:-0.3}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung2"
                        # Rung 2: bump output tokens to 8192 — a story that needed
                        # escalation is likely generating larger outputs than the
                        # baseline budget assumed; truncation at the original ceiling
                        # causes the same syntax error on every retry regardless of
                        # model capability (confirmed live: SKY-003-test-tc2 2026-07-18).
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "${EPAM_OUTPUT_FLOOR_PLANNING}" ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_OUTPUT_FLOOR_PLANNING}"
                        ;;
                    *)
                        # Rung 3+: escalate to the strongest configured model, effort → high (maximum).
                        #
                        # BUG (found live, 2026-07-04): this branch only ever escalated the model
                        # when the story had had ZERO prior escalation (STORY_MODEL == the
                        # original). But every story that reaches Rung 3 already escalated once at
                        # Rung 2 by construction — so that condition was always false here, and
                        # Rung 3 silently kept Rung 2's model, only bumping the reasoning-effort
                        # flag. Confirmed on SKY-004: attempts 5-8 all ran on z-ai/glm-5.2 (the
                        # MEDIUM-tier target); z-ai/glm-5.1 (the HIGH-tier target, configured
                        # specifically for hard stories) was never invoked in the entire 8-attempt
                        # cycle. Fix: if the story already escalated once, step it again — from
                        # whatever model Rung 2 landed on.
                        #
                        # BUG 2 (found live, 2026-07-05): this branch originally passed a hardcoded
                        # literal "high" to get_model_ladder_step, instead of the story's ACTUAL
                        # classified tier — silently pushing a "medium"-complexity story onto the
                        # HIGH ladder anyway, overriding what classify_ladder_tier() (now populated
                        # from real CPA complexity signals: cpaGate/effort, see
                        # contextualize-stories.sh) says this story needs. Fixed: call
                        # classify_ladder_tier() here too, same as Rung 2 — the PRD's classified
                        # tier is the ceiling all the way through the ladder, not just at Rung 2.
                        # skipLadder=true: same as Rung 2 — only prevents downgrade,
                        # upward escalation still applies if a higher step exists.
                        local _ffm="${EPAM_FINAL_FALLBACK_MODEL:-}" _ffp="${EPAM_FINAL_FALLBACK_PROVIDER:-}"
                        if [ -n "$_ffm" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_ORIGINAL:-}" ]; then
                            log "  InferenceLadder[Rung3/R${retry_count}]: no prior escalation — routing to fallback '$_ffm'"
                            STORY_MODEL="$_ffm"
                            [ -n "$_ffp" ] && STORY_PROVIDER="$_ffp"
                        else
                            local _ladder_tier_r3
                            _ladder_tier_r3=$(classify_ladder_tier "$story_id")
                            log "  InferenceLadder[Rung3/R${retry_count}]: tier=${_ladder_tier_r3}"
                            local ladder_step_r3
                            # Delegated to next_ladder_step — see next-ladder-step.test.ts.
                            local _decided_r3 _decided_effort_r3
                            _decided_r3=$(next_ladder_step 3 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier_r3")
                            ladder_step_r3="${_decided_r3%%|*}"
                            [ "$ladder_step_r3" = "${STORY_MODEL:-}" ] && ladder_step_r3=""
                            _decided_effort_r3="${_decided_r3#*|}"; _decided_effort_r3="${_decided_effort_r3%%|*}"
                            [ -n "$_decided_effort_r3" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r3"
                            if [ -n "$ladder_step_r3" ] && [ "$ladder_step_r3" != "${STORY_MODEL:-}" ]; then
                                log "  InferenceLadder[Rung3/R${retry_count}]: model '${STORY_MODEL:-default}' → '$ladder_step_r3' (${_ladder_tier_r3} tier)"
                                STORY_MODEL="$ladder_step_r3"
                                local _resolved_provider_r3
                                _resolved_provider_r3=$(resolve_model_provider "$ladder_step_r3")
                                [ -n "$_resolved_provider_r3" ] && STORY_PROVIDER="$_resolved_provider_r3"
                            else
                                # Same HealingBroken+skipLadder override as Rung 2: when stuck
                                # at ceiling and self-healing is confirmed broken, force HIGH tier.
                                local _healed_count_r3=0
                                if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                    _healed_count_r3=$(python3 "$SCRIPT_DIR/lib/handlers/healing-event-count.py" "${LOG_DIR}/healing-events.jsonl" "$story_id" 2>/dev/null || echo 0)
                                fi
                                local _high_step_r3=""
                                if [ "${_healed_count_r3:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ] && [ "$_ladder_tier_r3" != "high" ]; then
                                    _high_step_r3=$(get_model_ladder_step "${STORY_MODEL:-}" "high")
                                    if [ -n "$_high_step_r3" ] && [ "$_high_step_r3" != "${STORY_MODEL:-}" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step_r3'"
                                        STORY_MODEL="$_high_step_r3"
                                        local _resolved_provider_r3h
                                        _resolved_provider_r3h=$(resolve_model_provider "$_high_step_r3")
                                        [ -n "$_resolved_provider_r3h" ] && STORY_PROVIDER="$_resolved_provider_r3h"
                                    fi
                                fi
                                if [ -z "$_high_step_r3" ] || [ "$_high_step_r3" = "${STORY_MODEL:-}" ]; then
                                    if [ "$_skip_ladder" = "true" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → high (maximum)"
                                    fi
                                fi
                            fi
                        fi
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG3_REASONING_EFFORT:-high}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG3_TEMPERATURE:-0.7}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung3"
                        # Rung 3: bump output tokens to 12288 — at the strongest
                        # configured model, full file rewrites are expected; any
                        # prior token ceiling that caused truncation must be lifted.
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "${EPAM_OUTPUT_FLOOR_REVIEW}" ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_OUTPUT_FLOOR_REVIEW}"
                        log "  InferenceLadder[Rung3/R${retry_count}]: model='${STORY_MODEL:-default}' — effort → high"
                        ;;
                esac
                # Repeat-rejection temperature bump: the SAME model producing the
                # SAME rejection twice (_rejection_repeat_check above) is direct
                # evidence this exact input/temperature combination is stuck, not
                # just "this is a new rung now" — applied on top of whatever the
                # rung case above already set, additive and capped so it can't run
                # away across many repeats of the same story. EPAM_REASONING_EFFORT
                # is untouched: this targets sampling variance specifically, not effort.
                if [ "$_repeat_rejection_detected" = true ]; then
                    local _repeat_temp_bump="${EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP:-0.2}"
                    local _repeat_temp_max="${EPAM_REPEAT_REJECTION_TEMPERATURE_MAX:-1.0}"
                    local _bumped_temp
                    _bumped_temp=$(awk -v t="${EPAM_TEMPERATURE:-0}" -v b="$_repeat_temp_bump" -v m="$_repeat_temp_max" \
                        'BEGIN { r = t + b; if (r > m) r = m; printf "%.2f", r }')
                    log "  RepeatRejectionTempBump: ${EPAM_TEMPERATURE:-0} -> ${_bumped_temp} (identical rejection twice, model/temperature combination is stuck)"
                    export EPAM_TEMPERATURE="$_bumped_temp"
                fi
                # Rung/model contribution attribution (backlog #113): BEFORE
                # the reset decision below changes anything on disk,
                # attribute whatever changed since the LAST snapshot to the
                # rung/model that was JUST active — skipped on the story's
                # very first rung entry (retry_count 0), since there's no
                # PRIOR rung yet to attribute anything to.
                if [ "$retry_count" -gt 0 ]; then
                    _rung_attribute_changes "$story_id" "$_last_attributed_rung" "$_prev_model"
                fi

                # Selective worktree reset — only on a REAL rung transition
                # after at least one real attempt (retry_count 0 is the
                # story's very first attempt; there's nothing on disk yet to
                # reset FROM, and no valid LAST_VERIFIED_TOUCHED_FILES for
                # THIS story until verify_story_deliverables has run at least
                # once). See _selective_worktree_reset's own docstring.
                if [ "$retry_count" -gt 0 ]; then
                    _selective_worktree_reset "$story_id"
                fi

                # Snapshot the state THIS rung is starting from (post-reset-
                # decision) — the reference the NEXT transition's attribution
                # call compares against to see what THIS rung contributed.
                _rung_snapshot_hashes "$story_id"
                _last_attributed_rung="$_rung"
                # Emit ladder_rung event so agent-activity dashboard shows every escalation,
                # including prev→new model transition for observability.
                local _ladder_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_ladder_event_script" ]; then
                    local _ladder_role
                    _ladder_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_ladder_event_script" event "ladder_rung" \
                        "InferenceLadder Rung${_rung}/R${retry_count}: ${_prev_model:-default}→${STORY_MODEL:-default} effort=${EPAM_REASONING_EFFORT:-low}" \
                        "$story_id" "main" "${_ladder_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" "${_prev_model:-}" 2>/dev/null || true
                fi
            else
                log "  InferenceLadder[Rung${_rung}/R${retry_count}]: same rung — no escalation, self-heal guidance active"
                local _retry_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_retry_event_script" ]; then
                    local _retry_role
                    _retry_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_retry_event_script" event "retry" \
                        "Retry R${retry_count} Rung${_rung}: model=${STORY_MODEL:-default} (self-heal active)" \
                        "$story_id" "main" "${_retry_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
                fi
            fi
        fi

        # ── PERSIST THE RUNG THE WRITER IS ABOUT TO RUN ──────────────────────
        # Here, and not on a success path, because this is the point the rung is SETTLED:
        # the escalation block above has just finished moving model/provider/effort/temperature
        # for this attempt, and the invocation is below. Every attempt overwrites, so the record
        # always describes the setup that produced the newest output — which is the one the
        # reviewer is about to judge.
        #
        # The writer is a child process per story; the reviewer is a separate process. This file
        # is how the rung crosses, and it is the ONLY thing the reviewer consults.
        story_rung_record "$LOG_DIR" "$story_id"

        # Rebuild prompt each attempt: retry_count and KB ID must reflect current state
        local next_kb_id
        next_kb_id=$(get_next_kb_id)
        local prompt
        if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
            _impl_section="$(build_generator_prompt "$story_id")" || {
                error "  [prompt] build_generator_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # Same shape, same reason as the implementation branch below: a joined assignment takes
            # its status from the LAST substitution, so a refusal in the first is lost. This branch
            # has no refusal today, which is exactly when the hazard is cheap to remove.
            prompt="$_impl_section
$_kb_section"
        else
            _impl_section="$(build_implementation_prompt "$story_id")" || {
                error "  [prompt] build_implementation_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # SEPARATE ASSIGNMENTS, DELIBERATELY. Joined as
            #   prompt="$(build_implementation_prompt ...)\n$(build_kb_prompt_section ...)"
            # the assignment takes its status from the LAST substitution, so every `return 1` in
            # the builder was swallowed and `set -e` never fired. The writer was then invoked with
            # the empty first line plus the KB section — no story, no criteria, no plan — and
            # produced something confident that got committed. A blank that looks ordinary is the
            # worst failure this pipeline can have.
            prompt="$_impl_section
$_kb_section"
        fi
        # Inject execution plan when planner/executor split is active
        if [ -n "${story_plan:-}" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
            jq_vals \
                  --arg story_plan "$story_plan" \
                  --arg prompt "$prompt" \
                  '{"__STORY_PLAN__":$story_plan,"__PROMPT__":$prompt}' > "$_cp_vals"
            _render_out="$(render_or_keep writer-plan-section "$_cp_vals" execution_plan)" && prompt="$_render_out"
            rm -f "$_cp_vals"
        fi

        # Inject coordinator prompt amendment when available (retry attempts only).
        # Uses _total_attempts, not retry_count — a free retry (deterministic-check
        # failure) doesn't advance retry_count, but it IS a real subsequent attempt
        # and must still see the guidance from what just failed.
        # WHAT THE LAST ATTEMPT DID — facts, before anyone's opinion about them.
        #
        # The writer was told what was WRONG and never what it DID, so it could not tell "I tried
        # this and it was rejected" from "I have not tried anything" and re-derived approaches it
        # had already been told were wrong. Placed BEFORE the coordinator's one-line inference so
        # the evidence is read first and the judgement second.
        # PUBLISHED, NOT APPENDED — and not gated on an attempt counter.
        #
        # This used to be `if [ "$_total_attempts" -gt 1 ]`, a variable local to this function.
        # The review cycle re-invokes the writer as a NEW PROCESS, where that counter starts at
        # zero, so the writer being asked to fix its own work was never told what its own work
        # was. Recorded as TF-1 in TESTING-FAILURES.md.
        #
        # What is on disk does not depend on which process asks. The engine publishes it; every
        # agent that DECLARES attempt-evidence receives it — the writer and both failure analysts
        # today, the reviewer the moment it declares it. Empty publishes nothing, so a first
        # attempt carries no section.
        # WAS THERE A PREVIOUS ATTEMPT? Asked of DURABLE state, not a process-local counter.
        # read_story_retry_count persists in story-retry-state/ and is cleared by the pre-run
        # reset, so it answers the same question across a re-invocation — which is precisely
        # where _total_attempts failed.
        #
        # It matters because _attempt_change_summary never returns empty: when nothing changed it
        # says so in words, and that sentence is the important one (a previous attempt that wrote
        # NOTHING must be reported, not silently omitted). Published unconditionally it would tell
        # a FIRST attempt that a previous attempt changed no files, which is a lie the writer has
        # no way to check.
        local _prior_attempts
        _prior_attempts=$(read_story_retry_count "$LOG_DIR" "$story_id" 2>/dev/null || echo 0)
        if [ "${_prior_attempts:-0}" -gt 0 ] || [ "$_total_attempts" -gt 1 ]; then
            publish_agent_output engine attempt-evidence "$story_id" "$(_attempt_change_summary "$story_id")"
        fi

        if { [ "$_total_attempts" -gt 1 ] || [ -n "$_escalation_brief" ]; } && [ -n "${COORDINATOR_PROMPT_AMENDMENT:-}" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
            jq_vals \
                  --arg coordinator_prompt_amendment "${COORDINATOR_PROMPT_AMENDMENT}" \
                  --arg retry_count "${retry_count}" \
                  --arg prompt "$prompt" \
                  '{"__COORDINATOR_PROMPT_AMENDMENT__":$coordinator_prompt_amendment,"__RETRY_COUNT__":$retry_count,"__PROMPT__":$prompt}' > "$_cp_vals"
            _render_out="$(render_or_keep writer-plan-section "$_cp_vals" coordinator_guidance_full)" && prompt="$_render_out"
            rm -f "$_cp_vals"
        fi

        # Prompt-size scratchpad summarization (found live, 2026-07-07): each retry
        # PREPENDS a new "## Self-Heal: Failure Analyst Summary"/coordinator-guidance
        # block onto COORDINATOR_PROMPT_AMENDMENT without ever dropping older ones —
        # by attempt 4-5 within a single claude.sh invocation the cumulative prompt
        # is measurably larger than attempt 1's, and a model reasoning over a bigger
        # prompt can legitimately take long enough to blow the watchdog's timeout
        # budget for that story. Root cause was misread at first as model/API
        # instability (see the hot-swap mechanism above) — a live process
        # inspection confirmed a genuine, still-connected, in-flight API call, not a
        # stuck/crashed one; the real issue is unbounded prompt growth.
        # Fix: once the prompt exceeds a configurable size, persist the FULL prompt
        # (with complete retry history) to a scratchpad file for audit/debugging,
        # then trim the in-prompt coordinator guidance down to only the MOST
        # RECENT "## "-headed section — the model still gets the latest, most
        # relevant guidance; it just isn't re-reading every prior attempt's guidance
        # every single retry. Opt-out: EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=0
        # disables trimming entirely.
        # Both trim budgets come from orchestrations/config/spec-mode-defaults.json — see
        # lib/prompt-budget.sh. They were literals here; live 2026-08-09 a writer's prompt hit
        # 53366 chars against the threshold and ran with most of its coordinator guidance
        # discarded, which is exactly the value an operator needs to reach without editing code.
        local _scratchpad_threshold _keep_sections
        _scratchpad_threshold="$(prompt_trim_threshold)" || return 1
        _keep_sections="$(prompt_trim_keep_sections)" || return 1
        if [ "$_scratchpad_threshold" -gt 0 ] && [ "${#prompt}" -gt "$_scratchpad_threshold" ]; then
            local _scratchpad_dir="${LOG_DIR}/kb-scratchpad"
            mkdir -p "$_scratchpad_dir" 2>/dev/null || true
            local _scratchpad_file="${_scratchpad_dir}/${story_id}-attempt-$((retry_count + 1)).md"
            printf '%s' "$prompt" > "$_scratchpad_file" 2>/dev/null || true

            local _trimmed_amendment
            # Keep the last 3 headings, not just 1 (fixed 2026-07-11, after a live
            # run repeated an identical mistake 5 retries after already being told
            # not to): retry-0's diagnosed fix ("don't reuse validation logic
            # across flags") became invisible to retry 5's prompt the moment a
            # NEWER heading (e.g. a missing-export fix) pushed the trim window past
            # it -- the guidance was still archived in COORDINATOR_PROMPT_AMENDMENT
            # and the scratchpad file, but never shown to the model again, so it
            # repeated the exact mistake it had already been corrected on. Keeping
            # the last 3 distinct headings instead of 1 still bounds prompt growth
            # (the original purpose of this trim) while giving recent-but-not-
            # newest guidance a real chance to stay visible for a few more retries.
            _trimmed_amendment=$(printf '%s' "$COORDINATOR_PROMPT_AMENDMENT" | EPAM_PROMPT_TRIM_KEEP="$_keep_sections" EPAM_PROMPT_SCRATCHPAD_FILE="$_scratchpad_file" python3 "$SCRIPT_DIR/lib/handlers/trim-coordinator-amendment.py" 2>/dev/null || echo "$COORDINATOR_PROMPT_AMENDMENT")

            if [ -n "$_trimmed_amendment" ] && [ "${#_trimmed_amendment}" -lt "${#COORDINATOR_PROMPT_AMENDMENT}" ]; then
                warning "  [PromptScratchpad] Prompt exceeded ${_scratchpad_threshold} chars ($(( ${#prompt} )) actual) — full history written to $_scratchpad_file, trimming to most recent guidance (up to 3)"
                if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
                    _impl_section="$(build_generator_prompt "$story_id")" || {
                error "  [prompt] build_generator_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # Same shape, same reason as the implementation branch below: a joined assignment takes
            # its status from the LAST substitution, so a refusal in the first is lost. This branch
            # has no refusal today, which is exactly when the hazard is cheap to remove.
            prompt="$_impl_section
$_kb_section"
                else
                    _impl_section="$(build_implementation_prompt "$story_id")" || {
                error "  [prompt] build_implementation_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # SEPARATE ASSIGNMENTS, DELIBERATELY. Joined as
            #   prompt="$(build_implementation_prompt ...)\n$(build_kb_prompt_section ...)"
            # the assignment takes its status from the LAST substitution, so every `return 1` in
            # the builder was swallowed and `set -e` never fired. The writer was then invoked with
            # the empty first line plus the KB section — no story, no criteria, no plan — and
            # produced something confident that got committed. A blank that looks ordinary is the
            # worst failure this pipeline can have.
            prompt="$_impl_section
$_kb_section"
                fi
                if [ -n "${story_plan:-}" ]; then
                    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
                    jq_vals \
                          --arg story_plan "$story_plan" \
                          --arg prompt "$prompt" \
                          '{"__STORY_PLAN__":$story_plan,"__PROMPT__":$prompt}' > "$_cp_vals"
                    _render_out="$(render_or_keep writer-plan-section "$_cp_vals" execution_plan)" && prompt="$_render_out"
                    rm -f "$_cp_vals"
                fi
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
                jq_vals \
                      --arg trimmed_amendment "${_trimmed_amendment}" \
                      --arg scratchpad_file "${_scratchpad_file}" \
                      --arg retry_count "${retry_count}" \
                      --arg prompt "$prompt" \
                      '{"__TRIMMED_AMENDMENT__":$trimmed_amendment,"__SCRATCHPAD_FILE__":$scratchpad_file,"__RETRY_COUNT__":$retry_count,"__PROMPT__":$prompt}' > "$_cp_vals"
                _render_out="$(render_or_keep writer-plan-section "$_cp_vals" coordinator_guidance_trimmed)" && prompt="$_render_out"
                rm -f "$_cp_vals"
            fi
        fi

        # Log the prompt
        echo "=== Prompt for $story_id (attempt $((retry_count + 1))) ===" >> "$output_file"
        echo "$prompt" >> "$output_file"
        echo "=== End Prompt ===" >> "$output_file"
        echo "" >> "$output_file"

        # The tree as it stands NOW, so the analyst is told what THIS attempt did — not what the
        # story did before it (see _attempt_start_snapshot). The raw record is named for the same
        # reason: the tool counts are the evidence for "wrote nothing".
        ATTEMPT_START_REF=$(_attempt_start_snapshot)
        export ATTEMPT_START_REF
        log "Invoking $story_cli (attempt $((retry_count + 1))/$((MAX_RETRIES + 1)))..."

        # Proactive dependency install, BEFORE the vendor lock is applied for
        # this attempt (found live, 2026-07-13, SKY-004-test): a source/test
        # file written by an EARLIER attempt can already import a package
        # missing from package.json. Without this, the agent discovers the
        # gap itself mid-turn and — despite the skill addendum warning it not
        # to — tries to `chmod` node_modules writable and `npm install` the
        # package directly, which touches many UNRELATED transitive
        # dependency files (npm's own hoisting/dedup side effects) and trips
        # run_vendor_integrity_check's tamper detector post-turn. That check
        # then hard-fails BEFORE the existing post-turn run_dependency_check
        # call (further below in run_external_verification) ever runs — so
        # the one mechanism that would have installed the dependency safely
        # never got the chance. Running it here, before the lock, means the
        # dependency is already satisfied by the time the agent's turn
        # starts, so there's nothing left for the agent to (mis)fix itself.
        # The manifest the scan reads is completed from the ecosystem FIRST — the pre-write scan
        # ran against the seed and reported the runtime's own modules as undeclared imports.
        complete_codeline_manifests "$PROJECT_ROOT"
        run_dependency_check "$PROJECT_ROOT"
        run_lockfile_sync_check "$PROJECT_ROOT"

        # Vendor-dir guard: lock configured vendored-dependency directories
        # (e.g. node_modules) read-only — no story ever legitimately writes
        # inside an already-installed third-party package. No-op if
        # .epam/dependency-check.json has no vendorDirs configured.
        # EPAM_VENDOR_GUARD_ENABLED defaults to 0 (off): on a local machine the
        # risk of fake-test injection is low and the lock blocks legitimate
        # dependency installs (e.g. cors) causing unnecessary story failures.
        # Set EPAM_VENDOR_GUARD_ENABLED=1 in CI/multi-tenant environments.
        if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
            _vendor_lock "$PROJECT_ROOT"
        fi

        # Change to project root for the CLI to have correct context
        cd "$PROJECT_ROOT"

        # The provider must match the model this attempt will actually use — the ladder may have
        # escalated the model since the provider was resolved for this story.
        sync_provider_to_model
        # BOTH, EVERY ATTEMPT. The model was logged per attempt and the provider once per story,
        # so three very different failures — right pair, wrong pair, missing key — left identical
        # records. The run that cost this diagnosis could not say which provider it had used.
        log "  Attempt[$((retry_count + 1))] provider=${STORY_PROVIDER:-unset} model=${STORY_MODEL:-default}"
        echo "=== $story_cli Output (attempt $((retry_count + 1))) ===" >> "$output_file"

        local json_result_file="${output_file%.log}_result.json"
        local invoke_success=false
        # Track the raw output file across all provider branches for coordinator triage
        local attempt_raw_file="${json_result_file%.json}_raw.json"
        local attempt_started_at
        attempt_started_at=$(date -Iseconds)

        # Optional per-story wall-clock timeout — set EPAM_STORY_TIMEOUT_SECS in the tier script.
        # No default: if unset, no timeout is applied (behaviour is unchanged).
        # THE SECOND CLOCK ON THE SAME ATTEMPT. The watchdog bounds the story; this bounds the
        # invocation. Both read EPAM_STORY_TIMEOUT_SECS, so a project pin killed each attempt twice
        # — the "raw=0 bytes, exit 1" the coordinator then classified as an environment failure
        # (regintel, 2026-09-22). It honours the declared floor for the same reason the watchdog
        # does: a project may raise a wall, not lower it past the declaration.
        local _timeout_prefix=() _attempt_wall="${EPAM_STORY_TIMEOUT_SECS:-}"
        local _attempt_floor="${EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS:-}"
        if [ -n "$_attempt_wall" ] && [ -n "$_attempt_floor" ] && [ "$_attempt_wall" -lt "$_attempt_floor" ] 2>/dev/null; then
            log "  [attempt] wall ${_attempt_wall}s is below the declared floor — using ${_attempt_floor}s"
            _attempt_wall="$_attempt_floor"
        fi
        [ -n "$_attempt_wall" ] && _timeout_prefix=(timeout "$_attempt_wall")

        STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
        case "$STORY_PROVIDER" in
            opencode)
                # OpenCode: pass prompt via temp file (prompts can exceed arg limits)
                # --format json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local prompt_file="${json_result_file%.json}_prompt.txt"
                echo "$prompt" > "$prompt_file"
                if "${_timeout_prefix[@]}" opencode run --format json "$(cat "$prompt_file")" \
                        > "$raw_file" 2>/dev/null; then
                    normalize_provider_json "opencode" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"text"' "$raw_file" 2>/dev/null \
                        | jq -r '.part.text // .text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                rm -f "$prompt_file"
                ;;
            codex)
                # Codex: reads prompt from stdin when '-' is passed
                # --json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local codex_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && codex_model_flag=(--model "$STORY_MODEL")
                if echo "$prompt" | "${_timeout_prefix[@]}" codex exec \
                        --ephemeral \
                        --skip-git-repo-check \
                        --dangerously-bypass-approvals-and-sandbox \
                        "${codex_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>>"$output_file"; then
                    normalize_provider_json "codex" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                        | jq -r '.item.text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            codemie-claude)
                # codemie-claude: same invocation pattern as claude — --print --output-format json
                if echo "$prompt" | EPAM_AGENT_NAME="${STORY_WRITER_SEAM}" EPAM_STORY_ID="${story_id}" "${_timeout_prefix[@]}" codemie-claude --print --output-format json \
                        "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                        2>>"$output_file" > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            copilot|openai|openrouter|cursor|minimax)
                # epam-run providers: invoke via `epam run --provider X --model M --json`
                # EPAM_CLI can be overridden with a mock for zero-token testing.
                # Explicitly forward API keys so subshells that didn't inherit them still work.
                local raw_file="${json_result_file%.json}_raw.json"
                local epam_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && epam_model_flag=(--model "$STORY_MODEL")
                # When EPAM_SANDBOX is active (EPAM_SANDBOX_IMAGE is set by
                # run-agent-orchestration.sh's sandbox bootstrap), route
                # through $CLAUDE_CMD (the sandbox wrapper) instead of
                # calling $EPAM_CLI directly — this is what makes vendor-dir
                # tampering structurally impossible for THIS provider branch
                # too (previously only the claude/epam default branches
                # respected --sandbox at all). EPAM_SANDBOX_TARGET_CMD tells
                # sandbox-invoke.sh to run epam-cli's own bind-mounted CLI
                # (see that script's docstring) instead of its `claude`
                # default; left empty (harmless) when not sandboxed.
                local _epam_run_binary="$EPAM_CLI"
                local _epam_sandbox_target=""
                if [ -n "${EPAM_SANDBOX_IMAGE:-}" ]; then
                    _epam_run_binary="$CLAUDE_CMD"
                    _epam_sandbox_target="node /opt/epam-cli/dist/epam.js"
                fi
                # Agent identity for WriteFile.ts's settings-guard (llm-settings.json may
                # only be written by EPAM_LLM_SETTINGS_GUARDIAN_ROLE) and for the audit
                # log/traces to attribute a change to the story that made it.
                local _story_agent_role
                _story_agent_role=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .agentRole // ""' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")

                # Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story's declared files.
                # WriteFile.ts uses this to block TS writes outside the story's scope.
                local _allowed_write_paths
                _allowed_write_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                # Files OTHER stories declare. The scope guard refuses a write that would take
                # one of these, and permits (and records) a file no story owns — because the
                # guard exists to stop stories overwriting each other, not to stop work. See the
                # unowned-file branch in WriteFile.ts for the incident.
                #
                # OWNERSHIP IS TRI-STATE. An empty list is a real answer — a single-story PRD is
                # the normal case here — and it is not the same as "nobody computed this". The
                # marker below says the lookup RAN; without it the guard keeps refusing, so a
                # caller that never computes ownership cannot switch the guard off by omission.
                # Reading empty as unknown would have left this inert on exactly the PRD it was
                # written for, which carries one story.
                local _other_story_paths _story_ownership_known=0
                _other_story_paths=$(jq -r --arg id "$story_id" \
                    '[.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty] | unique | .[]' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null \
                    | while IFS= read -r _osp; do [ -n "$_osp" ] && printf '%s:' "${PROJECT_ROOT}/${_osp}"; done)
                _other_story_paths="${_other_story_paths%:}"
                # jq exits non-zero only when the PRD is unreadable; a readable PRD with one story
                # legitimately yields nothing. Gate the marker on the PRD being readable at all.
                if jq -e '.stories' "${MAIN_PRD_FILE:-$PRD_FILE}" >/dev/null 2>&1; then
                    _story_ownership_known=1
                fi

                # Rewrite allowed paths to worktree when in worktree mode.
                # Without this, WriteFile.ts blocks writes to the worktree path and reports
                # "Permitted paths: /main-repo/src/foo.ts" — the model reads that error and
                # writes to the main repo instead of the worktree.
                if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
                    _allowed_write_paths="${_allowed_write_paths//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
                fi
                # Also permit the detective's CAUSAL fix-site file(s). The spec-pass
                # detective traces the real fix location, which often differs from the
                # ticket's declared technicalNotes.files; the locationHint→technicalNotes.files
                # propagation is non-deterministic (run14, 2026-07-22), so the scope-guard
                # could otherwise BLOCK the agent from writing the very file it was told to
                # fix. These are repo-relative and resolve against the agent's cwd
                # (=PROJECT_ROOT/worktree) exactly as WriteFile.ts's path.resolve() expects,
                # so no worktree rewrite is needed.
                local _fixsite_paths
                _fixsite_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .fixSiteAnalysis[]?.file // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                if [ -n "$_fixsite_paths" ]; then
                    _allowed_write_paths="${_allowed_write_paths:+${_allowed_write_paths}:}${_fixsite_paths}"
                fi
                # Reuse guard (IMPL-PROSE): the prescribed helper and the file it
                # belongs in, taken from the SAME verified fixSiteAnalysis entry the
                # post-hoc verifier reads. Handing the tool the symbol makes reuse
                # structural at the write instead of advice in the prompt, which the
                # model demonstrably ignored three attempts running (AMSD-2041,
                # 2026-07-30). Empty when nothing is prescribed — the guard is inert.
                local _req_symbols _req_scope
                _req_symbols=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
                     | map(select((.fixVerified == true) and ((.helper // "") != "")))
                     | map(.helper) | unique | join(":")' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                _req_scope=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
                     | map(select((.fixVerified == true) and ((.helper // "") != "")))
                     | map(.file // empty) | unique | .[]' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | \
                    while IFS= read -r _f; do
                        [ -n "$_f" ] || continue
                        case "$_f" in /*) printf '%s:' "$_f" ;; *) printf '%s:' "$PROJECT_ROOT/$_f" ;; esac
                    done)
                _req_scope="${_req_scope%:}"
                if [ -n "$_req_symbols" ] && [ -n "$_req_scope" ]; then
                    log "  ReuseGuard: '${_req_symbols}' enforced at write time on ${_req_scope}"
                fi
                # Model-specific overrides: reasoning effort, temperature,
                # iteration cap, custom compaction — read directly from
                # llm-settings.json's modelOverrides (schema:
                # orchestrations/config/llm-settings.schema.json), keyed by an
                # arbitrary label but MATCHED against the FINAL resolved
                # $STORY_PROVIDER/$STORY_MODEL for THIS attempt (novel-brownfield
                # routing and ladder escalation both reassign these earlier —
                # checked here, not earlier, so a story that escalated AWAY
                # from a match correctly does NOT get these). Entries are
                # checked in declaration order; the FIRST match wins, so e.g.
                # MiniMax-M2.5 and MiniMax-M3 can carry different budgets
                # despite sharing one provider. Unconditionally overrides the
                # rung's own effort/temperature default, by design — that's
                # the whole point of a model-specific override.
                local _effective_max_iterations="${STORY_MAX_ITERATIONS:-6}"
                local _effective_compress_at="${EPAM_AUTO_COMPRESS_AT:-}"
                local _effective_compress_every_n="${EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS:-}"
                # THE OVERRIDES LIVE WITH THE MODELS — in the active STACK, not the project.
                #
                # This read only the project's llm-settings.json. The 2026-08-25 migration moved
                # modelOverrides out of project files into config/llm-defaults.<set>.json, because
                # a per-model setting belongs to the model and a model belongs to a stack. The
                # reader was left behind, so effort, temperature and compaction overrides reached
                # NOTHING on any run — the same defect seam-invocation.js had for iteration
                # budgets, in a second reader.
                #
                # The project file is still preferred when it declares overrides: a project may
                # legitimately override for its own reasons, and that is the layer where such a
                # decision belongs.
                  # BOTH LAYERS, IN ORDER -- the project first, then the active stack. Asking which
                  # FILE to read skipped the stack whenever the project declared any override at
                  # all; resolve_model_override asks which file declares THIS MODEL.
                  local _proj_override_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}"
                  local _stack_override_file
                  _stack_override_file="$("${NODE_BIN:-node}" -e '
                      try {
                        const { activeSetFile } = require(process.argv[1] + "/lib/llm-settings-resolve.js");
                        process.stdout.write(activeSetFile() || "");
                      } catch (_) { process.stdout.write(""); }
                  ' "$SCRIPT_DIR" 2>/dev/null || printf '')"
                  local _override_json
                  _override_json=$(resolve_model_override "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" \
                      "$_proj_override_file" "$_stack_override_file")
                  if [ -n "$_override_json" ] && [ "$_override_json" != "null" ]; then
                        local _ov_effort _ov_temp _ov_iter _ov_compress_at _ov_compress_n _ov_top_p _ov_temp_locked _ov_provider_order
                        _ov_effort=$(jq -r '.reasoningEffort // empty' <<<"$_override_json")
                        _ov_top_p=$(jq -r '.topP // empty' <<<"$_override_json")
                        _ov_provider_order=$(jq -r '[.providerOrder[]?] | join(",")' <<<"$_override_json")
                        _ov_temp_locked=$(jq -r '.temperatureLocked // false' <<<"$_override_json")
                        _ov_temp=$(jq -r '.temperature // empty' <<<"$_override_json")
                        _ov_iter=$(jq -r '.maxIterations // empty' <<<"$_override_json")
                        _ov_out_tokens=$(jq -r '.maxOutputTokens // empty' <<<"$_override_json")
                        _ov_out_price=$(jq -r '.outputPricePerMillion // empty' <<<"$_override_json")
                        _ov_compress_at=$(jq -r '.autoCompressAt // empty' <<<"$_override_json")
                        _ov_compress_n=$(jq -r '.autoCompressEveryNIterations // empty' <<<"$_override_json")
                        # FLOOR, not overwrite — see max_effort(). The rung's escalation must survive.
                        [ -n "$_ov_effort" ] && EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "$_ov_effort")"

                        # OPERATOR RULE (2026-08-10): a retry must ALWAYS raise reasoning effort
                        # when the model is NOT escalating. A rung spans two attempts, so the
                        # second attempt of a rung previously re-ran the identical model at the
                        # identical effort — the same input, expecting a different answer. Effort
                        # is the only lever left when the model cannot move (mid-rung, or at the
                        # top of the chain where get_model_ladder_step returns nothing).
                        if [ "${_total_attempts:-1}" -gt 1 ] \
                           && [ "${STORY_MODEL:-}" = "${LAST_ATTEMPT_MODEL:-}" ]; then
                            _escalated_effort=$(next_effort "${EPAM_REASONING_EFFORT:-}")
                            if [ "$_escalated_effort" != "${EPAM_REASONING_EFFORT:-}" ]; then
                                log "  [EffortEscalation] model unchanged (${STORY_MODEL:-}) — effort ${EPAM_REASONING_EFFORT:-} → ${_escalated_effort}"
                                export EPAM_REASONING_EFFORT="$_escalated_effort"
                            else
                                log "  [EffortEscalation] model unchanged (${STORY_MODEL:-}) — effort already at ceiling (high)"
                            fi
                        fi
                        # HARD INVARIANT (operator rule, 2026-08-10): two back-to-back
                        # invocations must never run with an IDENTICAL settings tuple. Bumping
                        # effort covers most cases, but at the 'high' ceiling with the model at
                        # the top of its chain there is nothing left to move — and the attempt
                        # becomes a byte-for-byte repeat of the one that just failed. That is
                        # pure waste: same model, same effort, same temperature, same prompt.
                        # Temperature is the remaining lever (sampling variance), so it moves.
                        _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                        if [ "${_total_attempts:-1}" -gt 1 ] \
                           && [ "$_settings_fingerprint" = "${LAST_ATTEMPT_SETTINGS:-}" ]; then
                            # Effort first: it is the one lever every model in the ladder honours.
                            # Temperature is model-specific and Kimi K3 fixes it at 1.0 on Moonshot's
                            # platform, so a temperature bump there changes nothing and the identical
                            # attempt runs anyway — the precise violation this invariant exists to stop.
                            _inv_effort=$(next_effort "${EPAM_REASONING_EFFORT:-}")
                            if [ "$_inv_effort" != "${EPAM_REASONING_EFFORT:-}" ]; then
                                warning "  [SettingsInvariant] identical settings (${_settings_fingerprint}) — effort ${EPAM_REASONING_EFFORT:-} → ${_inv_effort}"
                                export EPAM_REASONING_EFFORT="$_inv_effort"
                                _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                                LAST_ATTEMPT_SETTINGS="$_settings_fingerprint"
                                export LAST_ATTEMPT_SETTINGS
                                LAST_ATTEMPT_MODEL="${STORY_MODEL:-}"
                                export LAST_ATTEMPT_MODEL
                                continue
                            fi
                            if [ "${_ov_temp_locked:-false}" = "true" ]; then
                                error "  [SettingsInvariant] ${STORY_MODEL:-} fixes its temperature and effort is at ceiling (${EPAM_REASONING_EFFORT:-}) — no lever remains; abandoning rather than repeating the attempt"
                                break
                            fi
                            _inv_temp=$(awk -v t="${EPAM_TEMPERATURE:-0}" \
                                -v b="${EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP:-0.2}" \
                                -v m="${EPAM_REPEAT_REJECTION_TEMPERATURE_MAX:-1.0}" \
                                'BEGIN { r = t + b; if (r > m) r = m; printf "%.2f", r }')
                            if [ "$_inv_temp" != "${EPAM_TEMPERATURE:-0}" ]; then
                                warning "  [SettingsInvariant] identical settings to the previous attempt (${_settings_fingerprint}) — temperature ${EPAM_TEMPERATURE:-0} → ${_inv_temp}"
                                export EPAM_TEMPERATURE="$_inv_temp"
                                _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                            else
                                error "  [SettingsInvariant] every lever is exhausted (${_settings_fingerprint}) — repeating this attempt cannot differ from the last; abandoning the story rather than burning the budget"
                                break
                            fi
                        fi
                        LAST_ATTEMPT_SETTINGS="$_settings_fingerprint"
                        export LAST_ATTEMPT_SETTINGS
                        LAST_ATTEMPT_MODEL="${STORY_MODEL:-}"
                        export LAST_ATTEMPT_MODEL
                        [ -n "$_ov_temp" ] && export EPAM_TEMPERATURE="$_ov_temp"
                        [ -n "$_ov_top_p" ] && export EPAM_TOP_P="$_ov_top_p"
                        [ -n "$_ov_provider_order" ] && export EPAM_PROVIDER_ORDER="$_ov_provider_order"
                        # A model override is the model's own HEADROOM, not the final answer.
                        # Applied as a replacement it discarded every rung's iterationBump, so
                        # the iteration budget did not escalate across rungs at all — the same
                        # overwrite-instead-of-combine bug found in reasoning effort and
                        # temperature on 2026-08-10. The rung escalation is added on top, and
                        # the larger of the two bases wins so neither lever is silently lost.
                        if [ -n "$_ov_iter" ]; then
                            _effective_max_iterations=$(awk \
                                -v a="${_effective_max_iterations:-0}" \
                                -v b="$_ov_iter" -v bump="${STORY_ITERATION_BUMP_TOTAL:-0}" \
                                'BEGIN { base = (b + bump > a ? b + bump : a); printf "%d", base }')
                        fi
                        # THE MODEL'S OWN MAXIMUM IS THE OUTPUT BUDGET, AND A TIER CAN ONLY RAISE IT.
                        #
                        # A cap below what the model can emit has exactly one effect: truncation.
                        # It saves nothing — spend is bounded by costControls.storyBudgetHardLimitUsd,
                        # passed to the runner as --max-budget-usd — and a truncated attempt that gets
                        # retried costs MORE than one that finishes. Every authored ceiling this
                        # pipeline has had was eventually a wall: 6144, 8192, 12288, 16384, and on
                        # 2026-09-23 the run's traces showed 85 of 6,301 iterations ending exactly at
                        # one while the provider's registry said these models emit 131,072 to 943,718.
                        #
                        # The number is the PROVIDER'S (scripts/refresh-model-limits.sh writes it from
                        # the model registry), so nothing here chooses it, and a model whose override
                        # declares none leaves the tier's value exactly as it was.
                        if [ -n "${_ov_out_tokens:-}" ] && [ "$_ov_out_tokens" -gt "${STORY_MAX_OUTPUT_TOKENS:-0}" ] 2>/dev/null; then
                            # AND NEVER MORE THAN THE BALANCE CAN PAY FOR. The provider refuses any
                            # request whose max_tokens COULD cost more than the credit remaining —
                            # live 2026-09-23, kimi-k3 billing output at $15/M reserved $14.16 for
                            # its 943,718-token maximum against an $11.66 balance, and every call on
                            # that rung came back 402 in under a second: eight attempts, a spent
                            # ladder, no tokens generated. Every other model on the ladder reserves
                            # under a dollar, so it surfaced on one rung only, and only once the
                            # balance was low.
                            #
                            # The budget is the smallest of three DECLARED things: the model maximum,
                            # what the balance can pay for, and what one story may spend. Nothing is
                            # authored — the price comes from the provider registry via
                            # scripts/refresh-model-limits.sh, the balance from the set own
                            # balanceProbe. An unpriced model or an unreadable balance caps nothing,
                            # because a guess would be worse than the maximum.
                            local _ov_capped="$_ov_out_tokens" _ov_ceiling=""
                            if [ -n "${_ov_out_price:-}" ]; then
                                local _ov_balance=""
                                declare -F balance_probe_read >/dev/null 2>&1 && _ov_balance="$(balance_probe_read 2>/dev/null || true)"
                                _ov_ceiling="$(awk -v b="${_ov_balance:-}" -v s="${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" 'BEGIN{
                                    c = -1
                                    if (b != "" && b + 0 > 0) c = b + 0
                                    if (s != "" && s + 0 > 0 && (c < 0 || s + 0 < c)) c = s + 0
                                    if (c > 0) printf "%.6f", c
                                }')"
                                if [ -n "$_ov_ceiling" ]; then
                                    _ov_capped="$(awk -v cap="$_ov_out_tokens" -v price="$_ov_out_price" -v usd="$_ov_ceiling" -v floor="${STORY_MAX_OUTPUT_TOKENS:-0}" 'BEGIN{
                                        afford = (price > 0) ? int(usd * 1000000 / price) : cap
                                        v = (afford < cap) ? afford : cap
                                        if (v < floor) v = floor
                                        printf "%d", v
                                    }')"
                                fi
                            fi
                            if [ "$_ov_capped" != "$_ov_out_tokens" ]; then
                                log "  ModelOverride[${STORY_MODEL:-model}]: output budget ${STORY_MAX_OUTPUT_TOKENS:-?} → ${_ov_capped} — the model allows ${_ov_out_tokens}, but at \$${_ov_out_price}/M only ${_ov_capped} is affordable within \$${_ov_ceiling} of credit"
                            else
                                log "  ModelOverride[${STORY_MODEL:-model}]: output budget ${STORY_MAX_OUTPUT_TOKENS:-?} → ${_ov_capped} (the model's own maximum; a tier may raise this, never lower it)"
                            fi
                            STORY_MAX_OUTPUT_TOKENS="$_ov_capped"
                            export STORY_MAX_OUTPUT_TOKENS
                        fi
                        # end output-budget decision — a marker, because this block now nests and
                        # a test that sliced to the first `fi` cut it in half (2026-09-23).
                        [ -n "$_ov_compress_at" ] && _effective_compress_at="$_ov_compress_at"
                        [ -n "$_ov_compress_n" ] && _effective_compress_every_n="$_ov_compress_n"
                        log "  ModelOverride[${STORY_MODEL:-$STORY_PROVIDER}]: effort=${_ov_effort:-unchanged} temp=${_ov_temp:-unchanged} maxIter=${_effective_max_iterations} compaction=$([ -n "$_effective_compress_every_n" ] && echo "every ${_effective_compress_every_n} iter" || echo "token-threshold") (tokenThreshold=${_effective_compress_at:-none})"
                    fi
                # TELL THE WATCHDOG WHAT WE ACTUALLY GRANTED.
                #
                # The parent sizes the story's wall from iterations x secondsPerIteration, but
                # this number is decided HERE — per model, per attempt, minutes after the parent
                # already fixed that wall — so its derivation branch never ran and the wall
                # silently stayed at the floor. Persisting it is the only way the value travels
                # upward. See lib/story-retry-state.sh for the measured cost.
                write_story_effective_iterations "$LOG_DIR" "$story_id" "$_effective_max_iterations"
                # Every line here forwards a value to the child process, and each expansion deliberately reads
                # the OUTER value — which IS the value being forwarded. shellcheck is right about the shape and
                # wrong about the intent; rewriting it risks silently dropping a credential the child needs.
                # shellcheck disable=SC2097,SC2098
                if echo "$prompt" | \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_AGENT_ROLE="${_story_agent_role}" \
                        EPAM_AGENT_NAME="${STORY_WRITER_SEAM}" \
                        EPAM_STORY_ID="${story_id}" \
                        EPAM_ACTIVITY_LOG_DIR="${LOG_DIR}" \
                        EPAM_USAGE_PROGRESS_FILE="${LOG_DIR}/usage-progress-${story_id}.json" \
                        EPAM_USAGE_TRACE_FILE="${LOG_DIR}/usage-trace-${story_id}.jsonl" \
                        EPAM_SESSION_ID="${ORCH_RUN_ID:-run}-${story_id}-${retry_count:-0}" \
                        EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-$_tool_policy_read_dedupe}" \
                        EPAM_BASH_EXPLORATION_REDIRECT="${_tool_policy_redirect}" \
                        EPAM_REQUIRED_SYMBOLS="${_req_symbols}" \
                        EPAM_REQUIRED_SYMBOL_SCOPE="${_req_scope}" \
                        EPAM_ALLOWED_WRITE_PATHS="${_allowed_write_paths}" \
                        EPAM_OTHER_STORY_PATHS="${_other_story_paths}" \
                        EPAM_STORY_OWNERSHIP_KNOWN="${_story_ownership_known}" \
                        EPAM_SCOPE_WIDENING_LOG="${LOG_DIR}/scope-widenings.jsonl" \
                        EPAM_AGENT_MESSAGE_CATALOG="${EPAM_AGENT_MESSAGE_CATALOG:-${AUTOMATION_DIR}/config/agent-messages.json}" \
                        EPAM_MAX_ITERATIONS="${_effective_max_iterations}" \
                        EPAM_AUTO_COMPRESS_AT="${_effective_compress_at}" \
                        EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS="${_effective_compress_every_n}" \
                        EPAM_MAX_OUTPUT_TOKENS="${STORY_MAX_OUTPUT_TOKENS:-3072}" \
                        EPAM_MAX_TOOL_CALLS="${EPAM_STORY_MAX_TOOL_CALLS:-}" \
                        OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-}" \
                        EPAM_OPENROUTER_MODEL_OVERRIDE="${EPAM_OPENROUTER_MODEL_OVERRIDE:-}" \
                        DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        MINIMAX_API_KEY="${MINIMAX_API_KEY:-}" \
                        EPAM_API_KEY_MINIMAX="${EPAM_API_KEY_MINIMAX:-}" \
                        MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-}" \
                        EPAM_MINIMAX_MODEL_OVERRIDE="${EPAM_MINIMAX_MODEL_OVERRIDE:-}" \
                        EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-}" \
                        EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-}" \
                        OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
                        EPAM_API_KEY_OPENAI="${EPAM_API_KEY_OPENAI:-}" \
                        EPAM_RALPH_WIGGUM_ENABLED="${EPAM_RALPH_WIGGUM_ENABLED:-}" \
                        EPAM_RALPH_WIGGUM_AGENTS="${EPAM_RALPH_WIGGUM_AGENTS:-}" \
                        EPAM_RALPH_WIGGUM_TIMEOUT_MS="${EPAM_RALPH_WIGGUM_TIMEOUT_MS:-}" \
                        EPAM_SANDBOX_TARGET_CMD="${_epam_sandbox_target}" \
                        "${_timeout_prefix[@]}" "$_epam_run_binary" run \
                        --provider "$STORY_PROVIDER" \
                        "${epam_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>> "$output_file"; then
                    normalize_provider_json "epam-run" "$raw_file" "$json_result_file"
                    jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            epam)
                # epam: treat same as claude — same CLI, same output format
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    local sdk_think_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            --cache-system \
                            "${sdk_model_arg[@]}" "${sdk_think_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | EPAM_AGENT_NAME="${STORY_WRITER_SEAM}" EPAM_STORY_ID="${story_id}" "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
            *)
                # Claude-compatible providers use the Claude CLI JSON output shape.
                # SDK path: invoke.py via Anthropic Python SDK (EPAM_SDK_INVOKE=1)
                # CLI path: claude --print --output-format json (default)
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            --cache-system \
                            "${sdk_model_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | EPAM_AGENT_NAME="${STORY_WRITER_SEAM}" EPAM_STORY_ID="${story_id}" "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
        esac

        # Log THIS attempt's real token/cost usage unconditionally (success or
        # failure) — previously only the FINAL attempt's json_result_file
        # ever reached phase-cost.jsonl (append_cost_record was only called
        # once, at the story's terminal completed/failed state), so every
        # earlier retry's real, billed tokens were silently invisible to any
        # dashboard or report. Found live 2026-07-23 (AMSD-1820): an 8-attempt
        # failure with ~200-240k input tokens on EACH attempt would have shown
        # only the last one — hiding roughly 7/8 of the real cost. Distinct
        # status ("attempt", not "completed"/"failed") so existing consumers
        # that filter on terminal status are unaffected; the attempt number
        # lets a per-story total be summed independently of that filter.
        append_cost_record "$story_id" "attempt" "$attempt_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file" "$((retry_count + 1))"

        # Cost controls. Sums this story's own real cost across every attempt
        # recorded so far, since retries/ladder escalation on one story are
        # exactly where spend can run away unnoticed.
        if [ -n "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] || [ -n "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ]; then
            local _cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
            if [ -f "$_cost_file" ]; then
                local _story_cost_so_far
                # Filtered by RUN, not just story. phase-cost.jsonl is appended across runs and
                # is not reset by pre-run-reset, so summing by story_id alone charged this run
                # for every previous run's attempts on the same ticket — metrolinx had already
                # accumulated $11.20 of history against AMSD-2041. A limit that counts spend the
                # operator never authorised this run is not a limit, it is a lottery.
                # Records predating run stamping carry no run_id and are correctly excluded.
                # BILLABLE ROWS ONLY. Every call is written twice — `attempt`/`agent` and a
                # terminal restatement — so this summed each one twice and halted a story at HALF
                # its configured hard limit. The partition has one home: lib/ledger-tokens.sh.
                _story_cost_so_far=$(jq -s --arg id "$story_id" --arg rid "${ORCH_RUN_ID:-}" \
                    "[.[] | select(.story_id == \$id)
                          | select((\$rid == \"\") or (.run_id == \$rid))
                          | ${LEDGER_BILLABLE_JQ}
                          | (.task_cost_usd // 0)] | add // 0" \
                    "$_cost_file" 2>/dev/null || echo 0)
                # Warning: advisory only, logged once per story per run.
                if [ "$_budget_warned" != "1" ] && [ -n "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] \
                   && awk -v c="$_story_cost_so_far" -v w="$EPAM_STORY_BUDGET_WARNING_USD" 'BEGIN{exit !(c > w)}'; then
                    warning "Story $story_id has spent \$${_story_cost_so_far} so far, over its \$${EPAM_STORY_BUDGET_WARNING_USD} warning threshold"
                    _budget_warned=1
                fi
                # Hard limit: stop granting this story further retries. The
                # CURRENT attempt (already paid for) is allowed to finish
                # normally — deliverables/TC-writer/external verification
                # below still run, so a success already in flight isn't
                # thrown away. _retry_extension_used=1 is set BEFORE forcing
                # the loop past MAX_RETRIES specifically so
                # run_retry_extension_coordinator() (which can GRANT MORE
                # retries on the self-heal path right after this loop exits)
                # is never consulted — without that, a budget-triggered stop
                # could still be overridden into more spend by self-heal.
                if [ -n "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ] \
                   && awk -v c="$_story_cost_so_far" -v w="$EPAM_STORY_BUDGET_HARD_LIMIT_USD" 'BEGIN{exit !(c >= w)}'; then
                    error "Story $story_id has spent \$${_story_cost_so_far}, at or over its \$${EPAM_STORY_BUDGET_HARD_LIMIT_USD} hard limit — no further retries will be granted (self-heal extension skipped)"
                    _retry_extension_used=1
                    retry_count=$((MAX_RETRIES + 1))
                fi
            fi
        fi

        # Vendor-dir guard: NOT unlocked here — run_vendor_integrity_check()
        # (called at the very start of run_external_verification, before
        # run_dependency_check's own sanctioned writes) needs the lock marker
        # and current permissions intact to correctly attribute any tamper to
        # this attempt. _vendor_unlock() is called from inside
        # run_external_verification itself, right after that check passes.

        # The story may have just written the codeline's manifest file (a scaffold story does);
        # complete the codeline's .epam declaration from its ecosystem before anything reads it.
        complete_codeline_manifests "$PROJECT_ROOT"
        if [ "$invoke_success" = true ] && ! verify_story_deliverables "$story_id"; then
            warning "$story_cli returned success but story deliverables are incomplete"
            invoke_success=false
        fi

        # Inline TC writer — fires after impl deliverables are verified, before
        # external test. Generates testCriteria in the PRD for sibling test
        # stories so the test agent has precise facts, not just abstract ACs.
        # Skipped for test stories themselves (they don't generate TCs).
        if [ "$invoke_success" = true ] && ! is_truthy "${SKIP_TC_WRITER:-}"; then
            local _story_files_are_tests
            # grep -c ALREADY prints "0" on zero matches (its own count) while
            # also exiting 1 — combining that with `|| echo 0` double-prints
            # ("0\n0"), which then fails the `-eq` numeric test below with
            # "integer expression expected" (found live, 2026-07-06, blocking
            # external verification for every non-test story with exit 127).
            # `|| true` only suppresses the exit code (needed since this
            # script runs under `set -e`), without adding extra output.
            _story_files_are_tests=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null \
                | { grep -cE '(\.|_)(spec|test)\.[A-Za-z0-9]+$|/__tests__/|(^|/)test_[^/]+$' || true; })
            if [ "${_story_files_are_tests:-0}" -eq 0 ]; then
                local _tcw_phase; _tcw_phase="$(_tc_writer_phase)"
                if [ -z "$_tcw_phase" ]; then
                    warning "  [tc-writer] no phase is set (CURRENT_PHASE and PHASE both empty) — TCs NOT generated"
                fi
                log "  [tc-writer] Generating TCs for phase '${_tcw_phase:-<unset>}' (post-impl, pre-test)..."
                # `if CMD | tee ...; then` TESTS TEE, which exits 0 essentially always — so this
                # reported "TC generation complete" whatever the writer did, including refusing to
                # run at all. No pipefail here; PIPESTATUS[0] is the writer's own code.
                if { bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
                    --prd "${MAIN_PRD_FILE:-$PRD_FILE}" \
                    --phase "$_tcw_phase" \
                    --output-dir "$PROJECT_ROOT" \
                    2>&1 | tee -a "$output_file"; [ "${PIPESTATUS[0]}" -eq 0 ]; }; then
                    log "  [tc-writer] TC generation complete — test stories have testCriteria"
                else
                    warning "  [tc-writer] TC generation failed — test stories will run without TCs (non-fatal)"
                fi
            fi
        fi

        # TypeScript compile check — runs BEFORE external verification
        # (reordered 2026-07-12; see run_tsc_verification()'s own comment for
        # the live incident this fixes). A syntax/type error is a cheap,
        # near-instant deterministic check; the (often multi-minute) external
        # test command below should never run against code that can't even
        # compile. Still inside the retry loop so a tsc failure gets the same
        # self-healing treatment (failure analyst, InferenceLadder escalation)
        # as any other verification failure, rather than exiting the phase
        # with zero retries.
        # LAST_ATTEMPT_TSC_PASSED is the "validated work" signal
        # _selective_worktree_reset (below, next rung transition) uses to
        # decide whether the CURRENT diff is safe to preserve wholesale —
        # real, already-computed evidence (not a heuristic) that the tree is
        # at least type/syntax-correct, not the specific-broken-half-write
        # state the reset exists to protect against. Only true when tsc
        # actually ran AND passed; false if it failed OR never ran (an
        # earlier stage already failed first) — "no evidence it's good" and
        # "evidence it's bad" are both reasons to not trust the diff.
        #
        # Captured via _invoke_success_before_tsc rather than restructuring
        # the check below into its own if/else — that literal
        # `[ "$invoke_success" = true ] && ! run_tsc_verification ...; then`
        # shape (unchanged since 2026-07-12) is asserted on directly by
        # tsc-retry-in-loop.test.ts and tsc-gate-test-engineer-blindspot.test.ts.
        local _invoke_success_before_tsc="$invoke_success"
        if [ "$invoke_success" = true ] && ! run_tsc_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but the project type check failed"
            invoke_success=false
        fi
        # Three outcomes, not two. Recording "never ran" as `false` conflates "this tree does
        # not type-check" with "nothing is known about this tree", and _selective_worktree_reset
        # deletes the whole diff on the strength of that. Found live 2026-08-09 (AMSD-2041): a
        # story rejected by verify_story_deliverables for being INCOMPLETE never reaches the tsc
        # gate above, so its two correct fix sites were recorded as type-failures and erased at
        # the next rung transition — four attempts re-deriving the same files from an empty tree.
        # THE COMPILER SIGNAL IS GONE ON PURPOSE — DO NOT PUT IT BACK.
        #
        # A tri-state LAST_ATTEMPT_TSC_PASSED was computed here for _selective_worktree_reset, to
        # decide whether the current diff was safe to preserve. That function no longer asks the
        # question: keep/discard is a SPEC question, not a compiler one. For any multi-file change a
        # partially-complete edit is correct progress AND a compile error at once, so the compiler
        # could only preserve work that was already coherent — precisely the work that never needed
        # preserving. Live 2026-08-10: 25 file writes across five invocations, zero survivors, on a
        # story with 13 interdependent fix sites. The predicate is now the spec's changeRequired.
        #
        # The variable outlived its consumer: assigned in three places, read in none, while the
        # comments here still called it the deciding signal. Removed rather than rewired — rewiring
        # it would restore the behaviour that destroyed those 25 writes.

        # The repository's OWN lint, before the commit rather than at Step 20. A violation here
        # is fatal at commit time (husky rejects, lint-staged reverts the work), so it has to be
        # feedback inside the loop. Placed after tsc so the writer fixes type errors first, and
        # before the test run so it does not spend a full external verification on a change that
        # cannot commit.
        if [ "$invoke_success" = true ] && ! run_repo_lint_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but the repository's own lint rejects them"
            invoke_success=false
        fi

        # External test verification — runs tests outside the agent loop so the
        # agent only needs to write files (keeping iterations low).
        if [ "$invoke_success" = true ] && ! run_external_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but external tests failed"
            invoke_success=false
        fi

        if [ "$invoke_success" = true ]; then
            # Extract human-readable result text and append to output log
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== End $story_cli Output ===" >> "$output_file"
            success "$story_cli completed implementation for $story_id"
            update_monitor_status "complete" "$story_id" "Implementation succeeded"
            append_cost_record "$story_id" "completed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
            # Attribute this FINAL rung's contribution (backlog #113) — no
            # further rung transition will happen to trigger this otherwise,
            # since the story just succeeded.
            _rung_attribute_changes "$story_id" "$_rung" "${STORY_MODEL:-}"
            _generate_rung_contribution_report "$story_id"
            # ONE AUTHOR PER COUPLED FILE PAIR. The retry bookkeeping below is
            # duplicated into this branch deliberately: a story that fails here has
            # still BURNED this rung, and dropping out without persisting the count
            # and model is what makes a ladder restart its climb from rung 0.
            # ADVISORY, so no retry branch: it records a scope finding and always returns 0.
            # A `if ! ...; then <retry>` here would be a branch that can never be taken, which
            # reads to the next person as enforcement that exists. See the function's header
            # for why blocking on this signal rejects working code.
            _plan_fidelity_gate_for_story "$story_id" "$output_file"
            if ! _coupled_pair_gate_for_story "$story_id" "$output_file"; then
                write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
                write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
                # Persisted ALONGSIDE the model — see change-log/SEAM-CONSISTENCY-ANALYSIS.md.
                # A resume must know WHICH set chose this model, or a swap between invocations
                # leaves a rung name (e.g. MiniMax-M3) meaningless under the new set.
                write_story_retry_provider_set "$LOG_DIR" "$story_id" "${EPAM_PROVIDER_SET:-}"
                write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
                rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
                update_monitor_status "retry" "$story_id" "Coupled file pair had more than one author"
                return 1
            fi
            rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
            # Persisted even on success: a technically-successful attempt can
            # still be REJECTED by Step 3.6's review — the next
            # re-implementation must resume from here, not rung 0.
            write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
            # The model belongs with the count: the count is only a proxy for the rung, and the
            # rung is only a proxy for WHICH MODEL RUNS. Persisting one without the other is
            # what made the ladder restart its climb on every re-invocation.
            write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
            # Persisted ALONGSIDE the model — see change-log/SEAM-CONSISTENCY-ANALYSIS.md.
            # A resume must know WHICH set chose this model, or a swap between invocations
            # leaves a rung name (e.g. MiniMax-M3) meaningless under the new set.
            write_story_retry_provider_set "$LOG_DIR" "$story_id" "${EPAM_PROVIDER_SET:-}"
            write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
            write_healing_summary "$story_id" "completed" 2>/dev/null || true
            post_completion_message "$story_id" "completed"
            return 0
        else
            local exit_code=$?
            # Still capture any partial JSON output
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== $story_cli exited with code $exit_code ===" >> "$output_file"

            # ── Coordinator pre-assessment before next retry ──────────────────
            # Resolve the actual raw file path (may differ by provider).
            local _raw_for_coord="$attempt_raw_file"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord="${json_result_file%.json}_raw.jsonl"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord=""
            # The attempt's own tool record, for _attempt_change_summary (analyst and retry prompt).
            ATTEMPT_RAW_FILE="$_raw_for_coord"
            export ATTEMPT_RAW_FILE

            # Layer 1: rule-based triage (always runs)
            # A REFUSED COMMAND LINE ENDS THE STORY -- it cannot differ on the next attempt.
            # Checked before the coordinator, whose evidence is the raw output file that a refused
            # invocation never produces; the attempt log always exists and carries the error.
            if classify_invocation_refusal "$output_file" "$exit_code"; then
                COORDINATOR_FAILURE_CLASS="invocation"
                COORDINATOR_ESCALATE="no"
                return 1
            fi
            classify_failure_class "$_raw_for_coord" "$json_result_file" "$exit_code" "$story_id" "$output_file"
            if [ "$COORDINATOR_FAILURE_CLASS" = "credit" ]; then
                update_monitor_status "failed" "$story_id" "provider account has no credit — halted, not retried"
                return 1
            fi
            raise_output_budget_after_cap_hit

            # Work carryover: verify_story_deliverables() (called above, on
            # whichever attempt last actually ran the agent) already knows
            # which declared files got REAL work vs which still show no diff
            # from baseline. Surfacing that split explicitly to the NEXT
            # attempt — rather than leaving it to be re-derived from
            # "## Existing File Contents" prose alone — means a rung
            # escalation builds on what's already correct instead of risking
            # a full rewrite of files that didn't need one. Appended, not
            # overwritten: classify_failure_class above may have already set
            # its own amendment for this failure class.
            if [ -n "${LAST_VERIFIED_TOUCHED_FILES:-}" ] || [ -n "${LAST_VERIFIED_UNCHANGED_FILES:-}" ]; then
                local _carryover_note="

## Work Already Done (previous attempt)"
                if [ -n "${LAST_VERIFIED_TOUCHED_FILES:-}" ]; then
                    _carryover_note="${_carryover_note}
These files already have real changes from the previous attempt — build on them, do NOT rewrite from scratch unless the review/test feedback specifically says one of them is wrong:
$(echo "$LAST_VERIFIED_TOUCHED_FILES" | sed 's/^/- /')"
                fi
                if [ -n "${LAST_VERIFIED_UNCHANGED_FILES:-}" ]; then
                    _carryover_note="${_carryover_note}
These declared files still show NO changes since baseline — if the story needs them, you must actually write to them:
$(echo "$LAST_VERIFIED_UNCHANGED_FILES" | sed 's/^/- /')"
                fi
                COORDINATOR_PROMPT_AMENDMENT="${COORDINATOR_PROMPT_AMENDMENT:-}${_carryover_note}"
            fi

            # Layer 2: LLM gate (only for capability/quality failures, only when enabled)
            local _next_model
            _next_model=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .retryModel // ""' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
            _next_model="${_next_model:-${EPAM_RETRY_MODEL:-}}"
            if [ "$COORDINATOR_ESCALATE" = "yes" ] && \
               [ "$COORDINATOR_FAILURE_CLASS" != "env" ] && \
               [ -n "$_next_model" ]; then
                assess_model_escalation "$story_id" "$_raw_for_coord" "$json_result_file" "$output_file" "$_next_model"
            fi

            # Cross-run memory: persist failure evidence so future runs and the
            # coordinator can detect repeated failure patterns across multiple runs.
            local _failures_file="${LOG_DIR}/story-failures.jsonl"
            local _raw_sz=0
            [ -f "$_raw_for_coord" ] && _raw_sz=$(wc -c < "$_raw_for_coord" 2>/dev/null || echo 0)
            local _tokens_out_mem=0
            [ -f "$json_result_file" ] && _tokens_out_mem=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo 0)
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn \
                    --arg sid "$story_id" \
                    --arg fc "$COORDINATOR_FAILURE_CLASS" \
                    --arg model "${STORY_MODEL:-unknown}" \
                    --argjson attempt "$retry_count" \
                    --argjson exit_c "$exit_code" \
                    --argjson raw_sz "${_raw_sz:-0}" \
                    --argjson toks "${_tokens_out_mem:-0}" \
                    --argjson iters "${STORY_MAX_ITERATIONS:-0}" \
                    '{storyId:$sid, failureClass:$fc, model:$model,
                      attempt:$attempt, exitCode:$exit_c, rawBytes:$raw_sz,
                      outputTokens:$toks, maxIterations:$iters,
                      timestamp:(now|todate)}' >> "$_failures_file"
            ) 300>>"${_failures_file}.lock"

            # Layer 3: failure analyst — diagnose test failure and patch PRD or inject
            # skill guidance before the next retry. Only runs when more retries remain.
            # Skipped for deterministic-check failures (relative-import-check,
            # mock-completeness-check): the check's own message already names the
            # exact violation precisely — spending a gate-model call to "diagnose"
            # something already known is pure waste. Inject the check's message
            # directly as retry guidance instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]; then
                log "  [DeterministicCheck] Skipping failure-analyst — violation already precisely known"
                local _existing_amendment="${COORDINATOR_PROMPT_AMENDMENT:-}"
                # Re-inject the last failure-analyst diagnosis for this story from
                # healing-events.jsonl. DeterministicCheck skips the analyst (saving
                # a gate-model call) but that means the agent loses the actionable
                # "use this pattern instead" guidance the analyst wrote on earlier
                # retries. Without re-injection, subsequent retries only see the
                # pre-check's terse error message — not the richer fix guidance.
                local _last_fa_diagnosis=""
                local _heal_log="${LOG_DIR}/healing-events.jsonl"
                if [ -f "$_heal_log" ]; then
                    _last_fa_diagnosis=$(python3 "$SCRIPT_DIR/lib/handlers/last-fa-diagnosis.py" "$_heal_log" "$story_id" 2>/dev/null || echo "")
                fi
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
                jq_vals \
                      --arg prior_diagnosis_section "${_last_fa_diagnosis:+

## Prior failure-analyst diagnosis (re-injected for context)
$_last_fa_diagnosis
Apply the above diagnosis AND fix the deterministic check violation — both must be resolved.}" \
                      --arg verification_failure "${VERIFICATION_FAILURE}" \
                      --arg existing_amendment "${_existing_amendment}" \
                      '{"__PRIOR_DIAGNOSIS_SECTION__":$prior_diagnosis_section,"__VERIFICATION_FAILURE__":$verification_failure,"__EXISTING_AMENDMENT__":$existing_amendment}' > "$_cp_vals"
                _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" deterministic_check)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
                rm -f "$_cp_vals"

                # A deterministic-check violation repeating IDENTICALLY across attempts
                # is just as strong an escalation signal as an LLM-diagnosed repeat, but
                # check_healing_effectiveness never sees it (it only runs inside
                # run_failure_analyst, deliberately skipped above). Confirmed live
                # (run #15, 2026-07-05): SKY-003 repeated the SAME relative-import-check
                # violation 5 times across free AND counted retries with zero
                # escalation, because the only repeat-detector was being bypassed.
                # Reuse the existing HEALING_BROKEN flag/skip-to-next-rung consumer
                # logic below instead of building a separate signal.
                #
                # BUG (found live, 2026-07-05): comparing the RAW VERIFICATION_FAILURE
                # text false-triggered a repeat between two GENUINELY DIFFERENT
                # violations (a relative-import-check failure, then a totally
                # unrelated mock-completeness-check failure on the retry) — every
                # deterministic check's message shares the same templated preamble
                # ("## Verification Failure\n\n<intro sentence>... anything else:\n\n")
                # plus the same recurring file/class names for this story, so generic
                # boilerplate words alone crossed the token-overlap threshold (11
                # shared tokens, ratio 0.52) even though the actual problem was
                # unrelated. Fix: strip the templated intro (everything through the
                # first ":\n\n") before comparing — only the check-specific detail
                # lines that follow are meaningful signal.
                local _prev_violation_detail _cur_violation_detail
                _prev_violation_detail="${_prev_deterministic_violation#*:$'\n'$'\n'}"
                _cur_violation_detail="${VERIFICATION_FAILURE#*:$'\n'$'\n'}"
                if [ -n "$_prev_deterministic_violation" ]; then
                    local _same_violation
                    _same_violation=$(same_root_cause_diagnoses "$_prev_violation_detail" "$_cur_violation_detail")
                    if [ "$_same_violation" = "true" ]; then
                        error "  [DeterministicCheck] CRITICAL: same violation repeated for $story_id without resolution — treating as HealingBroken"
                        HEALING_BROKEN=1
                        export HEALING_BROKEN

                        # THE SKIP ABOVE IS CORRECT ONCE, AND ONLY ONCE.
                        #
                        # Skipping the analyst is right while the violation is NEW: the check names
                        # it precisely and a gate-model call to restate it is waste. That premise is
                        # falsified here. The remedy has been injected and applied and the SAME
                        # violation came back, so the open question is no longer WHAT is wrong — it
                        # is why the known remedy keeps failing, which is the analyst's only job.
                        #
                        # Live 2026-08-14 (AMSD-2041): the story climbed rung 0 -> 1 -> 2, declared
                        # HealingBroken three times, aborted at max rung, and the analyst was
                        # invoked ZERO times. Its ladder was unreachable code on this whole class.
                        if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                            log "  [DeterministicCheck] the remedy was applied and the same violation returned — invoking the failure analyst to diagnose WHY"
                            run_failure_analyst "$story_id" "$output_file" "$retry_count"
                        fi
                    fi
                fi
                _prev_deterministic_violation="$VERIFICATION_FAILURE"
                # AND THE ANALYST SEES IT EITHER WAY. The arm above invokes it only when the SAME
                # violation returns after a remedy; a first-time deterministic violation went
                # undiagnosed and the next attempt got nothing but the violation text it had
                # already failed to act on. No failure is filtered out of self-heal — a repeat is
                # a stronger signal, not the only one worth diagnosing.
                if [ "$_same_violation" != "true" ] && [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                    run_failure_analyst "$story_id" "$output_file" "$retry_count"
                fi
            elif [ $retry_count -lt $MAX_RETRIES ]; then
                run_failure_analyst "$story_id" "$output_file" "$retry_count"
            fi

            # An escalated defect (see escalate_defect_to_sibling_story) takes
            # priority over normal retry handling — if the escalating story's
            # agent correctly diagnosed a defect in a sibling's file it cannot
            # touch, resolve it now rather than letting the story burn its own
            # retry ladder re-diagnosing something it structurally cannot fix.
            if resolve_escalation "$story_id"; then
                success "  [Escalation] Resolved — free retry for $story_id (not counted against the ladder)"
                _free_attempts=$((_free_attempts + 1))
                continue
            fi

            # Deterministic-check failures get up to 3 FREE retries — they don't
            # advance retry_count (so they don't consume ladder/model-escalation
            # budget), since a mechanical "you missed a spot" violation is not
            # evidence of a capability gap the way a real test failure is. After 3
            # free retries without resolution, fall through to a normal counted
            # retry to bound the loop. Skipped entirely when the violation just
            # repeated identically (HEALING_BROKEN set above) — granting another
            # free retry on a KNOWN-non-converging violation just wastes an attempt;
            # fall straight through to the counted/rung-skip path instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ] && [ "${HEALING_BROKEN:-0}" -ne 1 ] && [ "$_free_retry_count" -lt 3 ]; then
                _free_retry_count=$((_free_retry_count + 1))
                DETERMINISTIC_CHECK_FAILURE=0
                export DETERMINISTIC_CHECK_FAILURE
                warning "  [DeterministicCheck] Free retry ${_free_retry_count}/3 for $story_id — not counted against the model-escalation ladder"
                _free_attempts=$((_free_attempts + 1))
                continue
            fi
            DETERMINISTIC_CHECK_FAILURE=0
            export DETERMINISTIC_CHECK_FAILURE

            retry_count=$((retry_count + 1))
            # If self-healing is confirmed broken, skip to the start of the next rung
            # rather than burning the second attempt. At the last rung (3), abort instead.
            if [ "${HEALING_BROKEN:-0}" -eq 1 ]; then
                local _cur_rung=$(( (retry_count - 1) / 2 ))
                local _next_rung_start=$(( (_cur_rung + 1) * 2 ))
                HEALING_BROKEN=0
                export HEALING_BROKEN
                if [ "$_cur_rung" -ge 3 ] || [ "$_next_rung_start" -gt "$MAX_RETRIES" ]; then
                    error "  [HealingBroken] At max rung — aborting $story_id"
                    break
                else
                    warning "  [HealingBroken] Skipping to rung $((_cur_rung + 1)) (retry $_next_rung_start) for $story_id"
                    retry_count=$_next_rung_start
                fi
            fi
            # Early escalation: the model made a DIFFERENT mistake on back-to-back
            # attempts while still un-escalated (Rung 0-1) — jump straight to Rung 2
            # (model escalation) instead of exhausting the rest of the base-model
            # budget. Mutually exclusive with HEALING_BROKEN by construction (a pair
            # of diagnoses can't be both the same root cause and different root
            # causes), so no ordering conflict between the two blocks.
            if [ "${EARLY_ESCALATION_NEEDED:-0}" -eq 1 ]; then
                EARLY_ESCALATION_NEEDED=0
                export EARLY_ESCALATION_NEEDED
                if [ "$retry_count" -lt 4 ] && [ 4 -le "$MAX_RETRIES" ]; then
                    warning "  [FailureDiversity] Jumping to Rung 2 (retry 4) for $story_id — base model isn't converging"
                    retry_count=4
                fi
                # Different failure classes across attempts (not the same bug
                # recurring) is the signature of token-selection variance, not a
                # capability gap — the model is making a DIFFERENT plausible
                # mistake each time rather than converging on the fix. Pin
                # temperature to near-zero for the remainder of this story so it
                # stops exploring alternative (and equally wrong) approaches and
                # sticks to its single most likely path, making exact-string ACs
                # (e.g. a literal error-message substring) reachable.
                warning "  [FailureDiversity] Pinning temperature to 0 for the remainder of $story_id — non-repeating failures indicate token-variance, not a capability gap"
                export EPAM_TEMPERATURE="0"
            fi
            # Persist BEFORE the sleep, not after — a killed/timed-out process
            # must not lose the rung it already reached.
            write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
            # The model belongs with the count: the count is only a proxy for the rung, and the
            # rung is only a proxy for WHICH MODEL RUNS. Persisting one without the other is
            # what made the ladder restart its climb on every re-invocation.
            write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
            # Persisted ALONGSIDE the model — see change-log/SEAM-CONSISTENCY-ANALYSIS.md.
            # A resume must know WHICH set chose this model, or a swap between invocations
            # leaves a rung name (e.g. MiniMax-M3) meaningless under the new set.
            write_story_retry_provider_set "$LOG_DIR" "$story_id" "${EPAM_PROVIDER_SET:-}"
            write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
            if [ $retry_count -le $MAX_RETRIES ]; then
                warning "$story_cli failed, retrying in ${RETRY_DELAY}s..."
                sleep $RETRY_DELAY
            fi
        fi
    done

    # Retry-extension coordinator (2026-07-12): the inner loop just exhausted
    # MAX_RETRIES. Before giving up, ask (at most once per story) whether the
    # evidence justifies a bounded extension -- see
    # run_retry_extension_coordinator()'s own docstring for the full design.
    if [ "$_retry_extension_used" -eq 0 ]; then
        _retry_extension_used=1
        local _granted_extra_retries
        _granted_extra_retries=$(run_retry_extension_coordinator "$story_id")
        if [ -n "$_granted_extra_retries" ] && [ "$_granted_extra_retries" -gt 0 ] 2>/dev/null; then
            MAX_RETRIES=$((MAX_RETRIES + _granted_extra_retries))
            # Retry extension (kimi-k3 territory): open the output token ceiling
            # to generator-level (16384) — at this point the story has exhausted
            # the standard ladder and is receiving the strongest available model;
            # any remaining token budget constraint must not be the failure mode.
            [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt 16384 ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS}"
            continue
        fi
    fi
    break
    done

    if ! escalation_budget_allows "$((_total_attempts - _free_attempts))" && [ $retry_count -le $MAX_RETRIES ]; then
        warning "  [Escalation] attempt budget for this escalation spent — $story_id's ladder stands at retry_count $retry_count (rung $((retry_count / 2))); the next escalation resumes there"
        append_cost_record "$story_id" "failed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
        write_healing_summary "$story_id" "failed" 2>/dev/null || true
        post_completion_message "$story_id" "failed"
        return 1
    fi
    error "Failed to implement $story_id after $((MAX_RETRIES + 1)) attempts"
    update_monitor_status "fail" "$story_id" "Failed after $((MAX_RETRIES + 1)) attempts"
    append_cost_record "$story_id" "failed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
    rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
    write_healing_summary "$story_id" "failed" 2>/dev/null || true
        post_completion_message "$story_id" "failed"
    return 1
}
