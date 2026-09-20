#!/usr/bin/env bash
# deliverables.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (8 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# _helper_module_separators <repo> <helper> — separator-like literals declared by the module that
# defines <helper>. Empty when the helper owns no format, which is why a feature helper like
# ContentstackFactory (zero such literals) can never trigger a rejection.
_helper_module_separators() {
    local _repo="$1" _helper="$2" _mod
    _mod=$(grep -rlE "(export +)?(function|const|class|let) +${_helper}\b" "$_repo/src" 2>/dev/null | head -1)
    [ -n "$_mod" ] || return 0
    grep -oE "(const|let|var) +[A-Za-z_][A-Za-z0-9_]* *= *'[^a-zA-Z0-9 ]{1,3}'|(const|let|var) +[A-Za-z_][A-Za-z0-9_]* *= *\"[^a-zA-Z0-9 ]{1,3}\"" "$_mod" 2>/dev/null \
        | grep -oE "'[^']{1,3}'|\"[^\"]{1,3}\"" | tr -d "\"'" | sort -u
}

# _change_duplicates_owned_format <repo> <helper> <diff>
# 1 when the change invents its own separator for a format the helper owns. 0 otherwise.
_change_duplicates_owned_format() {
    local _repo="$1" _helper="$2" _diff="$3"
    # Already uses the helper — nothing is being re-created.
    printf '%s' "$_diff" | grep -q -- "$_helper" && return 0
    local _owned; _owned=$(_helper_module_separators "$_repo" "$_helper")
    [ -n "$_owned" ] || return 0          # the helper owns no format: absence proves nothing
    # Separator-like literals the ADDED lines introduce inside format surgery: concatenation, or a
    # prefix/suffix/split/replace comparison. A literal in an import or a message is not surgery.
    local _used
    _used=$(printf '%s\n' "$_diff" | grep '^+' | grep -v '^+++' \
        | grep -oE "(\+ *'[^a-zA-Z0-9 ]{1,3}'|\+ *\"[^a-zA-Z0-9 ]{1,3}\"|(startsWith|endsWith|split|replace|includes)\( *'[^a-zA-Z0-9 ]{1,3}'|(startsWith|endsWith|split|replace|includes)\( *\"[^a-zA-Z0-9 ]{1,3}\")" \
        | grep -oE "'[^']{1,3}'|\"[^\"]{1,3}\"" | tr -d "\"'" | sort -u)
    [ -n "$_used" ] || return 0
    local _u _o
    while IFS= read -r _u; do
        [ -n "$_u" ] || continue
        while IFS= read -r _o; do
            [ -n "$_o" ] || continue
            [ "$_u" = "$_o" ] && continue           # same separator: not a duplication
            return 1
        done <<< "$_owned"
    done <<< "$_used"
    return 0
}

_committed_change_uses_helpers() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0

    local _helpers
    _helpers=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
        | map(select((.fixVerified == true) and ((.helper // "") != "")))
        | map(.helper) | unique | .[]' "$prd_target" 2>/dev/null)
    [ -n "$_helpers" ] || return 0

    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] && \
        _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    # baseline..HEAD — committed only. Not the tree.
    local _diff
    _diff=$(git -C "$PROJECT_ROOT" diff "$_ref" HEAD 2>/dev/null)
    [ -n "$_diff" ] || return 0

    local _missing=() _h
    while IFS= read -r _h; do
        [ -n "$_h" ] || continue
        # ABSENCE IS NOT THE SIGNAL — DUPLICATION IS. This demanded every fixVerified helper
        # appear in the committed diff. That premise holds only for a DEFECT, where the helper
        # sits on the changed line by construction (mock3 MOCK3-1: the fix IS `age >= 65` on the
        # line returning CONCESSION_FARE_CENTS). For a FEATURE it is a design choice and it
        # rejects working code: gotransit SHIPPED AMSD-2041 (e780a8b7, 9 files, +379) with
        # ContentstackFactory and getSinglePageEntry absent. Live 2026-08-19 this failed a story
        # whose commit succeeded and whose type check passed, and halted the codeline.
        #
        # The 2026-07-26 defect was never absence: it hand-rolled a format the repo already
        # parses — startsWith(id + '-') while dispatch-line-item-key.ts declares DIVIDER='#'.
        # A helper whose module owns no format can never trigger a rejection.
        _change_duplicates_owned_format "$PROJECT_ROOT" "$_h" "$_diff" || _missing+=("$_h")
    done <<< "$_helpers"
    [ ${#_missing[@]} -eq 0 ] && return 0

    local _missing_list
    _missing_list=$(printf '%s, ' "${_missing[@]}"); _missing_list="${_missing_list%, }"
    # EVERY missing one, not the first: reporting one at a time spends the retry ladder on
    # information this check already has.
    error "  [committed-change] $story_id: the COMMITTED change does not use ${#_missing[@]} verified helper(s): ${_missing_list}"
    error "  [committed-change]   The work that ships is missing part of the prescribed fix — an earlier attempt may have had it."
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe change you COMMITTED does not use %d prescribed helper(s) that the spec verified: %s\n\nEach owns part of this fix. Import and use every one of them in the files the plan names, then make the change again. A change that uses only some of them leaves the story incomplete even when the type check and the tests pass.\n' \
        "${#_missing[@]}" "$_missing_list")
    return 1
}

record_story_outputs() {
    local story_id="$1"
    [ -n "${LOG_DIR:-}" ] || return 0
    local _so_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/story-outputs.sh"
    [ -f "$_so_lib" ] || return 0
    # shellcheck disable=SC1090
    . "$_so_lib"
    story_outputs_record "${PROJECT_ROOT:-}" "$LOG_DIR"
}

# verify_prescribed_helper_used <story_id>
# When the pipeline prescribes an EXISTING helper, the change must use it.
#
# Live metrolinx 2026-07-26, run 5. The detective was right — real fix site, real
# quoted line, real helper (getDispatchLineItemKey, fixVerified: true) — and the
# implementer wrote this instead:
#
#   - (lineItem) => lineItem.id === discount.lineItemId,
#   + (lineItem) => lineItem.id === discount.lineItemId
#                   || lineItem.id.startsWith(discount.lineItemId + '-'),
#
# The separator in that repo is '#', declared as `const DIVIDER = '#'`. So
# "ORDER123#return".startsWith("ORDER123-") is false, the clause never matches,
# and the bug was entirely unfixed by a change that looked plausible. The helper
# appeared ZERO times in the diff.
#
# An agent hand-rolled string surgery against a format it GUESSED, when the repo
# already contained a parser for that format and the pipeline had already named
# it. Reusing the helper makes the separator impossible to get wrong, because the
# helper owns it.
#
# Only fires when the helper was named AND verified to exist (fixVerified). If the
# detective may have hallucinated it, demanding its use would force the agent to
# import something imaginary. Brownfield only; per-attempt WARNING, so the retry
# ladder owns the outcome.
# verify_client_env_boundary <story_id>
#
# A CONFIG VALUE READ WHERE THE BUILD NEVER SUBSTITUTES IT IS DEAD CODE THAT TYPE-CHECKS.
#
# Live 2026-08-14, AMSD-2041 on next.metrolinx.com:
#
#     if (process.env.CONTENTSTACK_LIVE_PREVIEW_ENABLED === "true") { initLivePreview(...) }
#
# in a useEffect — the browser. That framework substitutes only prefixed names into the client
# bundle, the codeline's config exposes no others, so the value is undefined and the branch never
# runs. tsc passed. eslint passed. The reviewer APPROVED it across two cycles and raised six other
# issues without this one, because seeing it needs a bundler rule and the project's own config,
# not the diff.
#
# THE ENGINE KNOWS NONE OF THAT. plugins/client-env-boundary-plugin.js holds the framework facts
# behind adapters selected by what the codeline's own manifest declares, and reads the exposed set
# from that codeline's config — so gotransit, upexpress and metrolinx are the same call, and a new
# stack is an adapter, never an engine change.
#
# Absent is absent: a codeline whose stack no adapter recognises reports nothing and this returns 0.
# A check that cannot identify the rule must not invent findings, and must not claim a clean bill
# of health either — the plugin distinguishes the two and only the first reaches here.
verify_client_env_boundary() {
    local story_id="$1"
    local _plugin="${AUTOMATION_DIR:-$(dirname "$SCRIPT_DIR")}/plugins/client-env-boundary-plugin.js"
    [ -f "$_plugin" ] || return 0
    [ -n "${PROJECT_ROOT:-}" ] && [ -d "$PROJECT_ROOT" ] || return 0

    # The files THIS story changed, from the writer's own output manifest — never a tree scan.
    local _changed
    _changed=$(git -C "$PROJECT_ROOT" diff --name-only "${PHASE_BASELINE_SHA:-HEAD~1}" HEAD 2>/dev/null; \
               git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | sed 's/^...//')
    [ -n "$_changed" ] || return 0

    local _out
    _out=$(printf '%s\n' "$_changed" | "${NODE_BIN:-node}" -e '
      const p = require(process.argv[1]);
      let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
        const files = [...new Set(raw.split("\n").map(s => s.trim()).filter(Boolean))];
        const r = p.scanClientEnvBoundary(process.argv[2], files);
        if (!r.exposureDeclared || !r.findings.length) return;
        for (const f of r.findings) console.log(f.file + ":" + f.line + "\t" + f.variable + "\t" + f.detail);
      });
    ' "$_plugin" "$PROJECT_ROOT" 2>/dev/null || echo "")

    [ -n "$_out" ] || return 0

    local _count _first_var
    _count=$(printf '%s\n' "$_out" | grep -c .)
    _first_var=$(head -1 <<< "$_out" | cut -f2)

    # Same rejection-key discipline as the reuse guard: an identical rejection twice advances the
    # ladder rather than re-asking the same model the same question.
    STORY_REJECTION_KEY="client-env:${_first_var}"
    # THE FLAG IS WHAT DELIVERS IT — see verify_prescribed_helper_used. VERIFICATION_FAILURE
    # without DETERMINISTIC_CHECK_FAILURE is assigned and dropped.
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\n%d configuration value(s) are read where the build does not substitute them, so at runtime each is undefined and the branch it guards silently does nothing:\n\n%s\n\nRead the value where it IS substituted and pass the result through, as this codeline already does elsewhere, or expose it deliberately.\n' \
        "$_count" "$(printf '%s\n' "$_out" | sed 's/^/  - /')")
    warning "Story $story_id: ${_count} value(s) read where the build never substitutes them — first: ${_first_var}. The guarded branch cannot execute; the type check and lint cannot see this."
    return 1
}

verify_prescribed_helper_used() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -n "${PROJECT_ROOT:-}" ] && [ -e "$PROJECT_ROOT/.git" ] || return 0
    local prd_target="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -f "$prd_target" ] || return 0

    # EVERY VERIFIED HELPER, not the first one.
    #
    # This selected `.[0].helper` and checked that alone. Live 2026-08-09 the spec verified FOUR
    # fix sites for one codeline — options, useContentstackContext, getEntry, getValue — the
    # writer used `options`, the guard fell silent, and the other three were never asked about.
    # The story shipped 1 of 4 verified sites and was reported complete, unable to satisfy its own
    # criterion ("the rendered page displays the DRAFT content values") because the fetch path
    # and context were never touched.
    #
    # fixVerified:true is a strong claim — the spec CONFIRMED the site and named the helper that
    # owns it. Unverified sites stay optional, since those are guesses and demanding them would
    # fail stories over a candidate the agent correctly ignored.
    local _helpers
    _helpers=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
        | map(select((.fixVerified == true) and ((.helper // "") != "")))
        | map(.helper) | unique | .[]' "$prd_target" 2>/dev/null)
    [ -n "$_helpers" ] || return 0

    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] &&         _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    local _diff
    _diff=$(git -C "$PROJECT_ROOT" diff "$_ref" 2>/dev/null)
    [ -n "$_diff" ] || return 0

    # Collect every verified helper the change does NOT use. Reporting only the first would
    # make the writer fix them one attempt at a time, which is the retry ladder spent on
    # information the guard already had.
    # Duplication, not absence — see _change_duplicates_owned_format. A helper whose module owns
    # no format can never trigger a rejection, so a feature that legitimately does not need it
    # passes, while a change that re-creates a format the helper owns is still caught.
    local _missing=() _h
    while IFS= read -r _h; do
        [ -n "$_h" ] || continue
        _change_duplicates_owned_format "$PROJECT_ROOT" "$_h" "$_diff" || _missing+=("$_h")
    done <<< "$_helpers"
    [ ${#_missing[@]} -eq 0 ] && return 0
    local _helper="${_missing[0]}"
    local _missing_list
    _missing_list=$(printf '%s, ' "${_missing[@]}"); _missing_list="${_missing_list%, }"

    local _note=""
    if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
        if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
            _note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
        else
            _note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
        fi
    fi
    # IT BLOCKS AGAIN, ON A SIGNAL THAT CANNOT REJECT WORKING CODE.
    #
    # It used to veto on helper ABSENCE. Proven against run artefacts: gotransit shipped
    # AMSD-2041 (e780a8b7, 9 files, +379) with two of metrolinx's fixVerified helpers absent, so
    # absence rejects working code — and each false rejection cost a whole writer attempt
    # (7.3M tokens, $2.25) before escalating the ladder to ask for something worse.
    #
    # The 2026-07-26 defect it exists for was DUPLICATION: startsWith(id + '-') while
    # dispatch-line-item-key.ts declares DIVIDER='#', so the fix could never match. That is what
    # is checked now. mock3's defect fixes still pass (the helper is on the changed line by
    # construction); gotransit's feature still passes (its helper module owns no format).
    STORY_REJECTION_KEY="helper-duplication:${_helper}"
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\n%d prescribed helper(s) OWN a format your change re-creates with its own literal: %s\n\nThe repository already parses this format. Hand-rolling it is how a fix comes to match on the wrong separator and silently never work. Import and use the helper instead of inventing the format.\n' "${#_missing[@]}" "$_missing_list")
    # WARNING, not ERROR: this is a RETRYABLE verdict and the writer gets another attempt. An
    # existing test asserts this, because an ERROR line reads as a dead run to anyone watching.
    warning "Story $story_id: the change re-creates a format owned by ${_missing_list} — import the helper rather than inventing the separator (${_helper} owns it; hand-rolling is how a fix matches on the wrong separator and silently never works)"
    return 1
}

verify_story_deliverables() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local missing=()
    local declared=0
    local file

    # Vendor/build-output directories (node_modules for npm, vendor for Go,
    # venv/site-packages for Python, etc.) are provisioned by dependency
    # install (run_dependency_check), never authored by the agent -- but a
    # spec-pass elaboration can still declare one in technicalNotes.files
    # (found live, 2026-07-12: SKY-001B declared node_modules/ before it
    # existed yet, costing one wasted retry). Reuse the SAME generic,
    # project-supplied vendorDirs config _get_vendor_dirs() reads for
    # run_dependency_check/_vendor_lock -- no new hardcoded directory list
    # in this engine. NOTE: cannot reuse _get_vendor_dirs() itself here --
    # it deliberately filters to dirs that ALREADY exist (right, for its own
    # lock/integrity-check callers), but this check specifically needs to
    # match a vendor dir that does NOT exist yet (that's the exact bug being
    # fixed), so read the same config key directly without that filter.
    local _vendor_dirs=""
    local _vendor_config="${PROJECT_ROOT}/.epam/dependency-check.json"
    if [ -f "$_vendor_config" ]; then
        _vendor_dirs=$(jq -r '.vendorDirs[]? // empty' "$_vendor_config" 2>/dev/null | \
            while IFS= read -r _d; do
                [ -n "$_d" ] && echo "${PROJECT_ROOT}/${_d}"
            done)
    fi

    local unchanged=()
    # Declared paths the spec VERIFIED (fixVerified:true). Read once so the per-file loop below
    # can separate a CONFIRMED fix site from a speculative candidate — a distinction the PRD
    # already carries and this gate previously discarded.
    # VERIFIED-SITE SELECTION
    #
    # "The spec CONFIRMED this site" and "this file must be MODIFIED" are different claims, and
    # conflating them made a story unwinnable. The detective marks a site verified when it is
    # IMPLICATED. Live AMSD-2041, the prescription for one verified site reads "No code change
    # required in <helper> itself — it already reads from <context>. Verify that ...", so the
    # writer correctly changed nothing and the gate failed the story for it. The same file was
    # verified on ALL THREE codelines, so the story could not complete anywhere; three runs and
    # roughly nine attempts died on it.
    #
    # changeRequired separates the two. It is STRUCTURAL on purpose: a gate that read the
    # prescription looking for phrases like "no code change" would hardcode English into the
    # engine, break on any rewording, and be untestable in another language. The detective emits
    # the boolean; this reads it.
    #
    # ABSENT MEANS REQUIRED — `!= false` rather than `== true`. A PRD written before this field
    # existed, a detective not yet updated, or a hand-written spec all keep today's behaviour.
    # The permissive default would silently disable the check this gate exists to perform, which
    # is the exact failure it was added to prevent (four sites verified, one changed, story
    # reported complete). Only an explicit boolean false exempts a site; null, "false", 0 and ""
    # are all absent.
    local _declared_files=()
    while IFS= read -r file; do
        [ -n "$file" ] || continue
        declared=$((declared + 1))
        _declared_files+=("$file")
        # Support both absolute paths and paths relative to PROJECT_ROOT.
        # In worktree mode, absolute paths in technicalNotes.files point to the main
        # repo (e.g. /skyscanner-app/src/foo.ts). Rewrite them to the worktree path
        # so the deliverable check and agent prompt target the correct directory.
        local check_path
        if [[ "$file" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$file" = "${MAIN_PROJECT_ROOT}"* ]]; then
                check_path="${PROJECT_ROOT}${file#${MAIN_PROJECT_ROOT}}"
            elif [[ "$file" = "${PROJECT_ROOT}/"* ]]; then
                check_path="$file"
            else
                # A DELIVERABLE OUTSIDE THE CODELINE IS NOT A DELIVERABLE. Resolved as given, an
                # absolute path into some other directory verifies whatever happens to be there:
                # the greenfield canonical named an August run's output directory, still present
                # on the host, and a run building into a fresh directory reported all three
                # deliverables present with nothing written (2026-09-13). Refused by name, so the
                # declaration gets corrected rather than the verdict.
                STORY_REJECTION_KEY="outside-codeline:$file"
                error "Story $story_id declares a deliverable outside the codeline ($PROJECT_ROOT): $file — a deliverable is a path within the codeline; declare it relative to the codeline root"
                return 1
            fi
        else
            check_path="$PROJECT_ROOT/$file"
        fi
        local _is_vendor_path=false
        if [ -n "$_vendor_dirs" ]; then
            while IFS= read -r _vendor_dir; do
                [ -z "$_vendor_dir" ] && continue
                case "$check_path" in
                    "$_vendor_dir"|"$_vendor_dir"/*) _is_vendor_path=true; break ;;
                esac
            done <<< "$_vendor_dirs"
        fi
        [ "$_is_vendor_path" = true ] && continue
        local _resolved
        if _resolved="$(_resolve_deliverable_path "$check_path")"; then
            [ "$_resolved" != "$check_path" ] && \
                log "  Deliverable '$file' resolved to '${_resolved#"$PROJECT_ROOT"/}' (declaration omitted the extension)"
            check_path="$_resolved"
        else
            missing+=("$file")
            continue
        fi
        # Brownfield: "exists and is non-empty" is a real signal for a file
        # the agent was supposed to CREATE, but it is trivially true — and
        # proves nothing — for a file that already existed before this story
        # started, which is the normal case for a bugfix in an existing
        # codebase. Live bug (2026-07-22): three separate story attempts ran
        # out of turn budget mid-exploration, called WriteFile/Edit on
        # nothing, and this check still passed every time because the
        # declared files (pre-existing application code) were obviously
        # already there — the pipeline then marked the story "completed" and
        # committed whatever incidental pipeline noise (CodeGraph index,
        # .epam manifests) happened to be dirty instead. For a file that
        # already existed at the story's own baseline (the commit its branch
        # was created from — see ensure_story_branch), require a REAL
        # content diff, not just presence. A genuinely NEW file (didn't
        # exist at baseline) is already fully proven by the exists+non-empty
        # check above — no diff is possible or required for it.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -e "$PROJECT_ROOT/.git" ]; then
            local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
            if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
                local _rel_path="$check_path"
                case "$_rel_path" in
                    "$PROJECT_ROOT"/*) _rel_path="${_rel_path#"$PROJECT_ROOT"/}" ;;
                esac
                # A GITIGNORED FILE CAN NEVER BE AT BASELINE, so its absence there proves
                # nothing. The rule below treats "absent at baseline" as "a genuinely NEW file,
                # fully proven by exists + non-empty" — correct for a tracked file the story
                # created, and wrong for one git will never track.
                #
                # Live 2026-08-09, twice: `.env.local` was declared, exists on disk, is
                # gitignored. It counted as satisfied work, which moved the tally from
                # 12/12-unchanged to 11/12 — one below the threshold — so the hard
                # "all declared deliverables UNCHANGED, no real work done" failure never fired.
                # The writer produced a paragraph of prose, called WriteFile zero times, changed
                # nothing, and the run reported "Implemented: 1, Failed: 0". One such path in a
                # declared list disables that gate for every story, on every run.
                #
                # Treated as unchanged rather than missing: the file is genuinely there, it is
                # simply not evidence that this story did anything.
                if git -C "$PROJECT_ROOT" check-ignore -q "$_rel_path" 2>/dev/null; then
                    unchanged+=("$file")
                elif git -C "$PROJECT_ROOT" cat-file -e "${_baseline_ref}:${_rel_path}" 2>/dev/null; then
                    if git -C "$PROJECT_ROOT" diff --quiet "$_baseline_ref" -- "$_rel_path" 2>/dev/null; then
                        # Soft signal, NOT added to missing[] — declared files
                        # that pre-existed at baseline (the normal case for a
                        # bugfix) can legitimately include several CANDIDATE
                        # fix sites (e.g. locationHint's 2-3 file guesses from
                        # spec-mode-runner.js), only some of which the agent
                        # may genuinely need to touch. Requiring EVERY
                        # candidate to change is over-strict and produces a
                        # false failure the moment a real fix only needs a
                        # subset — found live (2026-07-23, AMSD-1820): openspec
                        # correctly identified 3 candidate files, the agent
                        # correctly edited 2 of them, and this check failed
                        # the whole story over the 1 unedited candidate.
                        # A file the story explicitly says to CREATE (didn't
                        # exist at baseline) has no such ambiguity — that one
                        # stays a hard requirement via missing[] above.
                        unchanged+=("$file")
                    fi
                fi
            fi
        fi
    # A LANE IS JUDGED BY ITS OWN CODELINE'S FILES.
    #
    # .technicalNotes.files is the UNION across every codeline; .technicalNotes.perCodeline holds
    # the correct per-lane lists. Reading the union asked a question scoped to one lane and
    # answered it with data scoped to all three: live 2026-08-09 the union carried
    # ContentstackQuote.tsx, which exists only in next.metrolinx.com, so gotransit's writer was
    # required to produce a component that does not belong in its repository. It could not, and no
    # retry could — an unwinnable loop that would have failed upexpress the same way.
    #
    # .codeline is authoritative here: _filtered_prd stamps each lane PRD with its own codeline so
    # consumers need not know lanes exist. Falls back to the flat list when there is no
    # per-codeline entry (single-codeline runs, or a lane the spec pass produced no list for) —
    # never to "nothing", which would pass the gate for a story that did no work. An explicitly
    # EMPTY per-codeline list is honoured as "this lane declares nothing", which is not the same
    # as having no entry at all.
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) as $s
         | ($s.technicalNotes // {}) as $tn
         | ((($tn.perCodeline // {})[$s.codeline // ""]) | if . == null then null else (.files // .) end) as $scoped
         | (if $scoped == null then ($tn.files // []) else $scoped end)[]? // empty' \
        "$prd_target" 2>/dev/null)

    if [ ${#missing[@]} -gt 0 ]; then
        STORY_REJECTION_KEY="missing:$(printf '%s,' "${missing[@]}")"
        # Told to the WRITER, not only to the log: a rejection the next attempt cannot read is
        # a rejection it cannot act on. See every-gate-tells-the-writer-why.test.ts.
        # Same routing requirement as above — a missing declared file is a deterministic fact,
        # and without the flag the writer is rejected without ever being told which file.
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe story declares deliverable(s) that do not exist. Create each one at the exact path listed, or correct the declaration if the path is wrong:\n\n%s\n' "$(printf '  - %s\n' "${missing[@]}")")
        error "Story $story_id is missing ${#missing[@]} declared deliverable(s) in $PROJECT_ROOT:"
        for file in "${missing[@]}"; do
            error "  $file"
        done
        return 1
    fi

    # Persist which declared files got real work vs which sat untouched, so a
    # RETRY (whatever the reason — tsc failure, review rejection, this
    # function's own "all unchanged" verdict below) can tell the next attempt
    # explicitly what's already done and what still needs it, instead of
    # leaving that distinction to be re-derived from "## Existing File
    # Contents" prose alone. Globals (not local), same pattern as
    # STORY_REJECTION_KEY above — read by the retry loop after this function
    # returns, from a different scope.
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    if [ "$declared" -gt 0 ]; then
        local _touched=()
        local _f
        for _f in "${_declared_files[@]}"; do
            local _is_unchanged=false _is_missing=false
            for file in "${unchanged[@]}"; do [ "$file" = "$_f" ] && _is_unchanged=true && break; done
            for file in "${missing[@]}"; do [ "$file" = "$_f" ] && _is_missing=true && break; done
            [ "$_is_unchanged" = false ] && [ "$_is_missing" = false ] && _touched+=("$_f")
        done
        LAST_VERIFIED_TOUCHED_FILES=$(printf '%s\n' "${_touched[@]}")
        LAST_VERIFIED_UNCHANGED_FILES=$(printf '%s\n' "${unchanged[@]}")
    fi

    # Fail only when EVERY declared, pre-existing file is unchanged — that's
    # the "nothing real happened" signal this whole function exists to catch.
    # If at least one declared file shows a real diff, the story did genuine
    # work; the rest were legitimate candidates that turned out unnecessary.
    if [ "$declared" -gt 0 ] && [ ${#unchanged[@]} -eq "$declared" ]; then
        # PER-ATTEMPT verdict, exactly like the zero-declared fallback below:
        # returning 1 sends the story back through the retry ladder and a later
        # attempt routinely succeeds. d2a7c1b fixed the severity of that sibling
        # and left this one terminal-sounding, so live metrolinx 2026-07-26
        # printed this as [ERROR] on attempts 3 and 4 of 8, carrying no attempt
        # number, for a story that then succeeded. That is the same reading trap
        # that once got a healthy run killed by hand, one branch over. Severity
        # is a contract with the reader the way exit status is a contract with
        # the caller: warn per attempt, and leave the terminal error to the
        # loop's own exhaustion path.
        local _unchanged_note=""
        if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
            if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                _unchanged_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
            else
                _unchanged_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
            fi
        fi
        STORY_REJECTION_KEY="unchanged-all:$(printf '%s,' "${unchanged[@]}")"
        warning "Story $story_id: all $declared declared deliverable(s) exist but are UNCHANGED since baseline — no real work done anywhere in the declared set${_unchanged_note}:"
        for file in "${unchanged[@]}"; do
            warning "  $file"
        done
        return 1
    # THE VERIFIED-FIX-SITE GATE WAS DELETED HERE (2026-08-12, operator decision).
    #
    # It demanded a real diff in EVERY site the spec marked fixVerified. That is conformance to
    # the plan — and the plan is GUIDANCE. The detective points the writer at the right region
    # of a real codebase; the writer READS THE CODE and fills the gaps. Gating on "did every
    # prescribed file change" makes a story unwinnable the moment the plan is imperfect, which
    # by design it is expected to be.
    #
    # Record: ONE true catch (2026-08-09, four verified sites, one changed, story reported
    # complete) against at least three false failures. Its own comment recorded "three runs and
    # roughly nine attempts died on it", and on 2026-08-12 it blocked AMSD-2041 by demanding a
    # diff in a file whose own prescription reads "No code change required in useContent
    # itself".
    #
    # No weaker setting works either: relaxed to "at least one verified site changed", the very
    # incident it was built for PASSES, because the writer did change one. It substituted a
    # structural proxy (file diffs) for a question about behaviour (can this satisfy its
    # criterion), and a structural proxy over a guidance artefact gives exactly what was seen:
    # false rejections of correct work, silence on incorrect work.
    #
    # What holds instead: the tests and the verification criteria — what a user observes, which
    # cannot be satisfied by over-reach or under-delivery. The VC coverage check is weak today
    # (word overlap; it scored a working and a broken prescription alike as "complete"), and
    # strengthening it is the replacement for this gate rather than another proxy.

    elif [ ${#unchanged[@]} -gt 0 ]; then
        warning "Story $story_id: ${#unchanged[@]}/$declared declared candidate file(s) were unchanged (real work landed in the others) — informational, not a failure:"
        for file in "${unchanged[@]}"; do
            warning "  $file"
        done
    fi

    # Brownfield, zero declared files: the per-file loop above has nothing to
    # check, so it trivially passes — but that proves nothing about whether
    # the agent actually did any real work. Live bug (2026-07-22, run14):
    # locationHint propagation into technicalNotes.files (see spec-mode-
    # runner.js) is itself non-deterministic — the same spec-pass prompt can
    # return it populated on one attempt and empty on the next. When it's
    # empty, this function had NOTHING to verify and silently passed a story
    # whose agent turn produced no real change at all (confirmed: the only
    # file that had changed was CodeGraph's own incidental index write).
    # Fallback: if brownfield declared zero files, require the WHOLE tree to
    # show some real change relative to baseline, excluding known-incidental
    # pipeline paths (.codegraph/, .epam/) that are never genuine story
    # output. This is a coarser check than the per-file diff above (it can't
    # say WHICH file should have changed, since none were declared), but it
    # still catches "nothing real happened" — the actual failure pattern
    # behind three separate false-completion incidents today.
    if [ "$declared" -eq 0 ] && [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -e "$PROJECT_ROOT/.git" ]; then
        local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
        if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
            local _real_changes
            _real_changes=$(git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" 2>/dev/null | \
                grep -v -E '^(\.codegraph/|\.epam/)' || true)
            if [ -z "$_real_changes" ]; then
                # This is a PER-ATTEMPT verdict, not a terminal one: returning 1
                # sends the story back through the retry ladder, and a later
                # attempt routinely succeeds. Live metrolinx 2026-07-25 —
                # MiniMax-M3 returned success on attempt 1 having written
                # nothing; this check caught it, attempt 2 produced the correct
                # fix. But it was logged via error() with no attempt number, so
                # a healthy run read as a dead one and was killed by hand
                # mid-QA. Severity is a contract with the reader the same way
                # exit status is a contract with the caller: warn per attempt,
                # and let the loop's own exhaustion path own the terminal error.
                local _attempt_note=""
                if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
                    if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                        _attempt_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
                    else
                        _attempt_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
                    fi
                fi
                STORY_REJECTION_KEY="no-tree-change"
                warning "Story $story_id declared NO technicalNotes.files, and no real change exists anywhere in $PROJECT_ROOT relative to ${_baseline_ref} (only incidental pipeline paths, if anything, changed) — treating this attempt as incomplete rather than trusting an empty deliverable list.${_attempt_note}"
                return 1
            fi
        fi
    fi

    if [ "$declared" -gt 0 ]; then
        success "Verified $declared declared deliverable(s) for $story_id"
    fi
    # A prescribed, existing helper that the change never uses means the agent
    # re-implemented it — and guessed. Retryable.
    verify_prescribed_helper_used "$story_id" || return 1

    # A build-time value read where the build never substitutes it. Same class: mechanical,
    # checkable, and invisible to every other gate. Retryable.
    #
    # PRESENCE-GUARDED, like every other optional collaborator here. Fourteen test harnesses
    # extract this function and run it in isolation; an unguarded call to a sibling they do not
    # extract fails them all with "command not found", which reads as a production defect and is
    # not one. In a real run the function is always defined a few lines above, so the guard costs
    # nothing and never silently skips anything that exists.
    if command -v verify_client_env_boundary >/dev/null 2>&1; then
        verify_client_env_boundary "$story_id" || return 1
    fi

    # The story produced real, verified work — tell the phase gates what it was
    # so they can judge this run's output instead of the whole codebase.
    record_story_outputs "$story_id"
    return 0
}

# GAP-P17 — Emit a StoryArtifact record to logs/story-artifacts.jsonl.
# When the story has an outputSchema field in the PRD, the agent result text
# is validated against it and the parsed object is included in the artifact.
emit_story_artifact() {
    local story_id=$1 status=$2 phase_id=$3 elapsed_minutes=$4 cost_usd=$5 task_turns=$6 json_result_file=${7:-}
    local artifact_file="${LOG_DIR}/story-artifacts.jsonl"
    local lock_file="${artifact_file}.lock"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Read outputSchema if defined for this story
    local output_schema
    output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")

    # Try to parse structured output from the result file when schema is present
    local structured_output="null"
    if [ -n "$output_schema" ] && [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        local result_text
        result_text=$(jq -r '.result // ""' "$json_result_file" 2>/dev/null || echo "")
        # Extract first JSON object/array from result text
        local extracted
        extracted=$(echo "$result_text" | node "$SCRIPT_DIR/lib/handlers/story-artifact-extract.js" 2>/dev/null || echo "null")
        [ -n "$extracted" ] && structured_output="$extracted"
    fi

    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg sid "$story_id" \
            --arg phase "$phase_id" \
            --arg status "$status" \
            --argjson elapsed "${elapsed_minutes:-0}" \
            --argjson cost "${cost_usd:-0}" \
            --argjson turns "${task_turns:-0}" \
            --argjson schema "${output_schema:-null}" \
            --argjson structured "$structured_output" \
            '{storyId:$sid, phase:$phase, status:$status,
              elapsedMinutes:$elapsed, costUsd:$cost, turns:$turns,
              outputSchema:$schema, structuredOutput:$structured,
              timestamp:(now|todate)}' >> "$artifact_file"
    ) 200>"$lock_file"
}
