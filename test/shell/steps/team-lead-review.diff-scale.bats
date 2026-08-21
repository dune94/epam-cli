#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# team-lead-review.sh — the reviewer must SURVIVE a large change, and must SEE the source in it.
#
# Killed run 5, 2026-08-20. The reviewer produced NO VERDICT eight times and never called a model
# once. Cause, reproduced here: it builds the review prompt by piping the whole diff through
# `head -2000`. `head` takes its lines and exits, `printf` gets SIGPIPE and dies 141, and under
# `set -euo pipefail` that kills the script — silently, because SIGPIPE prints nothing.
#
# The diff was 8,056 lines and began with package-lock.json. git orders alphabetically, so at line
# 2,000 the content was STILL lockfile version bumps. The reviewer's entire window was generated
# noise and none of the source it was asked to judge.
#
# So two requirements, not one: it must not die on a large diff, and what it is shown must be the
# change rather than whatever sorts first.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    REVIEW="$REPO_ROOT/orchestrations/scripts/team-lead-review.sh"
    WORK="$(mktemp -d)"
    export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
    export PROJECT_ROOT="$WORK/codeline"
    mkdir -p "$PROJECT_ROOT/src"

    git -C "$PROJECT_ROOT" init -q
    git -C "$PROJECT_ROOT" config user.email t@t
    git -C "$PROJECT_ROOT" config user.name t
    echo 'export const a = 1;' > "$PROJECT_ROOT/src/a.ts"
    printf '{"name":"fixture","dependencies":{}}\n' > "$PROJECT_ROOT/package.json"
    printf '{"lockfileVersion":3,"packages":{}}\n' > "$PROJECT_ROOT/package-lock.json"
    git -C "$PROJECT_ROOT" add -A && git -C "$PROJECT_ROOT" commit -qm base
    git -C "$PROJECT_ROOT" branch -f develop HEAD

    # THE LIVE SHAPE: a generated lockfile that dwarfs the source change, and sorts before it.
    {
      echo '{"lockfileVersion":3,"packages":{'
      for i in $(seq 1 4000); do echo "  \"node_modules/pkg$i\": { \"version\": \"1.0.$i\" },"; done
      echo '  "node_modules/last": { "version": "1.0.0" } }}'
    } > "$PROJECT_ROOT/package-lock.json"
    echo 'export const a = 2; // the actual change under review' > "$PROJECT_ROOT/src/a.ts"
    git -C "$PROJECT_ROOT" add -A && git -C "$PROJECT_ROOT" commit -qm change

    export PRD_FILE="$WORK/prd.json"
    cat > "$PRD_FILE" <<'PRD'
{
  "implementationOrder": { "core": ["S-1"] },
  "stories": [{
    "id": "S-1", "title": "a story", "status": "completed", "completed": true,
    "agentRole": "impl-agent",
    "technicalNotes": { "files": ["src/a.ts"] },
    "acceptanceCriteria": ["it works"],
    "verificationCriteria": ["the page renders"]
  }]
}
PRD

    # Records the prompt it was handed, so the test can assert on what the reviewer SEES.
    export AI_RUNNER_CMD="$WORK/runner.sh"
    cat > "$AI_RUNNER_CMD" <<RUNNER
#!/usr/bin/env bash
cat > "$WORK/prompt.txt"
echo '{"verdict":"approved","summary":"stub","issues":[]}'
RUNNER
    chmod +x "$AI_RUNNER_CMD"

    # The engine's own project config: prompt templates and policy blocks the reviewer refuses to
    # run without. A harness that omits it tests a script that was never going to start.
    # THE REVIEW BASELINE, the way the pipeline supplies it.
    #
    # Without this _rev_base falls back to origin/<branch> (no remote here) and then to HEAD~5 — a
    # guessed base that does not exist in a small fixture, so `git diff` fails, `|| true` swallows
    # it, and STORY_DIFF comes back EMPTY. Every assertion about the diff then passes while the
    # block under test never ran.
    git -C "$PROJECT_ROOT" rev-parse develop > "$LOG_DIR/phase-baseline-sha.txt"

    export EPAM_PROJECT_CONFIG_DIR="$REPO_ROOT/orchestrations/projects/metrolinx"
    export PHASE=core EPAM_MODEL=test-model ORCH_GATE_MODEL=test-model
    export JIRA_BASELINE_BRANCH=develop
}

teardown() { rm -rf "$WORK"; }

@test "the fixture really is large and lockfile-first" {
    run git -C "$PROJECT_ROOT" diff develop HEAD
    [ "${#output}" -gt 20000 ]
    [[ "$output" == "diff --git a/package-lock.json"* ]]
}

@test "REPRODUCES run 5: a large diff does not kill the reviewer" {
    run bash "$REVIEW" core
    [ "$status" -ne 141 ]
    [[ "$output" == *"Invoking review-agent"* ]]
}

@test "the reviewer is shown the SOURCE change, not 2000 lines of lockfile" {
    run bash "$REVIEW" core
    [ -f "$WORK/prompt.txt" ]
    grep -q 'src/a.ts' "$WORK/prompt.txt"
}

@test "and the generated lockfile is not inlined into the prompt" {
    run bash "$REVIEW" core
    [ -f "$WORK/prompt.txt" ]
    run grep -c 'node_modules/pkg' "$WORK/prompt.txt"
    [ "${output:-0}" -lt 50 ]
}

@test "the lockfile is not even NAMED in the summary — it is not review material" {
    # THE PREVIOUS TEST PASSED WITHOUT THE EXCLUSION. Removing it merely made the diff large enough
    # to take the summary path, which inlines nothing — so "no lockfile content" was true for the
    # wrong reason. The exclusion is what this asserts: a generated file is gated by lockfile-sync
    # and has no place in what a reviewer is asked to judge.
    run bash "$REVIEW" core
    [ -f "$WORK/prompt.txt" ]
    run grep -c 'package-lock.json' "$WORK/prompt.txt"
    [ "${output:-0}" -eq 0 ]
}

@test "a large SOURCE change does not kill it either — the size branch is really exercised" {
    # WITHOUT THIS THE SUITE IS VACUOUS. Excluding the lockfile makes the fixture diff small, so the
    # size branch never runs — a mutation restoring `head -2000` passed all four tests above. The
    # SIGPIPE that killed run 5 lives in that branch, so it must be entered by a change that is
    # genuinely large after the exclusions.
    for i in $(seq 1 5000); do echo "export const v$i = $i;" >> "$PROJECT_ROOT/src/big.ts"; done
    git -C "$PROJECT_ROOT" add -A && git -C "$PROJECT_ROOT" commit -qm big

    run bash "$REVIEW" core
    [ "$status" -ne 141 ]
    [[ "$output" == *"Invoking review-agent"* ]]
}

@test "and that large change is summarised, not severed mid-hunk" {
    for i in $(seq 1 5000); do echo "export const v$i = $i;" >> "$PROJECT_ROOT/src/big.ts"; done
    git -C "$PROJECT_ROOT" add -A && git -C "$PROJECT_ROOT" commit -qm big

    run bash "$REVIEW" core
    [ -f "$WORK/prompt.txt" ]
    # A per-file summary naming the files, and an instruction to read them — not a cut-off diff.
    grep -q 'src/big.ts' "$WORK/prompt.txt"
    grep -qi 'NOT inlined\|Read what you need' "$WORK/prompt.txt"
}
