#!/usr/bin/env bash
# prd-change-review.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (7 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# run_prd_change_reviewer <story_id> <change_type> <before_json> <after_json>
# Validates a proposed PRD AC/TC or profiles.json change using the gate model.
# change_type: ac_patch | tc_patch | skill_note | profile_addendum
# Echoes "pass" or "fail"; caller decides whether to revert on fail.
# Silently returns "pass" if gate model is not configured (non-blocking).
run_prd_change_reviewer() {
    local story_id="$1"
    local change_type="$2"
    local before_json="$3"
    local after_json="$4"

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    if [ -z "$gate_provider" ]; then
        # A GATE THAT CANNOT JUDGE DOES NOT PASS. This emitted a literal "pass", so with no gate
        # provider configured every KB/PRD/profile write was AUTO-APPROVED and the caller read a
        # manufactured verdict as a real one — indistinguishable from a review that ran and found
        # nothing wrong.
        #
        # 'unreviewed' is the honest answer and callers already understand it:
        # reviewOutcomeKeepsChange() accepts only an explicit pass, so the change reverts rather
        # than standing on a judgement nobody made.
        error "  [PRD-ChangeReviewer] no gate provider configured — NOT reviewing; returning 'unreviewed' so the change is not kept on an unmade judgement" >&2
        echo "unreviewed"
        return 0
    fi
    # KB/PRD/profile writes are persistent and must be reviewed by the highest-quality
    # model available, not the cheap gate model. Use ESCALATION_MODEL_HIGH with high
    # reasoning so every persisted write is agentic-quality-reviewed.
    # THE REVIEWER'S OWN SEAM. This was a run-wide "high" model behind a run-wide pin behind a
    # vendor literal — three sources, none of them the ladder, and the literal always answered so
    # the ladder never had to.
    local gate_model
    gate_model=$(seam_model_or_fail "prd-change-reviewer" 2>/dev/null || printf '')

    # Select profile based on change type — KB entries use the stricter kb-change-reviewer
    local _profile_key="prd-change-reviewer"
    [ "$change_type" = "kb_entry" ] && _profile_key="kb-change-reviewer"
    local reviewer_profile=""
    if [ -f "$profiles_file" ]; then
        reviewer_profile=$(require_profile "$_profile_key" "$profiles_file" || true)
    fi

    local review_prompt
    # RENDERED FROM THE TEMPLATE LAYER. Values go via a FILE, never argv: before/after carry
    # whole PRD fragments, and a value past ARG_MAX exits 126 with an empty result — which is
    # how the FailureAnalyst died silently earlier today.
    local _rv_vals; _rv_vals=$(mktemp "${TMPDIR:-/tmp}/prd-review-vals-XXXXXX.json")
    jq_vals --arg profile "$reviewer_profile" --arg story "$story_id" --arg ct "$change_type" \
          --rawfile before <(printf '%s' "$before_json") --rawfile after <(printf '%s' "$after_json") \
          '{"__REVIEWER_PROFILE__":$profile,"__STORY_ID__":$story,"__CHANGE_TYPE__":$ct,"__BEFORE__":$before,"__AFTER__":$after}' \
          > "$_rv_vals" 2>/dev/null
    if ! review_prompt=$(render_engine_prompt prd-change-reviewer "$_rv_vals"); then
        # >&2 REQUIRED: this function returns its verdict on STDOUT, so any log written to
        # stdout is read as part of the verdict. There is a test for exactly this.
        error "  [PRD-Reviewer] cannot render its prompt — refusing to review with no instructions" >&2
        rm -f "$_rv_vals"; return 1
    fi
    rm -f "$_rv_vals"

    local review_raw=""
    # Full agent audit, 2026-07-31 (same class as HEAL-BLIND): several of this
    # reviewer's own rejection rules require checking a claim against the real
    # codebase (stack/tech usage, TC-fact verifiability), but this call had no
    # tool access at all — a live incident already occurred (rejected correct
    # Contentstack advice for Metrolinx with no way to check the real stack).
    # Reuses the same shared, read-only allowlist every other gate agent draws
    # from, bounded the same way.
    review_raw=$(echo "$review_prompt" | \
        EPAM_AGENT_NAME="prd-change-reviewer" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
        EPAM_MAX_TOOL_CALLS="${PRD_CHANGE_REVIEWER_MAX_TOOL_CALLS:-24}" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"verdict":"fail","issues":["the reviewer could not be reached — the change was NOT reviewed"],"reason":"reviewer unavailable"}')

    # ASKED AND GOT NO ANSWER IS NOT APPROVAL.
    #
    # These defaulted to 'pass' in four places, including an explicit
    # {"verdict":"pass","reason":"reviewer unavailable"} above — a reviewer that could not be
    # reached approved the change and said so in the reason field. This gate covers ac_patch and
    # tc_patch, so that silently accepted edits to acceptance criteria, which are supposed to be
    # immutable. code-review-cycle.sh settled the same question on 2026-07-23: 'SAFE default =
    # BLOCK, never silently approve an unreviewed change'.
    #
    # The documented opt-out above is untouched: with NO gate model configured the reviewer is
    # disabled and returns pass, because it was never asked. That is a different state from
    # asking and getting nothing back.
    local verdict=""
    verdict=$(echo "$review_raw" | python3 "$SCRIPT_DIR/lib/handlers/prd-change-verdict.py" 2>/dev/null || echo "fail")

    local issues=""
    issues=$(echo "$review_raw" | python3 "$SCRIPT_DIR/lib/handlers/prd-change-issues.py" 2>/dev/null || echo "")

    # CRITICAL: this function's return value is captured via command substitution
    # ($(run_prd_change_reviewer ...)). warning()/log() write to stdout as well as
    # the progress log, so any call to them here would pollute the captured verdict
    # with extra lines — making `[ "$verdict" = "fail" ]` at every call site always
    # false (the string would be "warning text\nfail", not "fail"), silently treating
    # every rejection as an approval. Redirect to stderr so only the final echo
    # reaches the caller.
    # Exposes the rejection reason to callers (e.g. run_change_with_reviewer_retry).
    # Every caller invokes this function via $(...) command substitution, which
    # forks a subshell — a plain variable assignment here (PRD_REVIEW_ISSUES=...)
    # would never be visible to the caller's shell. A file survives the subshell
    # exit, so use that instead. $$ scopes the file to this process (worktree
    # primary/independent run as separate PIDs, so no cross-process collision).
    printf '%s' "$issues" > "${TMPDIR:-/tmp}/.prd-review-issues-$$" 2>/dev/null || true

    if [ "$verdict" = "fail" ]; then
        warning "  [PRD-Reviewer] REJECTED ${change_type} for ${story_id}: ${issues:-no details}" >&2
        echo "fail"
    else
        log "  [PRD-Reviewer] APPROVED ${change_type} for ${story_id}" >&2
        echo "pass"
    fi
}

# run_prd_change_summarizer <story_id> <change_type> <issues> <rejected_text>
# Rewrites rejected self-heal text to address the reviewer's stated issues instead
# of discarding it outright. Most kb_entry/skill_note rejections are FORMAT problems
# (over 200 chars, wrong verb tense, references a specific story ID, truncated
# mid-sentence) — the underlying lesson is usually sound, only its shape is wrong.
# Prints the reformatted text to stdout (falls back to the original text if the
# gate model is unavailable or returns nothing usable).
run_prd_change_summarizer() {
    local story_id="$1"
    local change_type="$2"
    local issues="$3"
    local rejected_text="$4"

    # THE SAME CHAIN ITS FAMILY USES. ac-gate.js, codeline-discovery.js and cpa-inference.js all
    # consult EPAM_ORCHESTRATION_PROVIDER before giving up; this one read ORCH_GATE_PROVIDER alone,
    # so a run that set the orchestration provider and not the gate provider lost EVERY rewrite.
    local gate_provider="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
    if [ -z "$gate_provider" ]; then
        # DEGRADING IS FINE; DEGRADING IN SILENCE IS NOT. This returned the rejected text with no
        # diagnostic and exit 0, and the caller assigns the result as the rewritten value
        # (current=$(run_prd_change_summarizer ...)) — so the content a reviewer had just rejected
        # flowed onward as though it had been fixed. The text is still returned, because the caller
        # must not be left with nothing; what changes is that the skip is now visible.
        error "  [PRD-Summarizer] no provider resolved (ORCH_GATE_PROVIDER and EPAM_ORCHESTRATION_PROVIDER are both unset) — skipping the rewrite; the REJECTED text is being returned unchanged" >&2
        printf '%s' "$rejected_text"
        return 0
    fi
    # Summarizer rewrites rejected KB/PRD/profile writes — must use the same
    # high-quality model as the reviewer so the rewrite is meaningfully better.
    # THE REVIEWER'S OWN SEAM. This was a run-wide "high" model behind a run-wide pin behind a
    # vendor literal — three sources, none of them the ladder, and the literal always answered so
    # the ladder never had to.
    local gate_model
    gate_model=$(seam_model_or_fail "prd-change-reviewer" 2>/dev/null || printf '')

    # tool_creation rewrites a bash script, not a short prose rule — the
    # kb_entry/skill_note constraints (single line, under 200 chars, imperative
    # verb) would corrupt working code. Branch the prompt AND the post-processing
    # (no `tr -d '\n'` — a script needs its newlines) by change type.
    local summarize_prompt output_cap _sum_template
    if [ "$change_type" = "tool_creation" ]; then
        _sum_template="prd-change-summarizer-tool"
        output_cap=4000
    else
        _sum_template="prd-change-summarizer-text"
        output_cap=400
    fi

    # One renderer for both variants; the branch above chose WHICH prompt, not its text.
    local _sum_vals; _sum_vals=$(mktemp "${TMPDIR:-/tmp}/prd-sum-vals-XXXXXX.json")
    # Each variant gets exactly the values ITS template uses. The renderer rejects a value
    # nobody uses, deliberately: an extra value means the caller believes it supplied something
    # the prompt never mentions, which is the same defect as a missing one seen from the other
    # side. The tool variant carries no change type — a bash script is a bash script.
    if [ "$_sum_template" = "prd-change-summarizer-tool" ]; then
        jq_vals --arg story "$story_id" \
              --rawfile issues <(printf '%s' "${issues:-no details}") \
              --rawfile rejected <(printf '%s' "$rejected_text") \
              '{"__STORY_ID__":$story,"__ISSUES__":$issues,"__REJECTED_TEXT__":$rejected}' \
              > "$_sum_vals" 2>/dev/null
    else
        jq_vals --arg story "$story_id" --arg ct "$change_type" \
              --rawfile issues <(printf '%s' "${issues:-no details}") \
              --rawfile rejected <(printf '%s' "$rejected_text") \
              '{"__STORY_ID__":$story,"__CHANGE_TYPE__":$ct,"__ISSUES__":$issues,"__REJECTED_TEXT__":$rejected}' \
              > "$_sum_vals" 2>/dev/null
    fi
    if ! summarize_prompt=$(render_engine_prompt "$_sum_template" "$_sum_vals"); then
        # >&2 REQUIRED: the caller captures this function with command substitution
        # (current=$(run_prd_change_summarizer ...)), so a log on stdout becomes the rewritten
        # text. Same hazard as the reviewer above.
        error "  [PRD-Summarizer] cannot render '$_sum_template' — refusing to rewrite with no instructions" >&2
        rm -f "$_sum_vals"; return 1
    fi
    rm -f "$_sum_vals"

    local summarized=""
    summarized=$(echo "$summarize_prompt" | \
        EPAM_AGENT_NAME="prd-change-summarizer" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null | head -c "$output_cap" || echo "")
    if [ "$change_type" = "tool_creation" ]; then
        summarized="$(echo "$summarized" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    else
        summarized="$(echo "$summarized" | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    fi

    if [ -n "$summarized" ]; then
        printf '%s' "$summarized"
    else
        printf '%s' "$rejected_text"
    fi
}

# _skill_note_format_ok <note> <story_id> <existing_profile_text>
# Deterministic pre-check for the OBJECTIVELY verifiable skill_note/kb_entry
# format rules already stated in profiles.json's prd-change-reviewer /
# kb-change-reviewer profiles: length cap, imperative opener, no story-ID
# reference, not a verbatim duplicate of an existing line in the same
# profile. These are checkable facts, not subjective judgment calls -- yet a
# live run (2026-07-07) observed the LLM reviewer reject notes that already
# satisfied every one of these rules (e.g. "Always end TypeScript statements
# with semicolons...", well under 200 chars, no story ID), 3/3 times, purely
# on flaky format judgment. That burns a gate round-trip per rejection for
# zero benefit. When a candidate passes this check, skip the LLM review
# entirely for format -- genuinely subjective calls (does this CONTRADICT an
# existing rule, is the underlying lesson actually sound) are out of scope
# here and still need a real reviewer, so this only short-circuits the
# specific failure mode that was observed wasting cost.
# The declared skill-note length limit. One source (config/self-heal.json), read by the checker
# here and handed to the failure analyst so it writes within it in the first place.
_skill_note_max_chars() {
    local _cfg="${AUTOMATION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/config/self-heal.json"
    local _v=""
    [ -f "$_cfg" ] && _v=$(jq -r '.skillNote.maxChars // empty' "$_cfg" 2>/dev/null)
    case "$_v" in (''|*[!0-9]*) 
        echo "[skill-note] config/self-heal.json declares no numeric skillNote.maxChars — refusing to guess a limit" >&2
        return 1 ;;
    esac
    printf '%s' "$_v"
}

_skill_note_format_ok() {
    local note="$1"
    local story_id="$2"
    local existing_profile_text="${3:-}"
    [ -z "$note" ] && return 1
    # THE DECLARED LIMIT, NOT A NUMBER WRITTEN HERE. See config/self-heal.json: the producer is
    # told the same value, so a note no longer has to be rejected and rewritten to discover it.
    local _max; _max=$(_skill_note_max_chars)
    [ "${#note}" -le "$_max" ] || return 1
    echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b" || return 1
    if [ -n "$story_id" ] && echo "$note" | grep -qi "$story_id"; then
        return 1
    fi
    if [ -n "$existing_profile_text" ] && echo "$existing_profile_text" | grep -qF "$note"; then
        return 1
    fi
    return 0
}

# _ensure_imperative_opener <note>
# Deterministically normalizes a skill_note/kb_entry candidate to satisfy
# _skill_note_format_ok's imperative-opener check, WITHOUT ever needing an
# LLM rewrite round-trip. Closes a live gap (2026-07-12, tier3-travel-app
# run): SKY-002-impl's FailureAnalyst produced a genuinely correct, specific
# note -- "When converting an interface to Record<string, unknown>, ensure
# the interface has an index signature or use 'unknown' first to avoid
# TS2352 error." -- but it opens with a subordinate "When X, ..." clause,
# not an imperative, so it correctly failed the deterministic format check
# and went through the full LLM reviewer 3 times on this SAME fixable
# wording issue, then was persisted UNREVIEWED as a fallback. The lesson
# itself was fine; only the opening word was wrong -- a mechanically
# fixable defect, not a judgment call. Prepending
# SKILL_NOTE_NORMALIZATION_OPENER (a configurable var, checked against the
# SAME SKILL_NOTE_IMPERATIVE_OPENERS list _skill_note_format_ok uses -- no
# word list duplicated or hardcoded independently in either function) is a
# generic, content-preserving transform (not a rewrite) that reliably
# satisfies the imperative check for ANY note shape, so apply it BEFORE the
# note is ever handed to run_change_with_reviewer_retry, letting an
# otherwise-sound note skip the LLM reviewer entirely on the very first
# attempt.
_ensure_imperative_opener() {
    local note="$1"
    [ -z "$note" ] && { printf ''; return 0; }
    if echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    # Sanity-check the configured normalization opener is itself an accepted
    # word (not assumed) -- if misconfigured, fall through without
    # normalizing rather than prepend something that wouldn't pass the check
    # anyway.
    if ! echo "$SKILL_NOTE_NORMALIZATION_OPENER" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    # NO TRUNCATION. This function PREPENDS an opener, which makes the string LONGER;
    # cutting the tail to compensate destroys the END of the instruction — where the fix
    # lives. Live 2026-08-11, AMSD-2041/gotransit: the analyst correctly diagnosed a Jest
    # ESM failure and this line delivered "...change the pattern to
    # '/node_modules/(?!swiper|@azure|uu" to the writer. Told to change a regex, never told
    # to what. Eight attempts, three ladder rungs, the run lost, on a one-line config fix.
    # A severed instruction is not shorter guidance, it is confidently wrong guidance.
    printf '%s' "${SKILL_NOTE_NORMALIZATION_OPENER}: ${note}"
}

run_change_with_reviewer_retry() {
    local story_id="$1"
    local change_type="$2"
    local before="$3"
    local candidate="$4"
    local max_retries="${5:-3}"

    # Same subshell-scope issue as PRD_REVIEW_ISSUES: this whole function is also
    # invoked via $(...) by its callers, so a plain REVIEWER_RETRY_TEXT=... here
    # would never reach them. File-based side channel again; callers read it
    # right after the command substitution (see kb)/skill) cases in
    # run_failure_analyst).
    local _issues_file="${TMPDIR:-/tmp}/.prd-review-issues-$$"
    local _retry_text_file="${TMPDIR:-/tmp}/.reviewer-retry-text-$$"

    if { [ "$change_type" = "skill_note" ] || [ "$change_type" = "kb_entry" ]; } \
        && _skill_note_format_ok "$candidate" "$story_id" "$before"; then
        printf '%s' "$candidate" > "$_retry_text_file" 2>/dev/null || true
        log "  [PRD-Reviewer] Skipped LLM review for ${change_type} (${story_id}) -- deterministic format check passed" >&2
        echo "pass"
        return 0
    fi

    local attempt=1
    local current="$candidate"
    local verdict="" review_issues=""
    while [ "$attempt" -le "$max_retries" ]; do
        verdict=$(run_prd_change_reviewer "$story_id" "$change_type" "$before" "$current")
        if [ "$verdict" != "fail" ]; then
            printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
            echo "pass"
            return 0
        fi
        review_issues=$(cat "$_issues_file" 2>/dev/null || echo "")
        if [ "$attempt" -lt "$max_retries" ]; then
            log "  [PRD-Summarizer] Rewriting rejected ${change_type} for ${story_id} (attempt ${attempt}/${max_retries}): ${review_issues:-no details}" >&2
            current=$(run_prd_change_summarizer "$story_id" "$change_type" "$review_issues" "$current")
        fi
        attempt=$((attempt + 1))
    done
    printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
    echo "fail"
    return 1
}

run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    # A SNAPSHOT OF NOW, NOT THE PRE-RUN CANONICAL FILE.
    #
    # This pointed at profiles.json.original — which pre-run-reset.sh and orchestrate.sh use as the
    # canonical BASE state for a whole run. Restoring it after a corrupted assessment threw away
    # every skill note, augmentation and mint result the run had accumulated up to that point, not
    # just the corruption, while reporting only "restoring backup".
    local profiles_backup="${LOG_DIR:-/tmp}/profiles-preassessment-${phase_id}.json"
    cp "$profiles_file" "$profiles_backup" 2>/dev/null || profiles_backup=""
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    if [ ! -f "$profiles_backup" ]; then
        cp "$profiles_file" "$profiles_backup"
        info "Backed up original profiles to $profiles_backup"
    fi

    info "Running pre-phase skill assessment for '$phase_id'..."

    local prd_rel
    prd_rel=$(realpath --relative-to="$PROJECT_ROOT" "$PRD_FILE" 2>/dev/null || echo "orchestrations/prd.json")

    local assessment_prompt
    _ap_vals=$(mktemp "${TMPDIR:-/tmp}/skill-assessment-prephase-vals-XXXXXX.json")
    # WHAT THIS PROJECT ACTUALLY IS — the template's own words. lib/handlers/agent-skills.js
    # derives it from the codeline's ecosystem and the KB the pipeline wrote while working on it
    # ("DERIVED, NEVER TYPED"). It existed with NO CALLERS, so this placeholder was never supplied
    # and the render threw. Absent is absent: an unresolvable project reports that, never a guess.
    local _ap_skills_file; _ap_skills_file=$(mktemp "${TMPDIR:-/tmp}/project-skills-XXXXXX.json")
    "${NODE_CMD:-node}" "$SCRIPT_DIR/lib/handlers/agent-skills.js" "${PROJECT_ROOT:-}" \
        "$AUTOMATION_DIR/agents" > "$_ap_skills_file" 2>/dev/null \
        || printf '%s' '(this project could not be resolved — do not infer skills from role names)' > "$_ap_skills_file"
    jq_vals \
          --arg phase_id "$phase_id" \
          --arg prd_rel "$prd_rel" \
          --rawfile project_skills "$_ap_skills_file" \
          '{"__PHASE_ID__":$phase_id,"__PRD_REL__":$prd_rel,"__PROJECT_SKILLS__":$project_skills}' > "$_ap_vals"
    rm -f "$_ap_skills_file"
    # The codeline's own facts — this template declares them and nothing supplied them.
    # Stack facts are the RENDERER's job — engine-prompt.js adds exactly the stack
    # placeholders this template DECLARES. Pre-merging all seven here made the
    # renderer throw "was given values it does not use" on every template that
    # declares fewer, and the caller reported "cannot render its prompt". Four
    # seams could not run at all, the fuzz-weaver among them.
    assessment_prompt="$(render_engine_prompt skill-assessment-prephase "$_ap_vals" with_prd_structure)"
    rm -f "$_ap_vals"

    cd "$PROJECT_ROOT"
    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    local _orch_model
    _orch_model="$(seam_model_or_fail "phase-assessment" 2>/dev/null || true)"
    if [ -z "$_orch_provider" ]; then
        warning "Pre-phase assessment: EPAM_ORCHESTRATION_PROVIDER not set — skipping (non-critical)"
    # AI_GATE_ALLOW_TOOLS=1: the prompt above instructs the agent to run real
    # jq commands against the PRD and read/write orchestrations/agents/profiles.json
    # directly — without this, ai-run.sh's epam-umbrella branch defaults to
    # --no-tools, so the agent can't actually run jq or touch any file; it can
    # only print a JSON description of what it WOULD do, and no real profile
    # augmentation or role-fix ever happens (found live 2026-07-08 — a run's
    # assessment step logged a fabricated "content" diff for profiles.json that
    # was never actually written to disk).
    # SAME DEFECT AS THE TC WRITER: `elif CMD | tee ...; then` tested tee, so "Pre-phase
    # assessment completed" was printed whether the agent ran, failed or timed out — and the
    # profiles.json validity check below only runs on that branch, so a failed agent skipped it.
    # THREE pipeline elements here (echo, ai-run, tee), so the agent's status is PIPESTATUS[1].
    elif { echo "$assessment_prompt" | \
            EPAM_AGENT_NAME="phase-assessment" EPAM_STORY_ID="${phase_id}" \
            AI_GATE_ALLOW_TOOLS=1 \
            AI_PROVIDER="$_orch_provider" \
            AI_MODEL="$_orch_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
            ${_orch_model:+--model "$_orch_model"} \
            2>&1 | tee "$assessment_log"; [ "${PIPESTATUS[1]}" -eq 0 ]; }; then
        success "Pre-phase assessment completed for '$phase_id'"
        if ! jq empty "$profiles_file" 2>/dev/null; then
            # A SNAPSHOT THAT FAILED IS NOT A SNAPSHOT — the same guard Steps 11 and 12 needed.
            # If the pre-call copy did not happen there is nothing to restore, and overwriting a
            # corrupted profiles.json with nothing is worse than leaving it for a human.
            if [ -n "$profiles_backup" ] && [ -s "$profiles_backup" ]; then
                warning "Pre-phase assessment may have corrupted profiles.json! Restoring the pre-assessment snapshot."
                cp "$profiles_backup" "$profiles_file"
            else
                error "Pre-phase assessment may have corrupted profiles.json AND no pre-assessment snapshot exists — leaving the file as-is. Restore it before the next phase."
            fi
        fi
    else
        warning "Pre-phase assessment failed for '$phase_id' (non-critical, continuing)"
    fi
}
