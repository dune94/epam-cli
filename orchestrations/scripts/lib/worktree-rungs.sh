#!/usr/bin/env bash
# worktree-rungs.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (7 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# _selective_worktree_reset <story_id>
# Rung escalations had zero git checkout/reset/clean between them — a failed
# rung's half-applied edits, stray broken writes, or any other incidental
# corruption sat on disk untouched and the next (usually stronger, costlier)
# model inherited it silently.
#
# A per-file preserve-list (an earlier version of this function, keyed off
# the story's DECLARED technicalNotes.files) turned out unsafe: a half-broken
# write and a genuinely correct but UNDECLARED file are both indistinguishable
# "has a diff from baseline" — restricting preservation to the declared set
# risked silently destroying real work outside it. Restricting to "any file
# with a diff" instead makes the reset a no-op (a broken file also has a
# diff), which defeats the point.
#
# That was once answered by a compiler signal (LAST_ATTEMPT_TSC_PASSED, set after
# run_tsc_verification): preserve the whole diff if the tree type-checked, reset it if not. That
# design is GONE, and the paragraphs below say why — a partially-complete multi-file change is
# correct progress and a compile error at the same time, so it preserved only work that was already
# coherent. The signal is no longer computed; the predicate is the spec's changeRequired.
#
# The third case is `unknown`: an earlier gate rejected the attempt before the
# tsc gate could run, so nothing is known either way. Treating that as failure
# (which it was until 2026-08-09) means a story rejected for being INCOMPLETE
# has its correct partial work deleted, and the next attempt re-derives the
# same files from an empty tree — observed live on AMSD-2041 for four
# consecutive attempts. Since the wanted evidence simply was not computed, this
# function computes it: run the check, then decide. Either way,
# LAST_VERIFIED_TOUCHED_FILES/
# LAST_VERIFIED_UNCHANGED_FILES are cleared on a real reset so the NEXT
# attempt's work-carryover prompt note (#112, above) never claims a file is
# "already done" after this function just erased it.
#
# Brownfield-only (mirrors every other baseline-diff mechanism in this file);
# no-ops silently when there's no git repo or no resolvable baseline ref, same
# safe-fallback posture as verify_story_deliverables' own baseline check.
_selective_worktree_reset() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0

    # `unknown` means the evidence this function wants was never computed: an earlier gate
    # rejected the attempt before it was complete. That is not a reason to delete the diff.
    #
    # The keep/discard question is a SPEC question: did this attempt move a file the spec
    # VERIFIED as a fix site? A compiler cannot answer it — for a multi-file feature a
    # partially-complete change is correct progress AND a compile error, so a build result
    # preserves only work that was already coherent. Live 2026-08-10: 25 writes destroyed.
    # KEEP/DISCARD IS A SPEC QUESTION, NOT A COMPILER QUESTION.
    #
    # This used to run the project's compiler and keep the work only if the WHOLE TREE compiled.
    # For any multi-file feature that is the inverse signal: a context provider written before
    # its consumer, or a changed function signature before its callers are updated, is correct
    # progress AND a compile error. So the branch could only preserve work that was already
    # coherent — precisely the work that never needed preserving. Live 2026-08-10: 25 file writes
    # across five invocations, zero survivors, on a story with 13 interdependent fix sites.
    #
    # The right question is whether the writer moved a file the spec says MUST CHANGE. The spec
    # already says which files matter; git already says which changed. No compiler required, and
    # nothing stack-specific in the engine.
    #
    # THE PREDICATE IS changeRequired, NOT fixVerified — corrected 2026-08-11.
    #
    # `fixVerified` means "the detective's PRESCRIPTION for this file was verified". "This file
    # must be edited" is `changeRequired`. Reading the first to answer the second inverted this
    # guard against its own stated intent. Measured on the live AMSD-2041/gotransit PRD:
    #
    #   changeRequired  fixVerified  file                                 was protected?
    #   true            true         src/context/ContentstackContext.tsx   yes
    #   true            FALSE        src/pages/_app.tsx                    NO
    #   true            NULL         .env.local.sample                     NO
    #   false           true         src/services/contentstack.ts          yes
    #   false           true         src/hooks/useContent.ts               yes
    #
    # Two of the THREE files the story must edit were not evidence of progress, so an attempt
    # that correctly edited _app.tsx and .env.local.sample and nothing else was DELETED as
    # "changed no VERIFIED fix site". Both files the detective said to LEAVE ALONE did count, so
    # an attempt that wrongly rewrote useContent.ts was PRESERVED — rewarding the exact failure
    # mode that killed three runs.
    #
    # ABSENT MEANS PROTECT, matching the enforcement gate's own `!= false` reading: a site with
    # no verdict has not been investigated, and "we do not know yet" is not grounds for deleting
    # work. Only an explicit boolean false — the detective saying this file needs no edit —
    # exempts a site from counting as progress.
    local _touched_fix_site=0
    if [ -n "${MAIN_PRD_FILE:-$PRD_FILE}" ]; then
        local _fs
        while IFS= read -r _fs; do
            [ -n "$_fs" ] || continue
            if ! git -C "$PROJECT_ROOT" diff --quiet "$_baseline_ref" -- "$_fs" 2>/dev/null; then
                _touched_fix_site=1; break
            fi
        done < <(jq -r --arg id "$story_id" '
            .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
            | map(select((.changeRequired | type == "boolean" and . == false) | not))
            | .[].file // empty' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
    fi
    if [ "$_touched_fix_site" -eq 1 ]; then
        log "  WorktreeReset[$story_id]: skipped — the attempt changed at least one file the spec says MUST change; partial work preserved"
        return 0
    fi

    # No positive evidence the tree is good — reset tracked files to baseline
    # content, drop untracked/ignored cruft. Same "predictable teardown"
    # primitive brownfield-preflight-reset.sh already applies between RUNS,
    # applied here between RUNGS of one run.
    # THE CHECKOUT MUST SUCCEED BEFORE THE CLEAN RUNS.
    #
    # Both ended in `2>/dev/null || true`, so an unresolvable baseline ref failed silently and the
    # `git clean -fd` still executed — deleting every untracked file WITHOUT the checkout having
    # restored the tracked ones. That is the worst possible half of this operation: destructive,
    # silent, and it leaves the tree in a state neither the attempt nor the baseline produced.
    #
    # A ref that resolves to nothing is the reachable case. _resolved_baseline_ref prints nothing
    # for a detached HEAD with no declared branch, and this is the reset between RUNGS of a live
    # run — the point at which an agent's partial work is discarded on purpose.
    if [ -z "$_baseline_ref" ]; then
        error "  WorktreeReset[$story_id]: no baseline ref resolved — refusing to clean the working tree with nothing to restore it from."
        return 1
    fi
    if ! git -C "$PROJECT_ROOT" checkout "$_baseline_ref" -- . 2>/dev/null; then
        error "  WorktreeReset[$story_id]: could not restore tracked files from ${_baseline_ref} — NOT running git clean, because that would delete untracked work without restoring anything."
        return 1
    fi
    git -C "$PROJECT_ROOT" clean -fd -- . 2>/dev/null || true
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    log "  WorktreeReset[$story_id]: reset to $_baseline_ref — the attempt changed no VERIFIED fix site"

    # Re-provision plugin config wiped by the git clean above (.epam/ is
    # untracked, same as every other pipeline-written manifest). Found live
    # 2026-08-02: a lane's first hard reset silently made the codeline-context
    # plugin unavailable for every subsequent attempt on that lane — nothing
    # re-provisioned it after the initial per-run setup. Shared with
    # ensure_story_branch()'s own working-tree reset (lib/git-ops.sh) — one
    # function instead of two independently drifting copies.
    _provision_epam_plugin_config "$PROJECT_ROOT"
}

# _rung_snapshot_path <story_id>
# One shared helper so the snapshot and attribution functions below always
# agree on where the reference file lives.
_rung_snapshot_path() {
    echo "${LOG_DIR}/.rung-snapshot-${1//[^A-Za-z0-9_-]/_}"
}

# _rung_snapshot_hashes <story_id>
# Records a content-hash of every file currently different from baseline
# (tracked-modified + untracked-new) — the "start of the next rung" reference
# _rung_attribute_changes compares against later to see what changed DURING
# that rung. Brownfield-only, same safe-fallback posture as the other
# baseline-diff mechanisms in this file.
_rung_snapshot_hashes() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0
    local _snap_file
    _snap_file=$(_rung_snapshot_path "$story_id")
    {
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u | while IFS= read -r _f; do
        [ -n "$_f" ] && [ -f "$PROJECT_ROOT/$_f" ] || continue
        local _hash
        _hash=$(git -C "$PROJECT_ROOT" hash-object "$PROJECT_ROOT/$_f" 2>/dev/null) || continue
        [ -n "$_hash" ] && printf '%s %s\n' "$_f" "$_hash"
    done > "$_snap_file"
}

# _rung_attribute_changes <story_id> <rung> <model>
# Compares the CURRENT tree against the snapshot taken at the start of the
# rung that just finished (rung/model passed in — the ones active during
# that rung, captured by the caller BEFORE it moved on). Any file whose hash
# differs from the snapshot (or is new since it) gets logged as this rung's
# contribution. A file whose hash is UNCHANGED since the snapshot is left
# alone — it keeps whatever an EARLIER rung already logged for it, so credit
# is never falsely reassigned to whichever rung happens to finish the story.
# No snapshot yet (first-ever rung, nothing to compare against) is a silent
# no-op — there's nothing prior to attribute against.
_rung_attribute_changes() {
    local story_id="$1" rung="$2" model="$3"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    local _snap_file
    _snap_file=$(_rung_snapshot_path "$story_id")
    [ -f "$_snap_file" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0
    local _contribution_file="${LOG_DIR}/rung-contribution.jsonl"
    {
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u | while IFS= read -r _f; do
        [ -n "$_f" ] && [ -f "$PROJECT_ROOT/$_f" ] || continue
        local _hash
        _hash=$(git -C "$PROJECT_ROOT" hash-object "$PROJECT_ROOT/$_f" 2>/dev/null) || continue
        [ -z "$_hash" ] && continue
        local _prev_hash
        _prev_hash=$(awk -v f="$_f" '$1==f{print $2}' "$_snap_file" 2>/dev/null)
        if [ "$_prev_hash" != "$_hash" ]; then
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn --arg sid "$story_id" --arg file "$_f" --arg rung "$rung" \
                    --arg model "$model" --arg ts "$(date -Iseconds)" \
                    '{story_id:$sid, file:$file, rung:$rung, model:$model, timestamp:$ts}' \
                    >> "$_contribution_file"
            ) 300>>"${_contribution_file}.lock"
        fi
    done
}

# _generate_rung_contribution_report <story_id>
# Cross-references the story's FINAL committed diff against rung-contribution.jsonl
# to answer "which rungs/models actually contributed surviving work" — a
# file's attribution is only reported if it's genuinely present in the
# current diff (a file whose rung got reset away by a later failed rung
# correctly disappears from this report, even though it was legitimately
# touched once — it did not survive to the final commit). Uses the LATEST
# attribution record per file: a file touched by rung 1 and left unchanged by
# rung 2 still credits rung 1, never silently reassigned to whichever rung
# happened to finish the story.
_generate_rung_contribution_report() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    local _contribution_file="${LOG_DIR}/rung-contribution.jsonl"
    [ -f "$_contribution_file" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0

    # Same tracked-modified + untracked-new enumeration as
    # _rung_snapshot_hashes/_rung_attribute_changes — git diff --name-only
    # alone misses brand-new files that were never `git add`ed, which would
    # silently drop e.g. a final rung's new file from this report entirely.
    local _final_files
    _final_files=$({
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u)
    [ -n "$_final_files" ] || return 0

    local _report_file="${LOG_DIR}/rung-contribution-report-${story_id//[^A-Za-z0-9_-]/_}.json"
    jq -s --arg sid "$story_id" --arg files "$_final_files" '
        ($files | split("\n") | map(select(length > 0))) as $finalFiles
        | map(select(.story_id == $sid))
        | group_by(.file)
        | map(max_by(.timestamp))
        | map(select(.file as $f | $finalFiles | index($f) != null))
        | group_by(.rung)
        | map({rung: .[0].rung, model: .[0].model, files: (map(.file) | sort)})
        | sort_by(.rung | tonumber? // .rung)
    ' "$_contribution_file" > "$_report_file" 2>/dev/null

    if [ -s "$_report_file" ] && [ "$(jq 'length' "$_report_file" 2>/dev/null || echo 0)" != "0" ]; then
        local _rung_count
        _rung_count=$(jq 'length' "$_report_file" 2>/dev/null || echo 0)
        log "  RungContribution[$story_id]: $_rung_count rung(s) contributed to the final diff:"
        while IFS= read -r _line; do
            log "    $_line"
        done < <(jq -r '.[] | "Rung \(.rung) (\(.model)): \(.files | join(", "))"' "$_report_file" 2>/dev/null)
    fi
}

# _scope_lock <story_id>
# Makes every .ts file in PROJECT_ROOT/src that is NOT in the story's declared
# technicalNotes.files read-only (chmod 444) before the agent runs, PLUS every
# file (any extension, any location under PROJECT_ROOT) declared by a DIFFERENT
# story — i.e. a file that already belongs to a prior (or sibling) story's own
# scope. This is an OS-level pre-emptive guard: Bash, WriteFile, or any other
# mechanism that tries to write an out-of-scope file will get EACCES — no
# tool-layer workaround exists.
#
# Root cause the second part fixes (found live, 2026-07-06): the original
# version only ever locked .ts files under src/ — tsconfig.json, package.json,
# vitest.config.ts (root-level, non-.ts scaffold artifacts) were completely
# unprotected. SKY-002 rewrote tsconfig.json — a file it never declared and
# had no business touching — changing a VALID moduleResolution SKY-001 had
# correctly scaffolded into an INVALID one, then regenerated the same wrong
# value on every retry attempt, exhausting the entire retry/escalation ladder
# on a self-inflicted regression in a file outside its own scope. Generic: not
# hardcoded to config-file names — protects whatever any OTHER story declared,
# whatever its extension or location.
_scope_lock() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local -A _decl
    while IFS= read -r _f; do
        [ -n "$_f" ] && _decl["$_f"]=1
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    local _locked=0

    if [ ${#_decl[@]} -gt 0 ]; then
        while IFS= read -r _f; do
            [ -n "${_decl[$_f]+x}" ] && continue
            chmod 444 "$_f" 2>/dev/null && ((_locked++))
        done < <(find "$PROJECT_ROOT/src" -name "*.ts" -type f 2>/dev/null)
    fi

    local _other_locked=0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        [ -n "${_decl[$_f]+x}" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] || continue
        chmod 444 "$_abs_f" 2>/dev/null && ((_other_locked++))
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)

    [ "$_locked" -gt 0 ] && log "  [scope-guard] Locked $_locked out-of-scope .ts file(s) (read-only) for $story_id"
    [ "$_other_locked" -gt 0 ] && log "  [scope-guard] Locked $_other_locked file(s) owned by other stories (read-only) for $story_id"
}

# _scope_unlock <story_id>
# Restores write permissions on all .ts files in PROJECT_ROOT/src, plus every
# file owned by a different story that _scope_lock locked above.
_scope_unlock() {
    local story_id="${1:-}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    find "$PROJECT_ROOT/src" -name "*.ts" -type f -exec chmod 644 {} + 2>/dev/null || true

    [ -z "$story_id" ] && return 0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] && chmod 644 "$_abs_f" 2>/dev/null || true
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)
}
