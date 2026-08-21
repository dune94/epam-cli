#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A SINGLE ARGV ENTRY IS CAPPED AT 128KB, AND A PROMPT VALUE CROSSES IT ROUTINELY.
#
# MAX_ARG_STRLEN caps ONE argument at 128KB. That is not ARG_MAX (2MB, the whole vector) and it is
# not configurable. lib/jq-vals.sh exists because of it: it moves values through --rawfile written
# by printf, a shell BUILTIN, so nothing large ever becomes an argv entry.
#
# The migration covered jq and missed node. Live run 5, 2026-08-20:
#
#   brownfield-repro-test-writer.sh: line 368: node: Argument list too long
#   FATAL: the repro-test-writer prompt did not render — refusing to invoke a test writer
#          with no instructions
#
# It failed LOUDLY, which is the discipline working -- an agent was not briefed with an empty
# prompt. But the story shipped with no reproducing test, and the cause was a fix diff bigger than
# 128KB handed to `node -e` as a positional argument.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    WORK="$(mktemp -d)"
    NODE_BIN="${NODE_BIN:-node}"
}
teardown() { rm -rf "$WORK"; }

@test "the hazard is real: a 200KB argv entry cannot be passed to node" {
    big=$(head -c 200000 /dev/zero | tr '\0' 'x')
    run "$NODE_BIN" -e 'process.stdout.write(String(process.argv[1].length))' "$big"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Argument list too long"* || "$output" == *"E2BIG"* || "$status" -eq 126 ]]
}

@test "and jq_vals carries the same value without argv" {
    source "$REPO_ROOT/orchestrations/scripts/lib/jq-vals.sh"
    big=$(head -c 200000 /dev/zero | tr '\0' 'x')
    run bash -c "
        source '$REPO_ROOT/orchestrations/scripts/lib/jq-vals.sh'
        big=\$(head -c 200000 /dev/zero | tr '\0' 'x')
        jq_vals --arg diff \"\$big\" '{\"__FIX_DIFF__\":\$diff}' > '$WORK/v.json'
    "
    [ "$status" -eq 0 ]
    [ -s "$WORK/v.json" ]
    run "$NODE_BIN" -e 'const v=require(process.argv[1]);process.stdout.write(String(v.__FIX_DIFF__.length))' "$WORK/v.json"
    [ "$output" -eq 200000 ]
}

@test "no pipeline script passes a shell variable as an argv entry to node -e" {
    # Narrow: `node -e '<program>' <args>` where an argument is a bare "$var" expansion. A literal
    # path or a short flag is fine; it is unbounded CONTENT that breaks. jq_vals is the answer and
    # already exists — this holds the rest of the pipeline to it.
    cd "$REPO_ROOT"
    bad=""
    for f in orchestrations/scripts/*.sh orchestrations/scripts/lib/*.sh; do
        hits=$(awk '
            /node.*-e .$/ || /NODE_BIN.*-e .$/ { inprog=1; start=NR; next }
            inprog && /^.[[:space:]]*$/ { next }
            inprog && /^'"'"'/ { inprog=0;
                # the argv list follows the closing quote on this line and the next few
            }
        ' "$f" 2>/dev/null || true)
        # Simpler and checkable: a continuation line that is only  __NAME__ "$var"
        hits=$(grep -nE '^[[:space:]]+__[A-Z0-9_]+__[[:space:]]+"\$[A-Za-z_]' "$f" || true)
        [ -n "$hits" ] && bad="${bad}
${f}:
${hits}"
    done
    [ -z "$bad" ] || { echo "values passed through argv (use jq_vals):$bad"; false; }
}
