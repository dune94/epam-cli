#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A PROFILE NOTHING NAMES CANNOT BE APPLIED.
#
# Two were found on 2026-08-21 by auditing all 38 declared agents:
#
#   cpa-gate          Already documented as orphaned in its own profile on 2026-08-16 —
#                     "no caller names this seam ... Left in place rather than deleted
#                     because removing a seam is a decision, not a tidy-up." It is now that
#                     decision. Its template belongs to cpa-inference, which declares it.
#
#   phase-assessment  NOT orphaned — it declares template skill-assessment-prephase, a
#                     WRITE tool grant and timeoutSecs 900. But the step that runs it called
#                     run_orch_prompt_with_tools "$prompt" "team-lead-agent", so the pre-phase
#                     skill assessment ran under the REVIEWER's identity and got the
#                     reviewer's read-only grant. The engine's own comment beside that call
#                     records the symptom: "It got read tools ... upexpress exhausted."
#
# The second is the one that matters: a profile can be declared, budgeted and templated, and
# still never apply, because the caller passes a different name. Presence is not wiring.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    PROFILES="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

agents() {
    "$NODE" -e '
      const p=require(process.argv[1]); const n=[];
      (function w(o){for(const k in o){const v=o[k];if(v&&typeof v==="object"){
        if(v.ladder||v.reasoningEffort||v._what)n.push(k);w(v);}}})(p);
      [...new Set(n)].filter(x=>x!=="defaults").sort().forEach(x=>console.log(x));' "$PROFILES"
}

@test "the inventory is not vacuous" {
    [ "$(agents | wc -l)" -gt 30 ]
}

@test "NO PROFILE IS DECLARED AND NEVER NAMED BY CODE" {
    # QUOTED tokens only. A bare word match lets the log prefix "[pre-phase-assessment]"
    # satisfy the profile "phase-assessment" — prose, not an invocation.
    #
    # A quoted PREFIX counts, because a seam may be selected through a template variant:
    # prd-change-summarizer is chosen as "prd-change-summarizer-tool" / "-text", and the seam
    # itself resolves under the bare name. Same rule as the vitest fleet audit, deliberately.
    src=$(grep -rhv '^[[:space:]]*\(#\|//\)' "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh "$SCRIPTS"/*.js "$SCRIPTS"/lib/*.js 2>/dev/null)
    bad=""
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        printf '%s' "$src" | grep -qE -- "[\"']${a}([\"']|-)" || bad="$bad $a"
    done < <(agents)
    [ -z "$bad" ] || { echo "declared but never named by pipeline code:$bad"; false; }
}

@test "no profile is marked orphaned — that is a decision to take, not to carry" {
    run "$NODE" -e '
      const p=require(process.argv[1]); const o=[];
      (function w(x){for(const k in x){const v=x[k];if(v&&typeof v==="object"){
        if(v._orphaned)o.push(k);w(v);}}})(p);
      process.stdout.write(o.join(","));' "$PROFILES"
    [ -z "$output" ] || { echo "profiles still marked orphaned: $output"; false; }
}

@test "THE PRE-PHASE SKILL ASSESSMENT RUNS AS ITSELF, not as the reviewer" {
    # The profile declares a WRITE grant and 900s; the reviewer's declares neither. Passing
    # the wrong identity silently applies the wrong tools, effort and timeout.
    run grep -n 'run_orch_prompt_with_tools "\$_pfa_prompt_this_attempt"' "$SCRIPTS/run-agent-orchestration.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"phase-assessment"'* ]]
    [[ "$output" != *'"team-lead-agent"'* ]]
}

@test "and that profile really does declare a write grant, so the identity matters" {
    run "$NODE" -e '
      const p=require(process.argv[1]); let g="";
      (function w(x){for(const k in x){const v=x[k];if(v&&typeof v==="object"){
        if(k==="phase-assessment")g=v.toolGrant||"";w(v);}}})(p);
      process.stdout.write(g);' "$PROFILES"
    [ "$output" = "write" ]
}
