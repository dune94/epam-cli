#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# SCOPE IS ARITHMETIC AGAINST THE PLAN, NOT AN OPINION.
#
# lib/plan-fidelity-gate.sh exists because of run 20260814T213253Z (metrolinx AMSD-2041):
# the plan named FIVE sites, the implementer changed exactly those five, and the reviewer
# rejected it for modifying "6 files when the prescribed minimal fix requires only 2".
# That "2" appears nowhere in the plan the reviewer was handed. Obeying the plan was the
# thing being rejected, so no attempt could pass; four review cycles later the ladder was
# exhausted, the retry hard-reset the branch, and work that had passed the test suite and
# tsc was destroyed.
#
# WIRING: the library shipped and nothing called it — it was reachable only from a vitest
# file. claude.sh now calls it via _plan_fidelity_gate_for_story, beside the coupled-pair
# gate, so the writer gets a scope finding back as an ordinary verification failure with
# rungs still available. The last tests in this file EXECUTE that call site.
#
# The no-hardcoding requirement is part of the contract, not a side note: the gate must
# name no file, extension, directory or count, so a project on an entirely different
# stack is checked identically. That is asserted here against a stack the pipeline has
# never seen.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    LIB="$REPO_ROOT/orchestrations/scripts/lib/plan-fidelity-gate.sh"
    WORK="$(mktemp -d)"
    PRD="$WORK/prd.json"; CHANGED="$WORK/changed.txt"; MANIFEST="$WORK/dep-check.json"
}
teardown() { rm -rf "$WORK"; }

# prd <story-id> <sites-json-array>
prd() { printf '{"stories":[{"id":"%s","fixSiteAnalysis":%s}]}\n' "$1" "$2" > "$PRD"; }
changed() { printf '%s\n' "$@" > "$CHANGED"; }
check() { run bash -c '. "$1"; plan_fidelity_check "$2" "$3" "$4" "${5:-}"' _ "$LIB" "$PRD" "$1" "$CHANGED" "${2:-}"; }

@test "the fixture is real — the library defines the function" {
    [ -f "$LIB" ]
    run bash -c ". '$LIB'; command -v plan_fidelity_check"
    [ "$status" -eq 0 ]
}

@test "THE AMSD-2041 CASE: changing exactly the prescribed sites is COMPLIANCE, whatever the count" {
    # Five planned, five changed. The gate must not have an opinion about five being a lot.
    prd S-1 '[{"file":"a.ts","changeRequired":true},{"file":"b.ts","changeRequired":true},
              {"file":"c.ts","changeRequired":true},{"file":"d.ts","changeRequired":true},
              {"file":"e.ts","changeRequired":true}]'
    changed a.ts b.ts c.ts d.ts e.ts
    check S-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"OK"* ]]
    [[ "$output" == *"5 site(s) planned"* ]]
}

@test "a file the plan never names is a FAIL, and is named in the output" {
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    changed a.ts sneaky.ts
    check S-1
    [ "$status" -eq 1 ]
    [[ "$output" == *"sneaky.ts"* ]]
    [[ "$output" == *"does not name this file"* ]]
}

@test "a prescribed but EXEMPT site is a FAIL — the plan said leave it alone" {
    prd S-1 '[{"file":"a.ts","changeRequired":true},{"file":"verify-only.ts","changeRequired":false}]'
    changed a.ts verify-only.ts
    check S-1
    [ "$status" -eq 1 ]
    [[ "$output" == *"changeRequired:false"* ]]
}

@test "compliant files are NOT reported alongside a violation" {
    # A gate that lists everything makes the reviewer hunt for the actual finding.
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    changed a.ts sneaky.ts
    check S-1
    [[ "$output" != *"a.ts —"* ]]
    [[ "$output" == *"Every OTHER changed file is prescribed"* ]]
}

@test "an ABSENT prescription is UNCHECKED, never a pass" {
    # A story nobody planned must not look like a story that complied.
    prd S-1 '[]'
    changed anything.ts
    check S-1
    [ "$status" -eq 0 ]
    [[ "$output" == *UNCHECKED* ]]
    [[ "$output" != *"OK — every changed file is prescribed"* ]]
}

@test "a missing PRD or changed-list is UNCHECKED and says which" {
    changed a.ts
    rm -f "$PRD"
    check S-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"no PRD or no changed-file list"* ]]
}

@test "a prescription with no changeRequired anywhere is NOTED, not silently accepted" {
    # Without the flag a mandated edit cannot be told from a verify-only one, so every
    # site reads as mandatory and the implementer is pushed to touch all of them — the
    # live shape. Silence is what let that gap persist unnoticed.
    prd S-1 '[{"file":"a.ts"},{"file":"b.ts"}]'
    changed a.ts
    check S-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"none of the 2 prescribed site(s) carry changeRequired"* ]]
}

@test "the prescription is found under technicalNotes too, not just at story level" {
    printf '{"stories":[{"id":"S-1","technicalNotes":{"fixSiteAnalysis":[{"file":"a.ts","changeRequired":true}]}}]}\n' > "$PRD"
    changed a.ts
    check S-1
    [ "$status" -eq 0 ]
    [[ "$output" == *OK* ]]
}

@test "dependency-managed files are legitimate scope, read from the PROJECT's manifest" {
    # Installing a package the fix needs touches files no site analysis would ever name.
    printf '{"manifestFile":"package.json","coupledFilePairs":[["package.json","package-lock.json"]],
             "dependencySensitiveConfigFiles":["jest.config.js"]}\n' > "$MANIFEST"
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    changed a.ts package.json package-lock.json jest.config.js
    check S-1 "$MANIFEST"
    [ "$status" -eq 0 ]
}

@test "and WITHOUT that manifest the same files ARE out of plan — the manifest does the work" {
    # Proves the previous test passes because the project declared those files, not
    # because the gate happens to know the names package.json and jest.config.js.
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    changed a.ts package.json
    check S-1
    [ "$status" -eq 1 ]
    [[ "$output" == *"package.json"* ]]
}

@test "NO HARDCODING: a stack the pipeline has never seen is checked identically" {
    printf '{"manifestFile":"Cargo.toml","coupledFilePairs":[["Cargo.toml","Cargo.lock"]],
             "dependencySensitiveConfigFiles":["rustfmt.toml"]}\n' > "$MANIFEST"
    prd S-1 '[{"file":"src/lib.rs","changeRequired":true},{"file":"src/net.rs","changeRequired":false}]'
    changed src/lib.rs Cargo.toml Cargo.lock rustfmt.toml
    check S-1 "$MANIFEST"
    [ "$status" -eq 0 ]

    changed src/lib.rs src/net.rs
    check S-1 "$MANIFEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"src/net.rs"* ]]
}

@test "the gate itself names no file, extension, directory or count" {
    # The contract is in the header; this is the assertion that keeps it true. Comments
    # are excluded — the header discusses package.json and jest.config.js by necessity.
    code=$(grep -vE '^[[:space:]]*#' "$LIB")
    [ -n "$code" ]
    # A flag, not `&& false` inside the loop: a non-matching grep on the LAST iteration
    # makes the loop's own status 1, which failed this test whatever the library said.
    named=""
    for banned in 'package.json' 'package-lock' 'jest.config' 'tsconfig' 'node_modules' 'Cargo'; do
        if printf '%s' "$code" | grep -qF -- "$banned"; then named="$named $banned"; fi
    done
    [ -z "$named" ] || { echo "the gate names:$named"; false; }
}

# ── THE CALL SITE ────────────────────────────────────────────────────────────
# Extracted from claude.sh and EXECUTED against a real git repository. Not a grep: a call
# site that exists but never reaches the library is the state this file was written in.

extract_gate() {
    sed -n '/^_plan_fidelity_gate_for_story() {/,/^}$/p' "$REPO_ROOT/orchestrations/scripts/claude.sh"
}

setup_callsite() {
    export PROJECT_ROOT="$WORK/repo" LOG_DIR="$WORK/logs" EPAM_BROWNFIELD=1
    mkdir -p "$LOG_DIR"
    git init -q -b main "$PROJECT_ROOT"
    git -C "$PROJECT_ROOT" config user.email t@t; git -C "$PROJECT_ROOT" config user.name t
    echo x > "$PROJECT_ROOT/base.txt"
    git -C "$PROJECT_ROOT" add -A; git -C "$PROJECT_ROOT" commit -qm base
    git -C "$PROJECT_ROOT" rev-parse HEAD > "$LOG_DIR/phase-baseline-sha.txt"
    export MAIN_PRD_FILE="$PRD"
    export SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"
}

# run_callsite <changed files...> — commits them, then runs the real function.
run_callsite() {
    for f in "$@"; do mkdir -p "$(dirname "$PROJECT_ROOT/$f")"; echo edited > "$PROJECT_ROOT/$f"; done
    git -C "$PROJECT_ROOT" add -A; git -C "$PROJECT_ROOT" commit -qm story
    {
        echo 'log() { echo "LOG: $*"; }'
        echo 'error() { echo "ERROR: $*"; }'
        echo '_resolved_baseline_ref() { echo main; }'
        extract_gate
        echo '_plan_fidelity_gate_for_story S-1 '"$WORK/out.txt"'; echo "GATE_RC=$?"'
        echo 'echo "FAILURE=[${VERIFICATION_FAILURE:-}]"'
    } > "$WORK/callsite.sh"
    run bash "$WORK/callsite.sh"
}

@test "the call site extraction is real — a function body, not an empty match" {
    body=$(extract_gate)
    [ -n "$body" ]
    [ "$(printf '%s\n' "$body" | wc -l)" -gt 20 ]
    [[ "$body" == *"plan_fidelity_check"* ]]
}

@test "EXECUTED: the call site reaches the library and PASSES a compliant change" {
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    setup_callsite
    run_callsite a.ts
    [[ "$output" == *"GATE_RC=0"* ]]
    [[ "$output" == *"every changed file is prescribed"* ]]
}

@test "EXECUTED: the call site BLOCKS a change that went outside the plan" {
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    setup_callsite
    run_callsite a.ts sneaky.ts
    [[ "$output" == *"GATE_RC=1"* ]]
    [[ "$output" == *"sneaky.ts"* ]]
}

@test "and it hands the writer a VERIFICATION_FAILURE naming the offending file" {
    # The finding has to reach the next attempt's prompt. A gate that blocks without
    # saying why produces a retry that changes nothing.
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    setup_callsite
    run_callsite a.ts sneaky.ts
    [[ "$output" != *"FAILURE=[]"* ]]
    [[ "$output" == *"Verification Failure"* ]]
    [[ "$output" == *"changeRequired:false"* ]]
}

@test "a story with no prescription is not blocked by the call site" {
    prd S-1 '[]'
    setup_callsite
    run_callsite anything.ts
    [[ "$output" == *"GATE_RC=0"* ]]
}

@test "the call site is inert outside brownfield" {
    prd S-1 '[{"file":"a.ts","changeRequired":true}]'
    setup_callsite
    EPAM_BROWNFIELD=0 run_callsite a.ts sneaky.ts
    [[ "$output" == *"GATE_RC=0"* ]]
}

@test "the engine really invokes it, in the branch that still owns the ladder rung" {
    # The function existing is not the fix; being called is. It must sit where a failure
    # can be fed back into the retry loop — beside the coupled-pair gate, before the review.
    cd "$REPO_ROOT"
    run grep -n 'if ! _plan_fidelity_gate_for_story' orchestrations/scripts/claude.sh
    [ "$status" -eq 0 ]
    pf=$(grep -n 'if ! _plan_fidelity_gate_for_story' orchestrations/scripts/claude.sh | cut -d: -f1)
    cp=$(grep -n 'if ! _coupled_pair_gate_for_story' orchestrations/scripts/claude.sh | cut -d: -f1)
    [ "$pf" -lt "$cp" ]
    run sed -n "$((pf)),$((pf+7))p" orchestrations/scripts/claude.sh
    [[ "$output" == *"write_story_retry_count"* ]]
}
