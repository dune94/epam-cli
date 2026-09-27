#!/usr/bin/env bash
# review-scope.sh — what the code reviewer is shown: the story's OWN commit, every file of it,
# and which of those files the story does not declare (and who does).
#
# regintel 20260919T224649Z (2026-09-20): 007a's commit rewrote regintel/classifier.py
# (+297/-98), a file it does not declare. The reviewer's diff was
# `git diff HEAD~5 HEAD -- <declared files>`: the declared list filtered the out-of-scope edit
# out of the review, and HEAD~5 was a guess at what the story had committed. Scope was a
# convention one tool enforced and bash bypassed; nobody judged it.
#
# Facts only: the commit from story-changes.jsonl (record_story_changes), ownership from the
# PRD. The words come from the template layer (review-scope-block). The reviewer decides.

# _story_commit_sha <story_id> — the story's latest recorded commit, or nothing.
_story_commit_sha() {
    local _id="${1:-}" _f="${LOG_DIR:-}/story-changes.jsonl"
    [ -n "$_id" ] && [ -f "$_f" ] || return 0
    jq -r --arg id "$_id" 'select(.storyId == $id) | .sha // empty' "$_f" 2>/dev/null | tail -1
}

# story_review_diff <story_id> — the diff of the story's own commit (all files). Falls back to
# recent history when the story has no record, as the review did before.
story_review_diff() {
    local _id="${1:-}" _sha
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    _sha=$(_story_commit_sha "$_id")
    if [ -n "$_sha" ] && git -C "$PROJECT_ROOT" rev-parse --verify "${_sha}^{commit}" >/dev/null 2>&1; then
        git -C "$PROJECT_ROOT" diff "${_sha}^" "$_sha" 2>/dev/null \
            || git -C "$PROJECT_ROOT" show --pretty=format: "$_sha" 2>/dev/null
        return 0
    fi
    git -C "$PROJECT_ROOT" diff HEAD~3 HEAD 2>/dev/null || git -C "$PROJECT_ROOT" show --pretty=format: HEAD 2>/dev/null
}

# story_changed_files <story_id> — the files the story's commit touched.
story_changed_files() {
    local _id="${1:-}" _sha
    [ -e "${PROJECT_ROOT:-}/.git" ] || return 0
    _sha=$(_story_commit_sha "$_id")
    if [ -n "$_sha" ] && git -C "$PROJECT_ROOT" rev-parse --verify "${_sha}^{commit}" >/dev/null 2>&1; then
        git -C "$PROJECT_ROOT" diff --name-only "${_sha}^" "$_sha" 2>/dev/null \
            || git -C "$PROJECT_ROOT" show --pretty=format: --name-only "$_sha" 2>/dev/null
        return 0
    fi
    git -C "$PROJECT_ROOT" diff --name-only HEAD~3 HEAD 2>/dev/null
}

# story_scope_block <story_id> — the review-scope-block fragment listing each changed file the
# story does not declare, with the story that does; empty when there is none.
story_scope_block() {
    local _id="${1:-}" _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -n "$_id" ] && [ -f "$_prd" ] || return 0
    local _lines="" _f _owner
    while IFS= read -r _f; do
        [ -n "$_f" ] || continue
        if jq -e --arg id "$_id" --arg f "$_f" '.stories[] | select(.id == $id) | (.technicalNotes.files // []) | map(. == $f or endswith("/" + $f) or ($f | endswith("/" + .))) | any' "$_prd" >/dev/null 2>&1; then
            continue
        fi
        _owner=$(jq -r --arg id "$_id" --arg f "$_f" '[.stories[] | select(.id != $id and .status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f) or ($f | endswith("/" + .))) | any) | .id] | unique | join(", ")' "$_prd" 2>/dev/null)
        _lines="${_lines}- ${_f} — declared by ${_owner:-no story}
"
    done < <(story_changed_files "$_id")
    [ -n "$_lines" ] || return 0
    local _vals; _vals=$(mktemp "${TMPDIR:-/tmp}/review-scope-vals-XXXXXX.json")
    jq -n --arg files "$_lines" '{"__OUT_OF_SCOPE_FILES__": $files}' > "$_vals"
    local _lib_dir; _lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! command -v render_engine_prompt >/dev/null 2>&1; then
        # shellcheck source=render-engine-prompt.sh
        . "$_lib_dir/render-engine-prompt.sh"
    fi
    render_engine_prompt review-scope-block "$_vals"
    rm -f "$_vals"
}

# review_stands <story_id> <phase_id> — true when the story's latest review in this phase approved
# it, completely, AFTER its latest commit: the reviewer judged exactly the code that is there, and
# there is nothing new to judge. regintel 20260926T125158Z: every round re-reviewed every story in
# the phase (63 reviews in three rounds for ~21 stories, ~$8), and re-reading approved, unchanged
# code produced fresh minor findings on stories approved rounds earlier — the issue count went
# 26 → 13 → 19. Facts only: the commit time from story-changes.jsonl (record_story_changes), the
# verdict and its time from the review log. No record of either means "review it".
review_stands() {
    local _id="${1:-}" _phase="${2:-}" _changes="${LOG_DIR:-}/story-changes.jsonl" _log="${REVIEW_LOG:-}"
    [ -n "$_id" ] && [ -f "$_changes" ] && [ -f "$_log" ] || return 1
    local _committed _review _verdict _incomplete _reviewed
    _committed=$(jq -r --arg id "$_id" 'select(.storyId == $id) | .committedAt // empty' "$_changes" 2>/dev/null | tail -1)
    _review=$(jq -c --arg id "$_id" --arg ph "$_phase" 'select(.story == $id and (($ph == "") or (.phase_id == $ph)))' "$_log" 2>/dev/null | tail -1)
    [ -n "$_committed" ] && [ -n "$_review" ] || return 1
    _verdict=$(printf '%s' "$_review" | jq -r '.verdict // empty')
    _incomplete=$(printf '%s' "$_review" | jq -r '.reviewIncomplete // false')
    _reviewed=$(printf '%s' "$_review" | jq -r '.timestamp // empty')
    [ "$_verdict" = "approved" ] && [ "$_incomplete" = "false" ] && [ -n "$_reviewed" ] || return 1
    local _c _r
    _c=$(date -d "$_committed" +%s 2>/dev/null) && _r=$(date -d "$_reviewed" +%s 2>/dev/null) || return 1
    [ "$_r" -gt "$_c" ]
}
