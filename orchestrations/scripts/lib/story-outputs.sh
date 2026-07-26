#!/usr/bin/env bash
# story-outputs.sh — one shared answer to "what did this run actually produce?"
#
# Step 20's lint gate was fixed by handing it the writers' output instead of
# letting it rediscover scope by linting the whole tree (see
# lib/eslint-baseline-gate.sh). The reviewers still inferred it, each in its own
# slightly different way — team-lead-review.sh, review-ranger and mutant-hunter
# all reimplemented `git diff --name-only <baseline>..HEAD`. Three copies of one
# idea is how they drift, and they already had:
#
#   * `<baseline>..HEAD` is commit-to-commit, so writer output not yet committed
#     is invisible to review. The repro-test-writer commits separately from the
#     impl agent, so this is a normal state, not an edge case.
#   * All three fell back to `HEAD~1` when the baseline SHA file was missing —
#     silently. That is the review-oracle failure shape: the diff covers an
#     arbitrary previous commit, the reviewers examine nothing this run
#     produced, and the gate reports success.
#
# The producer is record_story_outputs() in claude.sh. This is the reader.
# STORY_OUTPUTS_SOURCE is set to manifest | baseline diff | none so callers can
# report which one they got — a gate that quietly changes how it computes its
# own scope is indistinguishable from one that is broken.

# Paths the pipeline writes into a client repo. Never story output.
_STORY_OUTPUTS_INCIDENTAL_RE='^(\.codegraph/|\.epam/)'

# Test-file conventions. Deliberately broad: mutant-hunter used to look only for
# `*.test.ts` and therefore found nothing on the live metrolinx codeline, whose
# tests are all `.spec.ts` — it reported "(no test files found)" on a run that
# had just written a reproducing spec.
_STORY_OUTPUTS_TEST_RE='(\.|_)(spec|test)\.[A-Za-z0-9]+$|/__tests__/|(^|/)test_[^/]+$'

# story_outputs_record <project_root> <log_dir>
# Appends what this producer just put in the tree to the phase manifest.
#
# Shared because there is more than one producer and they finish at different
# times. Live metrolinx 2026-07-26: only the story loop recorded, at deliverable
# verification — but the repro-test-writer commits its .spec.ts AFTERWARDS, so
# the test never entered the manifest. mutant-hunter, freshly rewired to read
# its tests from that manifest, saw none, every mutant survived, it scored 0 and
# failed the gate — on a run whose test the repro gate had just proven fails on
# baseline and passes with the fix. The gate then ran its remediation pipeline
# against a finding that existed only because of the missing entry.
#
# Additive and idempotent: each producer records its own contribution and the
# list is the union. Writes nothing when there is no baseline to diff against
# (greenfield) — an ABSENT manifest means "fall back and say so", while an EMPTY
# one would assert the writers produced nothing. Never fails the caller.
story_outputs_record() {
    local project_root="$1"
    local log_dir="$2"
    [ -n "$log_dir" ] || return 0
    [ -n "$project_root" ] && [ -d "$project_root/.git" ] || return 0

    local _ref=""
    if [ -f "$log_dir/phase-baseline-sha.txt" ]; then
        _ref=$(tr -d '[:space:]' < "$log_dir/phase-baseline-sha.txt" 2>/dev/null)
    fi
    [ -n "$_ref" ] || _ref="origin/${JIRA_BASELINE_BRANCH:-develop}"
    git -C "$project_root" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    local _manifest="$log_dir/story-outputs-${PHASE:-core}.txt"
    local _produced
    _produced=$( { git -C "$project_root" diff --name-only "$_ref" 2>/dev/null
                   git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null; } | \
                 grep -v -E "$_STORY_OUTPUTS_INCIDENTAL_RE" | sort -u )
    [ -n "$_produced" ] || return 0

    { [ -f "$_manifest" ] && cat "$_manifest"; printf '%s\n' "$_produced"; } 2>/dev/null | \
        grep -v '^$' | sort -u > "${_manifest}.tmp" && mv "${_manifest}.tmp" "$_manifest"
    return 0
}

# story_outputs_files <project_root> <log_dir>
# Prints repo-relative paths, one per line. Sets STORY_OUTPUTS_SOURCE.
story_outputs_files() {
    local project_root="$1"
    local log_dir="$2"
    STORY_OUTPUTS_SOURCE="none"

    [ -n "$project_root" ] && [ -d "$project_root/.git" ] || return 0

    local manifest="$log_dir/story-outputs-${PHASE:-core}.txt"
    local raw=""
    if [ -s "$manifest" ]; then
        STORY_OUTPUTS_SOURCE="manifest"
        raw=$(cat "$manifest" 2>/dev/null)
    else
        local baseline=""
        if [ -f "$log_dir/phase-baseline-sha.txt" ]; then
            baseline=$(tr -d '[:space:]' < "$log_dir/phase-baseline-sha.txt" 2>/dev/null)
        fi
        if [ -z "$baseline" ]; then
            # No manifest and no baseline. Previously every caller substituted
            # HEAD~1 here and reviewed an arbitrary commit. Returning an empty
            # scope lets the caller say "nothing to review" truthfully instead.
            return 0
        fi
        command -v warning >/dev/null 2>&1 && \
            warning "  no writer-output manifest at $manifest — falling back to the baseline diff for scope"
        STORY_OUTPUTS_SOURCE="baseline diff"
        raw=$( { git -C "$project_root" diff --name-only "$baseline" 2>/dev/null
                 git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null; } )
    fi

    printf '%s\n' "$raw" | grep -v '^$' | grep -v -E "$_STORY_OUTPUTS_INCIDENTAL_RE" | sort -u
    return 0
}

# story_outputs_tests <project_root> <log_dir> — test files only
story_outputs_tests() {
    story_outputs_files "$1" "$2" | grep -E "$_STORY_OUTPUTS_TEST_RE" || true
}

# story_outputs_sources <project_root> <log_dir> — everything that is not a test
story_outputs_sources() {
    story_outputs_files "$1" "$2" | grep -v -E "$_STORY_OUTPUTS_TEST_RE" || true
}
