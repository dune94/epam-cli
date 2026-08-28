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

# story_outputs_tests_for <project_root> <log_dir> <story_id> — THIS story's test files.
#
# story_outputs_tests reads the PHASE manifest, which carries no story attribution at all. So a
# caller looping over stories and taking `| head -1` gave every story in the phase the SAME test
# file — the first one written by anybody. Step 3.56 did exactly that, and reported story B's
# verification-criteria coverage against story A's test: a check that ran, produced a plausible
# artefact, and measured the wrong thing.
#
# The story's own commit is the attribution that does exist. commit_completed_story writes
# "<story_id>: story complete (N file(s))" and keeps that marker stable precisely so it can be
# grepped — reset-to-baseline.sh already keys off it.
#
# Prints nothing when the story has no commit. That is a real answer: no commit means no files,
# which the caller must report as "not checked", never as "covered".
story_outputs_tests_for() {
    local project_root="$1" story_id="$3"
    [ -n "$project_root" ] && [ -d "$project_root/.git" ] || return 0
    [ -n "$story_id" ] || return 0
    # EVERY COMMIT OF THE STORY, not the one that says "story complete".
    #
    # The writer no longer produces a single commit: the fix and the bug-reproducing test land
    # separately, and the fix's subject is free-form. Measured 2026-08-28 on the first fully green
    # paid run — MOCK3-1's fix was "Fix: correct fare boundary for riders aged exactly 65" with no
    # marker, and MOCK3-2's marker commit carried only its source. Both stories reported "no test
    # file in the writer manifest — coverage NOT checked" while their tests sat on the branch. The
    # gate ran, warned, and measured nothing, on a run reported green.
    #
    # The story-id PREFIX is the attribution the commit convention already requires, and it keeps
    # the property this function exists for: one story never sees another's test.
    #
    # Scoped to the phase baseline where one is recorded, so a previous run's commit for the same
    # story id cannot be mistaken for this run's work.
    local _range=""
    if [ -n "${2:-}" ] && [ -f "$2/phase-baseline-sha.txt" ]; then
        local _base; _base=$(tr -d '[:space:]' < "$2/phase-baseline-sha.txt" 2>/dev/null)
        [ -n "$_base" ] && git -C "$project_root" rev-parse --verify --quiet "$_base" >/dev/null 2>&1 \
            && _range="${_base}..HEAD"
    fi
    git -C "$project_root" log ${_range:+"$_range"} --grep="^${story_id}:" \
        --pretty=format: --name-only 2>/dev/null \
        | grep -E "$_STORY_OUTPUTS_TEST_RE" 2>/dev/null | sort -u || true
}

# story_outputs_sources <project_root> <log_dir> — everything that is not a test
story_outputs_sources() {
    story_outputs_files "$1" "$2" | grep -v -E "$_STORY_OUTPUTS_TEST_RE" || true
}

# ── THE RUNG THAT PRODUCED IT ────────────────────────────────────────────────
#
# Operator, 2026-08-22: "if writer's model moves up ladder, the reviewer must follow along and
# use the same rung EXACT setup the writer used to converge. No hard coding. No guards.
# Persistence."
#
# A RUNG IS NOT A MODEL. The writer's ladder moves model, provider, reasoning effort and
# temperature together — rung 1 sets effort medium / temp 0, rung 2 escalates the model, rung 3
# goes effort high / temp 0.7 — so a reviewer handed only the model still judges converged work
# on a configuration the writer never ran.
#
# WRITTEN ON EVERY ATTEMPT, at the point the rung is settled and before the writer is invoked
# (claude.sh, immediately after the escalation block closes). Deliberately not on a success
# path: the last write is by definition the rung that produced the final output, whatever
# happened on the way there, and a story that ends in rejection still has a real rung.
#
# Why persisted rather than passed in memory: run-agent-orchestration.sh spawns the writer as a
# CHILD PROCESS per story (:2333) and the reviewer as a separate process per cycle (:7909). No
# in-memory value crosses that. The reviewer's own ladder resume already works this way, for
# this same reason.
_story_rung_file() { echo "$1/story-rung/$2.json"; }

# story_rung_record <log_dir> <story_id>
# Captures the CURRENT rung from the writer's own variables. No arguments, on purpose: a
# parameter list is a second definition of what a rung is, and it drifts the first time
# claude.sh adds a knob to the ladder.
story_rung_record() {
    local log_dir="$1" story_id="$2"
    [ -n "$log_dir" ] && [ -n "$story_id" ] || return 0
    mkdir -p "$log_dir/story-rung" 2>/dev/null || true
    jq -n \
        --arg model       "${STORY_MODEL:-}" \
        --arg provider    "${STORY_PROVIDER:-}" \
        --arg effort      "${EPAM_REASONING_EFFORT:-}" \
        --arg temperature "${EPAM_TEMPERATURE:-}" \
        --arg iterations  "${STORY_MAX_ITERATIONS:-}" \
        --arg outTokens   "${STORY_MAX_OUTPUT_TOKENS:-}" \
        '{model:$model, provider:$provider, reasoningEffort:$effort,
          temperature:$temperature, maxIterations:$iterations, maxOutputTokens:$outTokens}' \
        > "$(_story_rung_file "$log_dir" "$story_id")" 2>/dev/null || true
}

# story_rung_get <log_dir> <story_id> <field>
# Empty when the story has no rung on record. ABSENT IS NOT A DEFAULT: a caller that substitutes
# something here makes a judge authoritative about work whose setup it never saw.
story_rung_get() {
    local f; f="$(_story_rung_file "$1" "$2")"
    [ -f "$f" ] || return 0
    jq -r --arg k "$3" '.[$k] // ""' "$f" 2>/dev/null || true
}
