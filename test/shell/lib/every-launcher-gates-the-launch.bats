#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A LAUNCHER THAT DOES NOT GATE IS A RUN STARTED ON THE PREVIOUS RUN'S STATE.
#
# This is a SCANNER, not a list. It discovers what a launcher is from the tree — any
# top-level script that starts a run — and asserts the requirement against every one it
# finds, including ones added after this test was written. A hand-maintained list would
# pass forever while the ninth launcher shipped ungated, which is the exact shape of the
# earlier "pre-flight gates 2 of 8 launchers" defect.
#
# The requirement: a script that starts a run must either run the pre-run reset gate
# itself, or delegate to a script that does. `--reset` is NOT that gate — it flips PRD
# story flags and clears checkpoints, and touches none of retry state, ladder position,
# agent KB or review feedback, and has no contamination check at all.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    GATE_FN=pre_run_reset_or_abort
    # The engine and the delegating launcher are discovered, not named by hand.
    ENGINE=run-agent-orchestration.sh
    FRONT=orchestrate.sh
}

# ONE definition of "this line starts a run", used by both the discovery and the ordering
# check. The first draft matched any mention, and counted a usage string and a
# `--runner "run-agent-orchestration.sh"` ARGUMENT as launches. The invocation is the
# script name preceded by bash or exec — nothing else runs it.
run_line() {
    grep -nE "(^|[[:space:]])(bash|exec)[[:space:]]+[^[:space:]]*(${ENGINE}|${FRONT})" "$1" 2>/dev/null \
        | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}

starts_a_run() { [ -n "$(run_line "$1")" ]; }

gates_itself()   { grep -qE "^[[:space:]]*${GATE_FN}\b" "$1"; }
# EXEMPTION IS DECLARED BY THE SCRIPT, NOT LISTED HERE. A list inside the test would let
# this file quietly grow an excuse for each new ungated launcher. The script must state
# its own reason, in its own header, where a reader of that script will see it.
exempt()         { grep -qE '^# PRE_RUN_RESET_GATE: exempt' "$1"; }
delegates()      { grep -qE "[^#]*${FRONT}" "$1" && ! grep -qE "[^#]*${ENGINE}" "$1"; }

launchers() {
    for f in "$SCRIPTS"/*.sh; do
        [ "$(basename "$f")" = "$ENGINE" ] && continue   # the engine is not its own launcher
        starts_a_run "$f" && echo "$f"
    done
}

@test "the discovery is not vacuous — it finds launchers, and finds the known ones" {
    n=$(launchers | wc -l)
    [ "$n" -ge 5 ]
    run bash -c "$(declare -f launchers starts_a_run run_line); SCRIPTS='$SCRIPTS' ENGINE=$ENGINE FRONT=$FRONT launchers"
    [[ "$output" == *"$FRONT"* ]]
}

@test "the gate function exists and is the single point of maintenance" {
    hits=$(grep -rlE "^${GATE_FN}\(\)" "$SCRIPTS"/lib/*.sh | wc -l)
    [ "$hits" -eq 1 ]
}

@test "EVERY script that starts a run reaches the pre-run reset gate" {
    ungated=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        exempt "$f" && continue
        gates_itself "$f" && continue
        delegates "$f" && continue
        ungated="${ungated}
  $(basename "$f")"
    done < <(launchers)
    [ -z "$ungated" ] || {
        echo "these launchers start a run with NO contamination gate:$ungated"
        echo "a run started this way inherits the previous run's retry counts, ladder position and agent KB."
        false
    }
}

@test "every exemption states a reason — none is a bare opt-out" {
    # SKIP LOUDLY. An exemption with no reason is a list in disguise.
    checked=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        exempt "$f" || continue
        checked=$((checked+1))
        reason=$(grep -E '^# PRE_RUN_RESET_GATE: exempt' "$f" | sed 's/.*exempt//')
        echo "EXEMPT: $(basename "$f") --$reason"
        [ "${#reason}" -ge 20 ] || { echo "no reason given"; false; }
    done < <(launchers)
    [ "$checked" -ge 1 ]
}

@test "no launcher swallows the gate's refusal" {
    bad=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        grep -nE "^[[:space:]]*${GATE_FN}\b.*(\|\||&&)" "$f" >/dev/null 2>&1 && bad="${bad} $(basename "$f")"
    done < <(launchers)
    [ -z "$bad" ] || { echo "gate call is conditionalised in:$bad"; false; }
}

@test "--reset is not mistaken for the gate: it clears no cross-run state" {
    # Guards against someone 'satisfying' the scanner by passing --reset. Read the engine's
    # own handler: it rewrites PRD story flags and clears checkpoints, nothing else.
    run bash -c "sed -n '/^if \[ \"\${RESET_STORIES:-false}\" = \"true\" \]/,/^fi\$/p' '$SCRIPTS/$ENGINE'"
    [ -n "$output" ]
    [[ "$output" != *"$GATE_FN"* ]]
    [[ "$output" != *CONTAMINATION* ]]
}

# ── The gate must be WIRED, not merely PRESENT ───────────────────────────────
# A grep for the call passes on a line placed after the run has already started, or on a
# call handed an empty PRD_FILE. Both leave the launcher exactly as ungated as before.

line_of() { grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1; }

@test "the gate runs BEFORE the run starts, in every launcher" {
    bad=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        exempt "$f" && continue
        gates_itself "$f" || continue
        g=$(line_of "$f" "^[[:space:]]*${GATE_FN}\\b")
        r=$(run_line "$f")
        [ -n "$g" ] && [ -n "$r" ] && [ "$g" -lt "$r" ] || bad="${bad} $(basename "$f")(gate=$g run=$r)"
    done < <(launchers)
    [ -z "$bad" ] || { echo "gate called at or after the launch:$bad"; false; }
}

@test "the gate is handed a PRD that has already been assigned" {
    # pre_run_reset_or_abort --prd "" resets nothing and still returns 0. An assignment
    # ordering slip is silent, which is the whole failure family this suite exists for.
    bad=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        exempt "$f" && continue
        gates_itself "$f" || continue
        g=$(line_of "$f" "^[[:space:]]*${GATE_FN}\\b")
        for v in PRD_FILE SCRIPT_DIR; do
            a=$(line_of "$f" "^[[:space:]]*(export )?${v}=")
            [ -n "$a" ] && [ "$a" -lt "$g" ] || bad="${bad} $(basename "$f"):$v"
        done
    done < <(launchers)
    [ -z "$bad" ] || { echo "used before assignment:$bad"; false; }
}

@test "EXECUTED: every launcher's own gate lines abort when the reset does not finish" {
    # Not a grep. The real sourcing + call lines are lifted out of each launcher and RUN,
    # against a stub reset that exits 0 without the sentinel. Every one must abort.
    WORK="$(mktemp -d)"
    stub="$WORK/reset.sh"
    printf '#!/usr/bin/env bash\necho "did almost nothing"\nexit 0\n' > "$stub"
    chmod +x "$stub"
    # The launchers source the lib relative to their OWN location, several via
    # `dirname "$(readlink -f "${BASH_SOURCE[0]}")"`. The probe is given a lib/ that
    # resolves the same way, so each launcher's real sourcing line executes unmodified
    # rather than being rewritten into something this test invented.
    ln -s "$SCRIPTS/lib" "$WORK/lib"
    checked=0
    bad=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        exempt "$f" && continue
        gates_itself "$f" || continue
        checked=$((checked+1))
        {
            echo "SCRIPT_DIR='$SCRIPTS'"
            echo "PRD_FILE=/dev/null"
            grep -E "^[[:space:]]*\\. .*pre-run-reset-gate\\.sh" "$f"
            grep -E "^[[:space:]]*${GATE_FN}\\b" "$f"
            echo 'echo RUN_WOULD_START'
        } > "$WORK/probe.sh"
        out=$(PRE_RUN_RESET_SCRIPT="$stub" bash "$WORK/probe.sh" 2>&1 || true)
        case "$out" in *RUN_WOULD_START*) bad="${bad} $(basename "$f")";; esac
    done < <(launchers)
    rm -rf "$WORK"
    [ "$checked" -ge 10 ]          # vacuous-pass guard: probes really ran
    [ -z "$bad" ] || { echo "these launchers continued past a failed reset:$bad"; false; }
}
