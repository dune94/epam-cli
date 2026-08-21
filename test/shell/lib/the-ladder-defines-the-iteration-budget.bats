#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# AN AGENT IS ASSIGNED TO A LADDER. THE LADDER DEFINES ITS ITERATIONS.
#
# Operator rule, 2026-08-21. The budget belongs to the RUNG, not to the agent: a stronger
# rung is given more room, which is the point of escalating. Live run 20260821T112857Z:
# maxIter 120 -> 185 -> 280 as the ladder climbed.
#
# What was there instead:
#
#   - llm-settings.json modelOverrides declares the budget per model (minimax-m2.5=45,
#     kimi-k2.5=60, minimax-m3=120, glm-5.2=120, kimi-k3=150).
#   - seam-invocation.js:293 set EPAM_MAX_ITERATIONS from `profile.maxIterations` ONLY —
#     it never consulted the ladder. So the ladder's budget reached NO seam.
#   - 22 agents carried a per-agent literal, overriding the ladder 22 times.
#   - 16 carried none and inherited AgentRunner's `?? 20`. That is the mechanism that let
#     codeline-discovery exhaust silently and drive a run against the wrong codeline.
#
# The resolution rule itself (matchOn/matchSubstring) existed only as inline jq inside
# claude.sh's per-attempt STORY path, which is why no seam could reach it.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    LIBDIR="$REPO_ROOT/orchestrations/scripts/lib"
    PROFILES="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"
    SETTINGS="$WORK/llm-settings.json"
    cat > "$SETTINGS" <<'JSON'
{
  "ladderTierOrder": ["medium", "high", "highest"],
  "ladders": {
    "medium":  { "startModel": "Fast-M1",  "modelLadder": [{"from":"Fast-M1","to":"Mid-M2"}] },
    "high":    { "startModel": "Mid-M2",   "modelLadder": [{"from":"Mid-M2","to":"Top-M3"}] },
    "highest": { "startModel": "vendor/Top-M3", "modelLadder": [{"from":"Top-M3","to":"Top-M3"}] }
  },
  "modelOverrides": {
    "fast":  { "matchOn": "model", "matchSubstring": "Fast-M1", "maxIterations": 30 },
    "mid":   { "matchOn": "model", "matchSubstring": "Mid-M2",  "maxIterations": 90 },
    "top":   { "matchOn": "model", "matchSubstring": "Top-M3",  "maxIterations": 200 }
  }
}
JSON
}
teardown() { rm -rf "$WORK"; }

# The gateway, under a ladder loaded by the REAL loader — not env assembled by hand.
seam_env() {   # $1 = agent
    (
        set +u
        # shellcheck source=/dev/null
        . "$LIBDIR/model-ladders.sh"
        export_model_ladders "$SETTINGS" >/dev/null 2>&1
        "$NODE" -e '
          const { seamInvocationEnv } = require(process.argv[1] + "/seam-invocation.js");
          const e = seamInvocationEnv(process.argv[2]) || {};
          for (const k of Object.keys(e).sort()) process.stdout.write(k + "=" + e[k] + "\n");
        ' "$LIBDIR" "$1" 2>/dev/null
    )
}

@test "the fixture is real — the loader exports a ladder from this settings file" {
    run bash -c ". '$LIBDIR/model-ladders.sh'; export_model_ladders '$SETTINGS' >/dev/null 2>&1; \
                 echo \"\$EPAM_MODEL_LADDER_TIER_ORDER|\$EPAM_MODEL_LADDER_HIGH_START\""
    [[ "$output" == *"medium high highest"* ]]
    [[ "$output" == *"Mid-M2"* ]]
}

@test "THE RULE: a seam's iteration budget comes from the rung it resolves to" {
    # base -> medium -> startModel Fast-M1 -> 30
    run bash -c "$(declare -f seam_env); LIBDIR='$LIBDIR' NODE='$NODE' SETTINGS='$SETTINGS' seam_env cpa-inference"
    [[ "$output" == *"EPAM_MAX_ITERATIONS=30"* ]]
}

@test "a seam on the TOP rung gets the top rung's budget, not the base one" {
    # top -> highest -> startModel vendor/Top-M3 -> 200 (substring match, provider prefix and all)
    run bash -c "$(declare -f seam_env); LIBDIR='$LIBDIR' NODE='$NODE' SETTINGS='$SETTINGS' seam_env spec-agent"
    [[ "$output" == *"EPAM_MAX_ITERATIONS=200"* ]]
}

@test "a seam on the MID rung gets the mid budget" {
    run bash -c "$(declare -f seam_env); LIBDIR='$LIBDIR' NODE='$NODE' SETTINGS='$SETTINGS' seam_env prd-model-coordinator"
    [[ "$output" == *"EPAM_MAX_ITERATIONS=90"* ]]
}

@test "EVERY declared agent gets a budget from the ladder — none inherits a default" {
    checked=0; missing=""
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        checked=$((checked+1))
        out=$(bash -c "$(declare -f seam_env); LIBDIR='$LIBDIR' NODE='$NODE' SETTINGS='$SETTINGS' seam_env '$a'")
        case "$out" in *EPAM_MAX_ITERATIONS=*) ;; *) missing="$missing $a";; esac
    done < <("$NODE" -e '
        const p=require("'"$PROFILES"'"); const n=[];
        (function w(o){for(const k in o){const v=o[k];if(v&&typeof v==="object"){
          if(v.ladder||v.maxIterations||v.reasoningEffort||v._what)n.push(k);w(v);}}})(p);
        [...new Set(n)].filter(x=>x!=="defaults").sort().forEach(x=>console.log(x));')
    [ "$checked" -gt 30 ]
    [ -z "$missing" ] || { echo "agents with no ladder-derived budget:$missing"; false; }
}

@test "NO AGENT DECLARES ITS OWN maxIterations — the ladder owns that number" {
    run "$NODE" -e '
      const p=require("'"$PROFILES"'"); const bad=[];
      (function w(o){for(const k in o){const v=o[k];if(v&&typeof v==="object"){
        if(v.maxIterations!==undefined && k!=="defaults")bad.push(k);w(v);}}})(p);
      process.stdout.write(bad.join(","));'
    [ -z "$output" ] || { echo "profiles still carrying a per-agent budget: $output"; false; }
}
