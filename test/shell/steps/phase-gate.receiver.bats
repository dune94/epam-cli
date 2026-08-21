#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE PHASE GATE'S VERDICT WAS DISCARDED BY `tee`.
#
# run-agent-orchestration.sh:10687
#
#     gate_result=0
#     SKIP_TESTS=true "$SCRIPT_DIR/check-phase-gate.sh" "$PHASE" 2>&1 | tee "$LOG_DIR/..." || gate_result=$?
#     case $gate_result in 0) success "Phase gate: GO - All criteria passed"
#
# That script has NO `set -e` and NO `pipefail` — it says so itself in three comments — so a
# pipeline's status is the LAST command's, which is `tee`, which is always 0. The gate exits 1 to
# ask for a retry and 2 to escalate, and both were read as GO.
#
# It performs five checks: review status, story completion, deliverables, unit tests, cost variance.
# None of them could stop a phase. Three other call sites in the same file already work around this
# with ${PIPESTATUS[0]}; this one did not.
#
# 327 lines, and no test had ever executed it.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    GATE="$REPO_ROOT/orchestrations/scripts/check-phase-gate.sh"
    WORK="$(mktemp -d)"
    export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
    export COST_LOG="$LOG_DIR/phase-cost.jsonl"
    export GATE_LOG="$LOG_DIR/phase-gates.jsonl"
    export SKIP_TESTS=true
    export PRD_FILE="$WORK/prd.json"
}
teardown() { rm -rf "$WORK"; }

prd() {  # $1 = completed, $2 = reviewStatus
    cat > "$PRD_FILE" <<PRD
{
  "implementationOrder": { "core": ["S-1"] },
  "stories": [{
    "id": "S-1", "title": "a story", "phase": "core",
    "completed": $1, "reviewStatus": "$2",
    "technicalNotes": { "files": [] }
  }]
}
PRD
}

@test "a phase whose story is complete and approved PASSES" {
    prd true approved
    run bash "$GATE" core
    [ "$status" -eq 0 ]
}

@test "an INCOMPLETE story blocks — the gate itself returns non-zero" {
    prd false approved
    run bash "$GATE" core
    [ "$status" -ne 0 ]
}

@test "a story with changes_requested blocks" {
    prd true changes_requested
    run bash "$GATE" core
    [ "$status" -ne 0 ]
}

@test "THE DEFECT: the caller's pipeline discards that verdict" {
    # Exactly the call-site shape, in a shell with the same flags as the engine (none).
    prd false approved
    # The FIXED call-site shape, in a shell with the engine's flags (none).
    cat > "$WORK/caller.sh" <<CALLER
gate_result=0
SKIP_TESTS=true bash "$GATE" core 2>&1 | tee "$LOG_DIR/phase-gate.log"
gate_result=\${PIPESTATUS[0]}
echo "gate_result=\$gate_result"
CALLER
    run bash "$WORK/caller.sh"
    # The gate said block. The caller must not report 0.
    [[ "$output" != *"gate_result=0"* ]]
}

@test "and the engine's own call site recovers the verdict" {
    cd "$REPO_ROOT"
    run grep -A2 'check-phase-gate.sh" "\$PHASE"' orchestrations/scripts/run-agent-orchestration.sh
    [[ "$output" == *"PIPESTATUS"* ]]
}

@test "the hazard is real: `if cmd | tee` reports success for a failing command" {
    cat > "$WORK/h.sh" <<'EOF'
if bash -c 'exit 2' | tee /dev/null; then echo REPORTED_PASS; else echo REPORTED_FAIL; fi
EOF
    run bash "$WORK/h.sh"
    [[ "$output" == *REPORTED_PASS* ]]
}

@test "no gate in a pipefail-less script consumes a piped status without PIPESTATUS" {
    cd "$REPO_ROOT"
    bad=""
    for f in orchestrations/scripts/*.sh; do
        grep -qE '^[[:space:]]*set -o pipefail|^[[:space:]]*set -[a-z]*o[[:space:]]*pipefail' "$f" && continue
        while IFS= read -r line; do
            n=${line%%:*}
            case "$line" in *'| tee'*) ;; *) continue;; esac
            case "$line" in *'#'*'|'*) continue;; esac
            # consumed by an `if` or by `|| var=$?` without a following PIPESTATUS read
            if echo "$line" | grep -qE '^[0-9]+:[[:space:]]*if .*\| *tee'; then
                bad="${bad}
${f}:${n} (if-guarded)"
            elif echo "$line" | grep -qE '\|\| *[A-Za-z_]+=\$\?'; then
                echo "$(sed -n "$((n+1))p" "$f")" | grep -q PIPESTATUS || bad="${bad}
${f}:${n} (|| var=\$?)"
            fi
        done < <(grep -n '| tee' "$f" 2>/dev/null || true)
    done
    [ -z "$bad" ] || { echo "gate verdicts discarded by tee:$bad"; false; }
}
