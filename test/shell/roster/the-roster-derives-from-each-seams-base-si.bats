#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE ROSTER DERIVES FROM EACH SEAM'S BASE SI — ONE PER SEAM, NOTHING ELSE.
#
# Operator, 2026-09-29: "Bases and derived si must be matched to each seam. No deviations."
# The base the roster stage copies into the run was profiles.canonical.json: 47 personas keyed by
# AGENT name, covering 16 of 41 seams, 22 of them resolving by name to the wrong seam. The base is
# now the `si` each seam declares in the invocation registry.
#
# Executed, not parsed: the real mint step runs in roster-only mode up to the model call (the key
# is invalid, so nothing is spent) and the run's working copy of the base — the file the
# specialiser reads — is what is asserted. Every expected value is read from the registry.
# ─────────────────────────────────────────────────────────────────────────────

load "../helpers/env-run"

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    REGISTRY="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"; mkdir -p "$WORK/logs" "$WORK/proj"
    printf '%s' '{"stories":[{"id":"T-1","title":"t","codelines":["c1"]}],"implementationOrder":{"core":["T-1"]}}' \
        > "$WORK/prd.json"
}
teardown() { rm -rf "$WORK"; }

run_stage() {
    env_run \
        EPAM_ROSTER_ONLY=1 EPAM_PAUSE_AFTER_AGENT_MINT=1 \
        EPAM_PROJECT_CONFIG_DIR="$WORK/proj" LOG_DIR="$WORK/logs" \
        EPAM_ORCHESTRATION_PROVIDER=openrouter ORCH_GATE_PROVIDER=openrouter \
        OPENROUTER_API_KEY=sk-invalid-fixture EPAM_API_KEY_OPENROUTER=sk-invalid-fixture \
        EPAM_ROSTER_ATTEMPTS=1 \
        timeout 45 "$NODE" "$SCRIPTS/mint-agents-step.js" \
        --prd "$WORK/prd.json" --agents-dir "$REPO_ROOT/orchestrations/agents" \
        --log-dir "$WORK/logs" 2>&1 || true
}

@test "the run's base holds exactly one entry per seam that declares an si, and it IS that si" {
    run run_stage
    [[ "$output" == *"roster-only"* ]] || { echo "stage never entered:"; echo "$output" | tail -5; false; }
    COPY="$WORK/logs/roster-canonical-copy.json"
    [ -s "$COPY" ] || { echo "the stage wrote no base copy"; false; }
    run "$NODE" -e '
      const reg = require(process.argv[1]).profiles; const copy = require(process.argv[2]);
      const want = Object.keys(reg).filter((s) => typeof reg[s].si === "string" && reg[s].si.trim()).sort();
      const got = Object.keys(copy).sort();
      if (!want.length) { console.log("VACUOUS: the registry declares no si"); process.exit(1); }
      const extra = got.filter((k) => !want.includes(k));
      const missing = want.filter((k) => !got.includes(k));
      const wrong = want.filter((k) => got.includes(k) && copy[k] !== reg[k].si);
      if (extra.length || missing.length || wrong.length) {
        console.log(JSON.stringify({ extra, missing, wrong })); process.exit(1);
      }
      console.log("ok " + got.length);
    ' "$REGISTRY" "$COPY"
    [ "$status" -eq 0 ] || { echo "$output"; false; }
}
