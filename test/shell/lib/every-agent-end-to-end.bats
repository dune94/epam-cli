#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# EVERY AGENT, EVERY PROPERTY, EXECUTED.
#
# The fleet audit, in the suite that actually gets watched. Each agent is DERIVED from
# agents/invocation-profiles.json — never listed — so agent 38 is covered the day it is
# declared, without this file being edited.
#
# Written because three agents shipped broken in ways their own unit tests could not see:
#
#   - lib/plan-fidelity-gate.sh had 22 green tests and had NEVER executed.
#   - The reviewer could not read its own review log and approved code carrying the `major`
#     findings it had itself raised one cycle earlier.
#   - codeline-discovery exhausted a budget nobody had declared, reported success, and drove
#     a whole run against the wrong codeline.
#
# And because the audit that found those itself missed things: it never checked that a
# prompt renders, and it ran the gateway rather than the thing the pipeline actually calls.
# So every check here goes through the REAL invoke_agent against a stub runner, under a
# ladder loaded by the REAL loader — not env assembled by a test.
#
# Failures are collected across the whole fleet and reported together. A first-fail abort
# tells you one agent is broken; the operator needs to know how many.
# ─────────────────────────────────────────────────────────────────────────────

setup_file() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    export REPO_ROOT
    export FLEET_DIR="$BATS_FILE_TMPDIR/fleet"
    mkdir -p "$FLEET_DIR"

    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    export NODE

    export PROFILES="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    export SETTINGS="$REPO_ROOT/orchestrations/projects/metrolinx/llm-settings.json"

    # The roster, derived.
    "$NODE" -e '
      const p = require(process.argv[1]); const n = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if (v.ladder || v.reasoningEffort || v._what) n.push(k);
          w(v); } } })(p);
      [...new Set(n)].filter(x => x !== "defaults").sort().forEach(x => console.log(x));
    ' "$PROFILES" > "$FLEET_DIR/agents.txt"

    # ONE REAL INVOCATION PER AGENT, cached. invoke_agent is what the pipeline calls; the
    # stub runner records the environment the agent would actually have run with.
    # NAMED VARIABLES ONLY — never `env`. Two reasons, both learned the hard way:
    #   1. ~/.local/bin/env shadows coreutils here and silently swallows the command, so
    #      `env > FILE` writes NOTHING. agent-invoke.sh carries the same warning.
    #   2. A full dump would write EPAM_API_KEY_* into test output.
    {
        echo '#!/usr/bin/env bash'
        echo 'for v in AGENT_INVOKE_ROLE EPAM_SEAM EPAM_MAX_ITERATIONS EPAM_MAX_OUTPUT_TOKENS \'
        echo '         EPAM_REASONING_EFFORT EPAM_TIMEOUT_SECS EPAM_ALLOWED_TOOLS \'
        echo '         EPAM_MODEL EPAM_MODEL_LADDER AI_MODEL AI_PROVIDER; do'
        echo '  printf "%s=%s\\n" "$v" "${!v-}"'
        echo 'done > "$FLEET_ENV_OUT"'
        echo 'exit 0'
    } > "$FLEET_DIR/runner.sh"
    chmod +x "$FLEET_DIR/runner.sh"

    (
        set +u
        # shellcheck source=/dev/null
        . "$REPO_ROOT/orchestrations/scripts/lib/model-ladders.sh"
        export_model_ladders "$SETTINGS" >/dev/null 2>&1
        # shellcheck source=/dev/null
        . "$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh"
        while IFS= read -r a; do
            [ -n "$a" ] || continue
            safe=$(printf '%s' "$a" | tr -c '[:alnum:]\n' '_')
            FLEET_ENV_OUT="$FLEET_DIR/$safe.env" \
              printf 'a prompt' | FLEET_ENV_OUT="$FLEET_DIR/$safe.env" \
              invoke_agent "$a" --runner "$FLEET_DIR/runner.sh" \
              > "$FLEET_DIR/$safe.out" 2> "$FLEET_DIR/$safe.err" || true
        done < "$FLEET_DIR/agents.txt"
    )
}

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    FLEET_DIR="$BATS_FILE_TMPDIR/fleet"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    PROFILES="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
}

agents() { cat "$FLEET_DIR/agents.txt"; }
safe_of() { printf '%s' "$1" | tr -c '[:alnum:]\n' '_'; }

# The value an agent's invocation actually carried, or empty.
env_of() {  # $1 = agent, $2 = variable
    local f="$FLEET_DIR/$(safe_of "$1").env"
    [ -f "$f" ] || return 0
    sed -n "s/^$2=//p" "$f" | head -1
}

# Runs a per-agent predicate over the whole fleet and reports every failure at once.
fleet_check() {  # $1 = description, $2 = predicate reading the agent from $AGENT
    local desc="$1" pred="$2" bad="" checked=0
    while IFS= read -r AGENT; do
        [ -n "$AGENT" ] || continue
        checked=$((checked + 1))
        if ! eval "$pred"; then bad="${bad} $AGENT"; fi
    done < <(agents)
    [ "$checked" -ge 30 ] || { echo "VACUOUS: only $checked agent(s) examined"; return 1; }
    [ -z "$bad" ] || { echo "$desc — failed for ${bad}"; return 1; }
    return 0
}

# ── the fixture itself ───────────────────────────────────────────────────────

@test "the roster is derived and non-trivial" {
    n=$(agents | wc -l)
    [ "$n" -ge 30 ]
    agents | grep -qx 'story-writer'
    agents | grep -qx 'team-lead-review'
}

@test "EVERY agent was really invoked — no agent silently skipped the harness" {
    # Without this the whole file can pass while examining nothing, which is the exact
    # shape of the defects it was written for.
    missing=""
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        # NON-EMPTY, not merely present. The first version checked existence only, and an
        # env-shim that wrote nothing produced 37 empty files that satisfied it.
        [ -s "$FLEET_DIR/$(safe_of "$a").env" ] || missing="$missing $a"
    done < <(agents)
    [ -z "$missing" ] || { echo "invoke_agent produced no environment for:$missing"; \
        for m in $missing; do echo "--- $m"; tail -3 "$FLEET_DIR/$(safe_of "$m").err" 2>/dev/null; done; false; }
}

# ── what every agent must receive at the seam ────────────────────────────────

@test "EVERY agent is dispatched with its own seam identity" {
    fleet_check "seam identity" '[ "$(env_of "$AGENT" AGENT_INVOKE_ROLE)" = "$AGENT" ]'
}

@test "EVERY agent receives an iteration budget, and it is the LADDER's" {
    fleet_check "iteration budget" '
        v=$(env_of "$AGENT" EPAM_MAX_ITERATIONS); [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null'
}

@test "EVERY agent receives an output-token budget" {
    fleet_check "output budget" '
        v=$(env_of "$AGENT" EPAM_MAX_OUTPUT_TOKENS); [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null'
}

@test "EVERY agent receives a reasoning effort" {
    fleet_check "reasoning effort" '[ -n "$(env_of "$AGENT" EPAM_REASONING_EFFORT)" ]'
}

@test "EVERY agent is time-bounded — declared, and ENFORCED by the wrapper" {
    # Not asserted on the runner's env: invoke_agent does not export the timeout, it WRAPS
    # the process with `timeout --signal=TERM --kill-after=30 "$_timeout"`. Asserting the
    # variable reached the child would have been testing a mechanism that does not exist —
    # the bound is real, it is just enforced from outside.
    run "$NODE" -e '
      const p = require(process.argv[1]); const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if ((v.ladder || v.reasoningEffort || v._what) && k !== "defaults"
              && !(Number(v.timeoutSecs) > 0)) bad.push(k);
          w(v); } } })(p);
      process.stdout.write(bad.join(","));' "$PROFILES"
    [ -z "$output" ] || { echo "agents with no timeout: $output"; false; }
    grep -q 'timeout --signal=TERM --kill-after=30 "\$_timeout"' \
        "$REPO_ROOT/orchestrations/scripts/lib/agent-invoke.sh"
}

@test "EVERY agent receives a tool grant" {
    # An agent with no declared tools inherits whatever the run last set — which is how the
    # pre-phase skill assessment ran with the reviewer's read-only grant while its own
    # profile declared write.
    fleet_check "tool grant" '[ -n "$(env_of "$AGENT" EPAM_ALLOWED_TOOLS)" ]'
}

@test "EVERY agent's model comes from its CHAIN, and that chain has a first rung" {
    # invoke_agent deliberately passes no --model unless a caller overrode one: the chain is
    # the source, and the runner takes its first rung. So "no AI_MODEL" is correct here, and
    # what must hold instead is that the chain is present and parses into a real first rung.
    fleet_check "chain first rung" '
        c=$(env_of "$AGENT" EPAM_MODEL_LADDER)
        [ -n "$c" ] || exit 1
        first=${c%%=*}
        [ -n "$first" ] && [ "$first" != "$c" ]'
}

@test "EVERY agent resolves an escalation chain, not just one model" {
    # A seam with a model but no chain cannot climb; the ladder position would mean nothing.
    fleet_check "escalation chain" '
        [ -n "$(env_of "$AGENT" EPAM_MODEL_LADDER)$(env_of "$AGENT" EPAM_MODEL_LADDER_HIGH)" ]'
}

# ── what every agent must declare ────────────────────────────────────────────

@test "EVERY agent documents what it does" {
    run "$NODE" -e '
      const p = require(process.argv[1]); const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if ((v.ladder || v.reasoningEffort || v._what) && k !== "defaults"
              && !String(v._what || "").trim()) bad.push(k);
          w(v); } } })(p);
      process.stdout.write(bad.join(","));' "$PROFILES"
    [ -z "$output" ] || { echo "agents with no _what: $output"; false; }
}

@test "NO agent declares its own iteration budget — the ladder owns that number" {
    run "$NODE" -e '
      const p = require(process.argv[1]); const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if (v.maxIterations !== undefined) bad.push(k);
          w(v); } } })(p);
      process.stdout.write(bad.join(","));' "$PROFILES"
    [ -z "$output" ] || { echo "profiles carrying a per-agent budget: $output"; false; }
}

@test "EVERY agent is named by pipeline code — nothing is declared and unreachable" {
    src=$(grep -rhv '^[[:space:]]*\(#\|//\)' \
            "$REPO_ROOT/orchestrations/scripts"/*.sh \
            "$REPO_ROOT/orchestrations/scripts/lib"/*.sh \
            "$REPO_ROOT/orchestrations/scripts"/*.js \
            "$REPO_ROOT/orchestrations/scripts/lib"/*.js 2>/dev/null)
    bad=""
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        printf '%s' "$src" | grep -qE -- "[\"']${a}([\"']|-)" || bad="$bad $a"
    done < <(agents)
    [ -z "$bad" ] || { echo "declared but never named by code:$bad"; false; }
}

@test "NO agent is marked orphaned" {
    run "$NODE" -e '
      const p = require(process.argv[1]); const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") { if (v._orphaned) bad.push(k); w(v); } } })(p);
      process.stdout.write(bad.join(","));' "$PROFILES"
    [ -z "$output" ] || { echo "profiles marked orphaned: $output"; false; }
}

@test "EVERY agent that declares a template has one that exists" {
    # A profile can be declared, budgeted and reachable and still not run, because its
    # prompt is gone. qa-gate:* profiles point at templates named qa-<n>-sentinel.json
    # rather than by profile key, so a rename here breaks an agent silently.
    run "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const p = require(process.argv[1]); const dir = process.argv[2]; const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if (v.template && !fs.existsSync(path.join(dir, v.template + ".json")))
            bad.push(k + " -> " + v.template);
          w(v); } } })(p);
      process.stdout.write(bad.join(", "));' \
      "$PROFILES" "$REPO_ROOT/orchestrations/prompts/templates"
    [ -z "$output" ] || { echo "agents whose declared template is missing: $output"; false; }
}

# ── the invocation itself ────────────────────────────────────────────────────

@test "NO agent's invocation aborted — every one reached its runner" {
    bad=""
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        e="$FLEET_DIR/$(safe_of "$a").err"
        [ -s "$e" ] && grep -q 'FATAL\|invalid variable name\|command not found' "$e" && bad="$bad $a"
    done < <(agents)
    [ -z "$bad" ] || { echo "invocation aborted for:$bad"; \
        for m in $bad; do echo "--- $m"; head -2 "$FLEET_DIR/$(safe_of "$m").err"; done; false; }
}

@test "EVERY agent's budgets are numbers the runner can use, not empty strings" {
    fleet_check "numeric budgets" '
        for v in EPAM_MAX_ITERATIONS EPAM_MAX_OUTPUT_TOKENS; do
            x=$(env_of "$AGENT" "$v"); case "$x" in ""|*[!0-9]*) false; return;; esac
        done
        true'
}
