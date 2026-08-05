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
# Was a two-entry regex ('^(\.codegraph/|\.epam/)') that missed orchestrations/,
# .deepeval/ and .contracts/ — which is how orchestrations/agents/KB.md was recorded as
# upexpress's writer output on run 20260804T225443Z. One shared definition now.
# shellcheck source=engine-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/engine-paths.sh"

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

    # THE BASELINE SHA IS THE LANE'S IDENTITY. It resolves only in that lane's own repo
    # (verified against all three live metrolinx lanes), so requiring it makes git's object
    # database the identity oracle — no path comparison, no configuration.
    #
    # The `origin/${JIRA_BASELINE_BRANCH:-develop}` fallback this replaces is the silent
    # wrong-scope shape this file's own header complains about: any repo that happens to
    # have that ref satisfies it, including the engine's own.
    local _ref
    _ref=$(story_outputs_baseline_ref "$log_dir") || return 0
    [ -n "$_ref" ] || return 0
    git -C "$project_root" rev-parse --verify --quiet "${_ref}^{commit}" >/dev/null 2>&1 || return 0

    local _manifest="$log_dir/story-outputs-${PHASE:-core}.txt"
    # --diff-filter=ACMRT: Added/Copied/Modified/Renamed/Typechanged. DELETED paths are
    # excluded deliberately — a path handed to a reviewer as "writer output" must exist, or
    # story_outputs_tests nominates a test that cannot run. Deletions are reported
    # separately by story_outputs_deleted, because a writer removing 10 tests is exactly
    # what a gate needs to see and the old manifest lost it entirely.
    local _produced
    _produced=$( { git -C "$project_root" diff --name-only --diff-filter=ACMRT "$_ref" 2>/dev/null
                   git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null; } | \
                 engine_paths_filter | grep -v '^$' | sort -u )

    # OVERWRITE, never union. The previous form was
    #   { cat "$_manifest"; printf '%s' "$_produced"; } | sort -u
    # which can only ever grow: a file the writer reverted, or one recorded when a wrong
    # root was passed, stayed listed forever with no provenance to say when it entered.
    # The union was also unnecessary — the diff is against the PHASE BASELINE, so work a
    # LATE producer committed (the repro-test-writer commits its spec after the story loop)
    # is already included by recomputing.
    #
    # Written even when empty: with a valid baseline, "nothing was produced" is a FACT and
    # the manifest should say so. ABSENT still means "no baseline — fall back and say so".
    printf '%s\n' "$_produced" | grep -v '^$' > "${_manifest}.tmp" 2>/dev/null || true
    mv "${_manifest}.tmp" "$_manifest" 2>/dev/null || rm -f "${_manifest}.tmp"
    return 0
}

# story_outputs_baseline_ref <log_dir> — the phase baseline SHA, or non-zero if unknown.
story_outputs_baseline_ref() {
    local _log_dir="$1"
    [ -f "$_log_dir/phase-baseline-sha.txt" ] || return 1
    local _sha
    _sha=$(tr -d '[:space:]' < "$_log_dir/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_sha" ] || return 1
    printf '%s' "$_sha"
}

# story_outputs_deleted <project_root> <log_dir> — paths this phase REMOVED.
#
# The reviewer on run 20260804T225443Z reported the writer had deleted a 179-line test file
# containing 10 tests, with no replacement. No manifest showed it: the producer recorded
# deletions as though they were outputs, and every consumer then filtered them out as
# missing files. Test count going DOWN is a gate-relevant fact and now has a channel.
story_outputs_deleted() {
    local project_root="$1"
    local log_dir="$2"
    [ -n "$project_root" ] && [ -d "$project_root/.git" ] || return 0
    local _ref
    _ref=$(story_outputs_baseline_ref "$log_dir") || return 0
    git -C "$project_root" rev-parse --verify --quiet "${_ref}^{commit}" >/dev/null 2>&1 || return 0
    git -C "$project_root" diff --name-only --diff-filter=D "$_ref" 2>/dev/null | \
        engine_paths_filter | grep -v '^$' | sort -u
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
    # -f, not -s: an EMPTY manifest is a real answer ("the writers produced nothing"),
    # distinct from an ABSENT one ("no baseline — fall back and say so").
    if [ -f "$manifest" ]; then
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
        raw=$( { git -C "$project_root" diff --name-only --diff-filter=ACMRT "$baseline" 2>/dev/null
                 git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null; } )
    fi

    printf '%s\n' "$raw" | grep -v '^$' | engine_paths_filter | sort -u
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
