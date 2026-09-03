#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A SEAM DECLARES A LADDER POSITION. NOTHING RESOLVED IT.
#
# agents/invocation-profiles.json documents the design in its own _ladderPositions note:
#
#   "A seam declares a POSITION in the project's ladderTierOrder (base|mid|top), never a tier NAME.
#    The project owns its tier vocabulary."
#
# That is right: metrolinx calls its tiers medium/high/highest, another project may call them
# anything, and the engine must not know either vocabulary.
#
# lib/agent-invoke.sh:219 instead did a NAME lookup:
#
#     _ladder_var="EPAM_MODEL_LADDER_$(printf '%s' "$_ladder" | tr '[:lower:]-' '[:upper:]_')"
#
# so position "top" looked for EPAM_MODEL_LADDER_TOP while the project exports
# EPAM_MODEL_LADDER_HIGHEST. It never matched. Every one of the 38 profiles that declares a ladder
# fell through to the run default, and said so quietly:
#
#   [agent-invoke] role 'team-lead-review' asks for ladder 'top' but EPAM_MODEL_LADDER_TOP is not
#                  set — using the run's default ladder
#
# Visible in the run-5 log, and read as noise. A declared escalation path that resolves to nothing
# means the reviewer, the detective and the analysts all climbed whatever the run happened to
# default to, not the rung their profile asks for.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    # THE LADDERS MOVED OUT OF THE PROJECT. Until the 2026-08-25 migration each project's
    # llm-settings.json carried its own `ladders`; they now live in the active provider set
    # (config/llm-defaults.<set>.json), because a per-model setting belongs to the model and a model
    # belongs to a stack. metrolinx declares none, so `jq .ladders` returned empty here and the
    # vacuity guard failed on an architecture working exactly as intended — unnoticed, because no
    # runner executed .bats files until 2026-08-28.
    #
    # The requirement is unchanged: a POSITION indexes into ladderTierOrder, and the two
    # vocabularies must stay distinct. Only the file that owns the tiers has moved.
    SETTINGS="$REPO_ROOT/orchestrations/config/llm-defaults.$(jq -r '.defaultSet' "$REPO_ROOT/orchestrations/config/provider-sets.json").json"
    REGISTRY="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
}

@test "the two vocabularies really do differ — otherwise this whole file is moot" {
    tiers=$(jq -r '(.ladders // {}) | keys | join(",")' "$SETTINGS")
    positions=$(jq -r '[.profiles[] | .ladder // empty] | unique | join(",")' "$REGISTRY")
    [ -n "$tiers" ]
    [ -n "$positions" ]
    [ "$tiers" != "$positions" ]
}

@test "the project's own export sets tier NAMES, not positions" {
    run bash -c "
        source '$REPO_ROOT/orchestrations/scripts/lib/model-ladders.sh'
        export_model_ladders '$SETTINGS'
        echo \"HIGHEST=\${EPAM_MODEL_LADDER_HIGHEST:-}\"
        echo \"TOP=\${EPAM_MODEL_LADDER_TOP:-}\"
    "
    [[ "$output" == *"HIGHEST="*[a-z]* ]]
    [[ "$output" == *"TOP="$'\n'* || "$output" == *"TOP="  ]]
}

@test "ladderTierOrder is what a position indexes into" {
    order=$(jq -r '.ladderTierOrder | join(",")' "$SETTINGS")
    [ "$order" = "medium,high,highest" ]
}

@test "EVERY position a profile declares resolves to a real chain" {
    # The cross-check nothing performed: registry vocabulary against project vocabulary. A seam
    # asking for a rung the project cannot supply must be a build-time failure, not a run-time
    # shrug 40 minutes into a paid run.
    run bash -c "
        source '$REPO_ROOT/orchestrations/scripts/lib/model-ladders.sh'
        source '$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh'
        export_model_ladders '$SETTINGS'
        export EPAM_MODEL_LADDER_TIER_ORDER=\$(jq -r '.ladderTierOrder | join(\" \")' '$SETTINGS')
        bad=''
        for pos in \$(jq -r '[.profiles[] | .ladder // empty] | unique | .[]' '$REGISTRY'); do
            chain=\$(ladder_chain_for_position \"\$pos\" 2>/dev/null || true)
            [ -z \"\$chain\" ] && bad=\"\$bad \$pos\"
        done
        [ -z \"\$bad\" ] || { echo \"positions that resolve to nothing:\$bad\"; exit 1; }
        echo OK
    "
    [ "$status" -eq 0 ]
}

# ─────────────────────────────────────────────────────────────────────────────
# ONE RULE, ONE PLACE.
#
# The first fix reimplemented position→tier in bash next to the broken lookup. It passed every
# test above and was still wrong: it read `mid` as len/2 where seam-invocation.js reads
# floor((len-1)/2). For metrolinx's three tiers both give index 1, so nothing showed. A project
# declaring four tiers would have had its shell seams and its JS seams climb DIFFERENT rungs, with
# no error anywhere — the two halves of one pipeline silently disagreeing about a model.
#
# So the rule is asserted to live in one place, and the two callers are asserted to agree across
# orders the live project does not happen to declare.
# ─────────────────────────────────────────────────────────────────────────────

# The tier the JS resolver names for a position under a given order.
js_tier() {
    EPAM_MODEL_LADDER_TIER_ORDER="$2" node -e '
      const { resolveTierPosition } = require(process.argv[1]);
      process.stdout.write(resolveTierPosition(process.argv[2], process.env));
    ' "$REPO_ROOT/orchestrations/scripts/lib/seam-invocation.js" "$1"
}

# The tier the SHELL gateway lands on, read back out of the chain it returns.
sh_tier() {
    local pos="$1" order="$2" t
    for t in $order; do
        export "EPAM_MODEL_LADDER_$(printf '%s' "$t" | tr '[:lower:]-' '[:upper:]_')=chain-of-$t"
    done
    export EPAM_MODEL_LADDER_TIER_ORDER="$order"
    source "$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh"
    ladder_chain_for_position "$pos" | sed 's/^chain-of-//'
}

@test "shell and JS resolve every position identically — including orders metrolinx never declares" {
    local checked=0
    for order in "a b c" "a b c d" "a b" "a" "a b c d e"; do
        for pos in base mid top; do
            js=$(js_tier "$pos" "$order")
            sh=$(sh_tier "$pos" "$order")
            [ -n "$js" ] || { echo "JS resolved nothing for $pos under [$order]"; return 1; }
            if [ "$js" != "$sh" ]; then
                echo "DIVERGED at position '$pos' under order [$order]: JS=$js shell=$sh"
                return 1
            fi
            checked=$((checked + 1))
        done
    done
    # Guard against a vacuous pass: if the loops ran zero comparisons every assertion above is
    # unreached and this test proves nothing.
    [ "$checked" -eq 15 ]
}

@test "the rule is stated ONCE — the gateway does not carry its own copy" {
    # An arithmetic index into the tier order inside agent-invoke.sh is a second implementation of
    # resolveTierPosition, which is what drifted the first time.
    body=$(sed -n '/^ladder_chain_for_position()/,/^}/p' \
        "$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh")
    [ -n "$body" ]
    echo "$body" | grep -q 'resolveTierPosition'
    ! echo "$body" | grep -qE '\$\{_order\[|#_order\[@\]|case "\$_pos"'
}

# ─────────────────────────────────────────────────────────────────────────────
# THE RECEIVER: does an agent actually RUN on the rung its profile declares?
#
# Everything above tests resolution. This runs the real invoke_agent against a stub runner and
# reads what the agent was actually handed — the only thing that decides which model bills.
# ─────────────────────────────────────────────────────────────────────────────

# Invoke a role through the real gateway; echo the ladder the runner received.
invoked_ladder() {
    local role="$1" runner="$BATS_TEST_TMPDIR/runner.sh"
    printf '#!/usr/bin/env bash\necho "LADDER=${EPAM_MODEL_LADDER:-}"\n' > "$runner"
    chmod +x "$runner"
    (
        source "$REPO_ROOT/orchestrations/scripts/lib/model-ladders.sh"
        source "$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh"
        export_model_ladders "$SETTINGS"
        printf 'x' | invoke_agent "$role" --runner "$runner" --codeline "$REPO_ROOT" 2>&1
    )
}

@test "a seam declaring 'top' is handed the TOP chain, not the run default" {
    top_tier=$(jq -r '.ladderTierOrder[-1]' "$SETTINGS")
    expected=$(jq -r --arg t "$top_tier" \
        '[.ladders[$t].modelLadder[]? | "\(.from)=\(.to)"] | join("|")' "$SETTINGS")
    [ -n "$expected" ]

    role=$(jq -r 'first(.profiles | to_entries[] | select(.value.ladder == "top") | .key)' "$REGISTRY")
    [ -n "$role" ] && [ "$role" != "null" ]

    out=$(invoked_ladder "$role")
    echo "$out" | grep -q "LADDER=$expected"
    # And the warning that flagged this defect for five runs is gone.
    ! echo "$out" | grep -q 'is not set'
}

@test "and a seam declaring 'base' is handed a DIFFERENT chain — otherwise position means nothing" {
    base_tier=$(jq -r '.ladderTierOrder[0]' "$SETTINGS")
    top_tier=$(jq -r '.ladderTierOrder[-1]' "$SETTINGS")
    chain_for() {
        jq -r --arg t "$1" '[.ladders[$t].modelLadder[]? | "\(.from)=\(.to)"] | join("|")' "$SETTINGS"
    }
    # The project must actually distinguish its rungs, or this test cannot detect anything.
    [ "$(chain_for "$base_tier")" != "$(chain_for "$top_tier")" ]

    role=$(jq -r 'first(.profiles | to_entries[] | select(.value.ladder == "base") | .key)' "$REGISTRY")
    if [ -z "$role" ] || [ "$role" = "null" ]; then skip "no profile declares position 'base'"; fi

    echo "$(invoked_ladder "$role")" | grep -q "LADDER=$(chain_for "$base_tier")"
}
