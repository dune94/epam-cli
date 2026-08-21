#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# "CAN'T TELL" MUST NOT LOOK LIKE "ALL COVERED".
#
# brownfield-coverage-gate.sh decides whether a brownfield change warrants a NEW test.
# It has three outcomes, and two of them are the same on stdout:
#
#   some files uncovered  -> exit 0, those files printed
#   every file covered    -> exit 0, NOTHING printed
#   CodeGraph unindexed   -> exit 3, NOTHING printed
#
# So the exit code is the ONLY thing separating "write no test, everything is covered"
# from "I could not determine coverage at all". A caller that reads stdout and ignores
# the status silently converts an unusable gate into a confident all-clear — the same
# absence-read-as-success family as the tee'd gates and the ladder that never resolved.
#
# 61 lines, live on every brownfield story, and no test had ever executed it.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    GATE_SRC="$SCRIPTS/brownfield-coverage-gate.sh"
    export NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN=node

    WORK="$(mktemp -d)"
    mkdir -p "$WORK/lib"
    # The REAL gate script, run against a stubbed CodeGraph library. The script resolves
    # its library from its own location, so copying it beside a stub exercises every line
    # of the real thing without needing an indexed repo.
    cp "$GATE_SRC" "$WORK/gate.sh"
    export PROJECT_ROOT="$WORK"
}
teardown() { rm -rf "$WORK"; }

# stub_result <js-expression returned by uncoveredChangedFiles>
stub_result() {
    cat > "$WORK/lib/codegraph-context.js" <<JS
module.exports.uncoveredChangedFiles = function (files, repo) { return $1; };
JS
}

@test "the fixture is real — the copied gate is the shipped gate" {
    [ -s "$WORK/gate.sh" ]
    run bash -c "cmp -s '$GATE_SRC' '$WORK/gate.sh' && echo IDENTICAL"
    [[ "$output" == IDENTICAL ]]
}

@test "an uncovered file is reported, and only that file" {
    stub_result '["src/a.ts"]'
    run bash "$WORK/gate.sh" src/a.ts src/b.ts
    [ "$status" -eq 0 ]
    [[ "$output" == "src/a.ts" ]]
}

@test "every file covered prints NOTHING and exits 0 — write no new test" {
    stub_result '[]'
    run bash "$WORK/gate.sh" src/a.ts
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "THE CONTRACT: an unindexed repo exits 3, not 0" {
    # null means the library could not answer. If this ever became exit 0 the caller would
    # read the empty stdout as "everything is covered" and ship no test for a change that
    # has none.
    stub_result 'null'
    run bash "$WORK/gate.sh" src/a.ts
    [ "$status" -eq 3 ]
}

@test "and exit 3 is INDISTINGUISHABLE from all-covered on STDOUT — the status is all there is" {
    # Proves WHY the status must be read. The gate does explain itself on stderr, but the
    # engine's call site is `... 2>/dev/null`, so stdout is everything the caller sees —
    # and on stdout the two outcomes are byte-identical.
    stub_result 'null'
    run bash -c "bash '$WORK/gate.sh' src/a.ts 2>/dev/null"
    unindexed_out="$output"
    stub_result '[]'
    run bash -c "bash '$WORK/gate.sh' src/a.ts 2>/dev/null"
    [ "$unindexed_out" = "$output" ]
    [ -z "$output" ]
}

@test "the gate does say WHY on stderr, so an operator reading a log is not left guessing" {
    stub_result 'null'
    run bash -c "bash '$WORK/gate.sh' src/a.ts 2>&1 >/dev/null"
    [[ "$output" == *"cannot determine coverage"* ]]
}

@test "no arguments is a usage error, not an empty all-clear" {
    stub_result '[]'
    run bash "$WORK/gate.sh"
    [ "$status" -eq 2 ]
}

@test "a library that throws does not exit 0" {
    cat > "$WORK/lib/codegraph-context.js" <<'JS'
module.exports.uncoveredChangedFiles = function () { throw new Error("boom"); };
JS
    run bash "$WORK/gate.sh" src/a.ts
    [ "$status" -ne 0 ]
}

@test "THE RECEIVER: claude.sh distinguishes all three outcomes" {
    # Executes the engine's real call-site lines against a stub gate, once per outcome.
    block=$(sed -n '/local _uncovered _gate_rc=0/,/^            fi$/p' "$SCRIPTS/claude.sh")
    [ -n "$block" ]
    [ "$(printf '%s\n' "$block" | wc -l)" -gt 8 ]   # vacuous-extraction guard

    # The two exit-0 branches BOTH render a prompt section and differ only in WHICH section
    # key they ask for. Without a working renderer they collapse to the empty string and
    # become indistinguishable from the uncertain branch — which is precisely how the first
    # version of this test let a mutation of the caller survive.
    printf 'console.log("RENDERED:" + process.argv[3]);\n' > "$WORK/lib/render-prompt-section.js"
    printf '{}\n' > "$WORK/agent-contract.json"

    for kind in uncertain covered uncovered; do
        case "$kind" in
            uncovered) printf '#!/usr/bin/env bash\necho src/a.ts\nexit 0\n' > "$WORK/stub-gate.sh";;
            covered)   printf '#!/usr/bin/env bash\nexit 0\n'                > "$WORK/stub-gate.sh";;
            uncertain) printf '#!/usr/bin/env bash\nexit 3\n'                > "$WORK/stub-gate.sh";;
        esac
        chmod +x "$WORK/stub-gate.sh"
        {
            echo 'brownfield_test_policy=UNSET'
            echo "SCRIPT_DIR='$WORK'"
            echo "PROJECT_ROOT='$WORK'"
            echo "NODE_BIN='$NODE_BIN'"
            echo '_story_rel_files=(src/a.ts)'
            # The real block. Only the gate's name and the contract's path are redirected;
            # every branch, test and assignment is the engine's own.
            printf '%s\n' "$block" \
              | sed -e 's#brownfield-coverage-gate\.sh#stub-gate.sh#' \
                    -e "s#\"\$SCRIPT_DIR/../config/agent-contract.json\"#'$WORK/agent-contract.json'#" \
                    -e 's/^[[:space:]]*local /LOCALSHIM /'
            echo 'echo "POLICY=[$brownfield_test_policy]"'
        } | sed 's/^LOCALSHIM //' > "$WORK/recv.sh"
        run bash "$WORK/recv.sh"
        case "$kind" in
            uncertain) [[ "$output" == *"POLICY=[]"* ]] ;;
            covered)   [[ "$output" == *"POLICY=[RENDERED:brownfieldTestPolicy.allCovered]"* ]] ;;
            uncovered) [[ "$output" == *"POLICY=[RENDERED:brownfieldTestPolicy.someUncovered]"* ]] ;;
        esac
    done
}
