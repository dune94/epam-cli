#!/usr/bin/env bash
# WHAT A QA GATE IS SHOWN DECIDES WHAT IT CAN CONCLUDE.
#
# Live 2026-09-09, run 20260908T215555Z — AMSD-1919, a one-line brownfield defect fixed at
# CheckoutForm.tsx:306. Two gates were paid for and neither could reach a verdict about the change:
#
#   qa-gate:runtime-boundary  "CheckoutForm.tsx itself is unmodified (git diff confirms no
#                              changes)."   — false, and stated with confidence
#   qa-gate:mutant-hunter     "truncated to the first 100 of 436 lines and does not include the
#                              case-sensitivity comparison logic around line 306"  — true, and
#                              the reason it could only answer WARN
#
# Two different faults, one shape: the evidence window could not contain the answer.
#
#   1. The diff was built as `git diff "${_rev_base:-HEAD~1}" HEAD`, and `_rev_base=` appears
#      nowhere in the engine. The fallback was not a fallback, it was the only behaviour — and
#      HEAD~1..HEAD is the last commit alone. repro-test-writer always commits AFTER the writer,
#      so on every brownfield defect that window holds the reproducing test and never the fix.
#
#   2. The excerpt was `head -n <window>` — anchored at the top of the file, so a 436-line
#      component whose change sits at line 306 is out of reach at any window size. An earlier fix
#      added a truncation NOTICE, which is why the agent refused honestly rather than guessing;
#      it did not make the agent see.
#
# Both are fixed by deriving, never by declaring a number here: the base is the phase baseline the
# run itself recorded, and every window size stays in config/evidence-windows.json.
#
# Sourced (not executed) — every function prints to stdout and returns non-zero when it cannot
# produce evidence, so a caller can say "no evidence" instead of shipping a misleading window.

# qa_gate_diff <project_root> <log_dir>
#
# The diff a QA gate must judge: everything THIS PHASE changed, from the baseline the phase
# recorded. story_outputs_baseline_ref is the single reader of phase-baseline-sha.txt and already
# serves story_outputs_deleted and story_outputs_files; this is the third consumer, not a second
# way of answering the same question.
#
# ABSENT IS NOT AN EMPTY DIFF. A missing or unusable baseline returns non-zero WITH a sentence
# saying so, because "nothing changed" and "I could not tell what changed" are opposite findings
# and the gate acts on them differently.
qa_gate_diff() {
    local _root="${1:-}" _log="${2:-}"
    if [ -z "$_root" ] || [ -z "$_log" ]; then
        printf '(qa_gate_diff: no project root or log dir given — this gate has no diff to judge)'
        return 1
    fi

    local _base=""
    if command -v story_outputs_baseline_ref >/dev/null 2>&1; then
        _base=$(story_outputs_baseline_ref "$_log" 2>/dev/null) || _base=""
    fi
    if [ -z "$_base" ]; then
        printf '(no phase baseline was recorded for this run — this gate has no diff to judge, and MUST NOT read that as "nothing changed")'
        return 1
    fi

    if ! git -C "$_root" rev-parse --verify --quiet "${_base}^{commit}" >/dev/null 2>&1; then
        printf '(the recorded phase baseline %s is not a commit in this repository — this gate has no diff to judge)' "$_base"
        return 1
    fi

    # A BASELINE THAT IS NOT AN ANCESTOR OF HEAD CANNOT DESCRIBE THIS PHASE.
    #
    # Live 2026-09-09, the second resume of run 20260908T215555Z: the baseline was recorded before
    # ensure_story_branch hard-reset the story branch onto origin/<baseline>, so it named a commit
    # from the PREVIOUS leg that the reset then orphaned. Diffing an orphan is not empty — it is a
    # cross-branch comparison, and it produced 8 insertions and 11 deletions in the reproducing
    # test with no sign of the source fix. runtime-boundary read that and reported the change was
    # "confined to a Jest/RTL spec file" for the second run running.
    #
    # Refused rather than diffed: this whole file exists to keep "nothing changed" apart from
    # "I cannot tell what changed", and a plausible wrong diff is the worse of the two.
    if ! git -C "$_root" merge-base --is-ancestor "$_base" HEAD >/dev/null 2>&1; then
        printf '(the recorded phase baseline %s is not an ancestor of HEAD — it does not describe this phase, so this gate has no diff to judge. A branch reset after the baseline was recorded is the usual cause.)' "$_base"
        return 1
    fi

    # The size is DECLARED, like every other evidence window. A literal here would be the exact
    # thing config/evidence-windows.json exists to stop.
    local _cap
    _cap=$(evidence_window qaGateDiffLines 2>/dev/null) || _cap=""
    if [ -z "$_cap" ]; then
        printf '(the qaGateDiffLines evidence window is not declared — refusing to invent a size)'
        return 1
    fi

    git -C "$_root" diff "$_base" HEAD 2>/dev/null | head -n "$_cap"
}

# qa_gate_excerpt <project_root> <log_dir> <repo_relative_path> <window_name>
#
# The part of a file a gate needs: the region THIS PHASE changed, with the declared window's worth
# of surrounding context — never the first N lines, which is a window on whatever the file happens
# to open with.
#
# A file that fits inside its window is printed whole and says nothing about truncation: claiming
# a cut that did not happen is its own kind of misleading.
qa_gate_excerpt() {
    local _root="${1:-}" _log="${2:-}" _rel="${3:-}" _win_name="${4:-}"
    # CALLERS HOLD BOTH SHAPES. story_outputs_sources yields repo-relative paths and the
    # find-fallback yields absolute ones; a function that accepted only one silently produced
    # "(unreadable)" for the other, which reads exactly like a file that is not there.
    local _abs
    case "$_rel" in
        /*) _abs="$_rel"; _rel="${_rel#"$_root"/}" ;;
        *)  _abs="$_root/$_rel" ;;
    esac
    [ -f "$_abs" ] || { printf '(%s: unreadable)' "$_rel"; return 1; }

    local _window
    _window=$(evidence_window "$_win_name" 2>/dev/null) || _window=""
    if [ -z "$_window" ] || [ "$_window" -le 0 ] 2>/dev/null; then
        printf '(the %s evidence window is not declared — refusing to invent a size)' "$_win_name"
        return 1
    fi

    local _total
    _total=$(wc -l < "$_abs" 2>/dev/null | tr -d '[:space:]')
    [ -n "$_total" ] || _total=0

    printf -- '--- %s' "$_rel"

    # Whole file, no claim of truncation.
    if [ "$_total" -le "$_window" ]; then
        printf -- ' ---\n'
        cat "$_abs"
        return 0
    fi

    # WHERE THE CHANGE IS, asked of git rather than assumed. -U0 so the hunk headers name only
    # lines that actually changed; the surrounding context is this function's to decide.
    local _first="" _last="" _base=""
    if command -v story_outputs_baseline_ref >/dev/null 2>&1; then
        _base=$(story_outputs_baseline_ref "$_log" 2>/dev/null) || _base=""
    fi
    if [ -n "$_base" ] && git -C "$_root" rev-parse --verify --quiet "${_base}^{commit}" >/dev/null 2>&1; then
        local _hdr _start _count
        while IFS= read -r _hdr; do
            # @@ -a,b +c,d @@  — c is the first changed line on the new side, d how many.
            _start=$(printf '%s' "$_hdr" | sed -n 's/^@@ -[0-9,]* +\([0-9]*\).*/\1/p')
            _count=$(printf '%s' "$_hdr" | sed -n 's/^@@ -[0-9,]* +[0-9]*,\([0-9]*\).*/\1/p')
            [ -n "$_start" ] || continue
            [ -n "$_count" ] || _count=1
            [ "$_count" -gt 0 ] 2>/dev/null || _count=1
            local _end=$(( _start + _count - 1 ))
            { [ -z "$_first" ] || [ "$_start" -lt "$_first" ]; } && _first="$_start"
            { [ -z "$_last" ] || [ "$_end" -gt "$_last" ]; } && _last="$_end"
        done < <(git -C "$_root" diff -U0 "$_base" HEAD -- "$_rel" 2>/dev/null | grep '^@@')
    fi

    local _from _to _anchored="around this phase's change"
    if [ -n "$_first" ] && [ -n "$_last" ]; then
        # Centre the window on the changed region.
        local _span=$(( _last - _first + 1 ))
        local _pad=$(( (_window - _span) / 2 ))
        [ "$_pad" -lt 0 ] && _pad=0
        _from=$(( _first - _pad ))
        [ "$_from" -lt 1 ] && _from=1
        _to=$(( _from + _window - 1 ))
        if [ "$_to" -gt "$_total" ]; then
            _to="$_total"
            _from=$(( _to - _window + 1 ))
            [ "$_from" -lt 1 ] && _from=1
        fi
    else
        # NAMED, not silent. Falling back to the head of the file is the old behaviour, and the
        # gate must be told that is what it is looking at.
        _from=1
        _to="$_window"
        [ "$_to" -gt "$_total" ] && _to="$_total"
        _anchored="from the START of the file — this phase's changed lines could not be located"
    fi

    printf -- ' (lines %s-%s of %s, %s) ---\n' "$_from" "$_to" "$_total" "$_anchored"
    sed -n "${_from},${_to}p" "$_abs"
}

# qa_phase_baseline_sha <project_root> [baseline_branch]
#
# THE COMMIT THIS PHASE'S WORK DIVERGED FROM, which is not the same as HEAD.
#
# run-agent-orchestration.sh captured `rev-parse HEAD` before the story loop, and
# ensure_story_branch then hard-reset the story branch onto origin/<baseline> — orphaning the very
# commit just recorded. On a FIRST run the two agree, because HEAD is already the base; on every
# RESUME the recorded baseline is the previous leg's tip and every diff-based gate reads it:
# review-ranger, mutant-hunter, fuzz-weaver, sast-sentinel, runtime-boundary and the tsc/eslint
# baseline gates.
#
# The merge-base gives the same answer before and after the reset, which is what makes it a
# baseline rather than a snapshot of whatever the branch happened to be carrying.
#
# NOTHING IS INVENTED. A base branch that does not resolve falls back to HEAD — the previous
# behaviour exactly — rather than to a guessed ref.
qa_phase_baseline_sha() {
    local _root="${1:-}" _branch="${2:-}"
    [ -n "$_root" ] || return 1

    local _head
    _head=$(git -C "$_root" rev-parse --verify --quiet HEAD 2>/dev/null) || _head=""
    [ -n "$_head" ] || return 1

    if [ -n "$_branch" ]; then
        # origin/<branch> first, as ensure_story_branch resolves it, then the bare name.
        local _ref
        for _ref in "origin/$_branch" "$_branch"; do
            git -C "$_root" rev-parse --verify --quiet "${_ref}^{commit}" >/dev/null 2>&1 || continue
            local _mb
            _mb=$(git -C "$_root" merge-base "$_head" "$_ref" 2>/dev/null) || _mb=""
            if [ -n "$_mb" ]; then
                printf '%s' "$_mb"
                return 0
            fi
        done
    fi

    printf '%s' "$_head"
}
