#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE COST LEDGER MUST NAME THE MODEL THAT ACTUALLY RAN.
#
# run_inline_tc_writer_gate invokes with `ORCH_GATE_MODEL="$_tc_model"` and escalates
# _tc_model up the ladder between attempts. It then writes a cost_snapshot naming
# `${TC_WRITER_MODEL:-z-ai/glm-5.2}` — and TC_WRITER_MODEL is set NOWHERE in the repo, so the
# literal always wins. Every TC-writer call on every project is recorded as z-ai/glm-5.2
# whatever it ran on, including after escalation to a different, differently-priced model.
#
# Cost attribution is the operator's stated priority #1, and a ledger keyed on a model name is
# also how a per-model spend total is built — so this is not only a label being wrong.
#
# The literal is the same shape the ladder bug had: a declared value fails to reach the site,
# and a hardcoded name silently stands in for it.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    GATE="$REPO_ROOT/orchestrations/scripts/lib/tc-writer-gate.sh"
    WORK="$(mktemp -d)"
    export LOG_DIR="$WORK"
    export ACTIVITY_FILE="$WORK/agent-activity.jsonl"
    export MONITOR_FILE="$WORK/agent-status.json"
    printf '{"phase":"core"}\n' > "$MONITOR_FILE"
    mkdir -p "$WORK/bin"; printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/update-monitor.sh"
    chmod +x "$WORK/bin/update-monitor.sh"
    export SCRIPT_DIR="$WORK/bin/.."
}
teardown() { rm -rf "$WORK"; }

# Executes the REAL cost-record lines from the gate, with the model the gate would have run.
record_with() {   # $1 = the model actually invoked
    {
        echo "SCRIPT_DIR='$WORK/bin/..'"
        echo "story_id=S-1"
        echo "_tc_model='$1'"
        sed -n '/^    # Emit cost_snapshot naming THE MODEL THAT RAN/,/^        }.*ACTIVITY_FILE/p' "$GATE" \
          | sed -e 's|"\$SCRIPT_DIR/update-monitor.sh"|true|' \
                -e '/^[[:space:]]*local [A-Za-z_][A-Za-z0-9_]*[[:space:]]*$/d' \
                -e 's/^[[:space:]]*local //'
    } > "$WORK/rec.sh"
    bash "$WORK/rec.sh"
}

ledger_model() { jq -r 'select(.type=="cost_snapshot") | .model' "$ACTIVITY_FILE" | tail -1; }

@test "the extraction is real — the gate's own record lines, not a rewrite" {
    block=$(sed -n '/^    # Emit cost_snapshot naming THE MODEL THAT RAN/,/^        }.*ACTIVITY_FILE/p' "$GATE")
    [ -n "$block" ]
    [ "$(printf '%s\n' "$block" | wc -l)" -gt 10 ]
    [[ "$block" == *cost_snapshot* ]]
}

@test "a snapshot is actually written — the harness is not silently doing nothing" {
    record_with 'z-ai/glm-5.2'
    [ -s "$ACTIVITY_FILE" ]
    [ "$(ledger_model)" = "z-ai/glm-5.2" ]
}

@test "THE DEFECT: the model that RAN is what gets recorded" {
    # The gate ran on this model. The ledger must say so.
    record_with 'moonshotai/kimi-k3'
    [ "$(ledger_model)" = "moonshotai/kimi-k3" ]
}

@test "after a ladder escalation the ledger follows the escalation" {
    record_with 'MiniMax-M3'
    [ "$(ledger_model)" = "MiniMax-M3" ]
}

@test "no model name is hardcoded in the record at all" {
    # CODE LINES ONLY. The header above the record deliberately names the literal it
    # replaced, so the next reader knows what was wrong; quoting a defect is not committing it.
    block=$(sed -n '/^    # Emit cost_snapshot naming THE MODEL THAT RAN/,/^        }.*ACTIVITY_FILE/p' "$GATE" \
            | grep -vE '^[[:space:]]*#')
    [ -n "$block" ]
    named=""
    for m in 'z-ai/' 'glm-' 'kimi' 'MiniMax' 'openrouter' 'gpt-'; do
        printf '%s' "$block" | grep -qF -- "$m" && named="$named $m"
    done
    [ -z "$named" ] || { echo "the cost record names:$named"; false; }
}
