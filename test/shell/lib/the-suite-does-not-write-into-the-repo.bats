#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A TEST SUITE THAT WRITES INTO THE TREE IT TESTS IS A HAZARD OF ITS OWN.
#
# Twice on 2026-08-20 this happened while building the suite:
#
#   - a repro of the failure analyst wrote healing events into orchestrations/agents/kb/
#   - writer-retest.sh tests restored orchestrations/agents/profiles.json and wrote into
#     orchestrations/logs/, leaving the repo modified after a green run
#
# Both were caught by checking `git status` afterwards, not by any test failing. Reverting after
# the fact does not help: a crash mid-suite leaves the tree mutated, and run evidence — the
# calibration corpus every scan is scored against — is exactly what sits in those directories.
#
# This test runs the whole suite and fails if the working tree moved.
# ─────────────────────────────────────────────────────────────────────────────

@test "running the shell suite leaves orchestrations/ untouched" {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    cd "$REPO_ROOT"

    before=$(git status --porcelain -- orchestrations/ | sort)

    # Every suite file EXCEPT this one — recursing into self would not terminate.
    for f in test/shell/steps/*.bats test/shell/lib/*.bats; do
        case "$f" in *the-suite-does-not-write-into-the-repo.bats) continue;; esac
        PATH="/usr/bin:/bin:$PATH" bash "$REPO_ROOT/node_modules/bats/bin/bats" "$f" >/dev/null 2>&1 || true
    done

    after=$(git status --porcelain -- orchestrations/ | sort)
    if [ "$before" != "$after" ]; then
        echo "the suite modified the repository:"
        diff <(echo "$before") <(echo "$after") || true
        false
    fi
}
