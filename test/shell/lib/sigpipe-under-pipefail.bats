#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A PIPE INTO `head` KILLS THE SCRIPT WHEN THE PRODUCER IS STILL WRITING.
#
# This killed run 5, 2026-08-20. team-lead-review.sh built the review prompt with
# `printf '%s\n' "$_diff_full" | head -2000`. head takes its lines and exits, the producer gets
# SIGPIPE and dies 141, `pipefail` promotes 141 to the pipeline status, and `set -e` kills the
# script. Silently — SIGPIPE prints nothing. The reviewer produced NO VERDICT eight times without
# ever calling a model, and the run was killed.
#
# The producer is not always the obvious one: in `printf | awk | grep | sort -u | head -5` it is
# SORT that takes the signal, because sort buffers everything and only then writes.
#
# These tests PROVE the hazard by executing it, then hold the pipeline to zero unguarded sites. A
# scanner alone would be a claim; the first two tests are what make the third mean something.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    WORK="$(mktemp -d)"
}
teardown() { rm -rf "$WORK"; }

@test "the hazard is real: printf into head kills a script under set -euo pipefail" {
    cat > "$WORK/a.sh" <<'EOF'
set -euo pipefail
big=$(for i in $(seq 1 20000); do echo "line $i"; done)
out=$(printf '%s\n' "$big" | head -150)
echo SURVIVED
EOF
    run bash "$WORK/a.sh"
    [ "$status" -eq 141 ]
    [[ "$output" != *SURVIVED* ]]
}

@test "and in a longer pipeline it is sort, not printf, that takes the signal" {
    cat > "$WORK/b.sh" <<'EOF'
set -euo pipefail
big=$(for i in $(seq 1 20000); do echo "rule-$i"; done)
out=$(printf '%s\n' "$big" | awk 'NF{print $NF}' | sort -u | head -5)
echo SURVIVED
EOF
    run bash "$WORK/b.sh"
    [ "$status" -eq 141 ]
}

@test "the fix survives: a herestring has no producer to signal" {
    # `{ printf ... || true; } | head` does NOT survive — measured, 141. The brace group still dies
    # on the signal before `||` is ever consulted. `assignment || true` works but masks genuine
    # failures too, which is the wrong trade for a gate. A herestring removes the pipe entirely:
    # no second process, so nothing can receive SIGPIPE.
    cat > "$WORK/c.sh" <<'EOF'
set -euo pipefail
big=$(for i in $(seq 1 20000); do echo "line $i"; done)
out=$(head -150 <<< "$big")
echo SURVIVED
EOF
    run bash "$WORK/c.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *SURVIVED* ]]
}

@test "no pipeline script assigns from an unguarded pipe into head/tail" {
    # The scan is narrow on purpose. A bare `cmd | head` whose status nobody reads is harmless;
    # the kill needs an ASSIGNMENT (so the status propagates), a producer that may still be
    # writing, and `set -e` with `pipefail` in force. Counting every `| head` would report 80
    # sites and mean nothing.
    cd "$REPO_ROOT"
    bad=""
    for f in orchestrations/scripts/*.sh orchestrations/scripts/lib/*.sh; do
        grep -q 'pipefail' "$f" || continue
        grep -q 'set -[a-z]*e' "$f" || continue
        # `head` ONLY. `tail -n +N` and `tail -N` both read to EOF, so they can never close the
        # pipe early and never signal the producer — including them reported four safe sites in
        # claude.sh as hazards. `head` is the one that exits after N lines.
        hits=$(grep -nE '^[^#]*[A-Za-z_][A-Za-z0-9_]*=\$\((printf|echo|cat|awk|grep)[^)]*\$\{?[A-Za-z_][^)]*\|[^)]*\bhead\s+-' "$f" \
                 | grep -vE '\|\|' || true)
        [ -n "$hits" ] && bad="${bad}
${f}:
${hits}"
    done
    [ -z "$bad" ] || { echo "unguarded SIGPIPE sites:$bad"; false; }
}
