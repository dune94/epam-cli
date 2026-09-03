#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# team-lead-review.sh — RECEIVER tests: run the real script, under its real shell flags.
#
# 2026-08-20, run 5 was killed after this script produced NO VERDICT eight times in a row. It never
# called a model once — `Invoking review-agent` appears 0 times in the whole log. It died right
# after logging the story, because the day's gateway wiring calls invoke_agent as a FUNCTION and the
# script runs under `set -euo pipefail`, so a non-zero return terminates it.
#
# Seventy test files read this script's source. Three execute it, none reaching the invocation. The
# change was "covered" by:
#
#     expect(src).toMatch(/invoke_agent\s+team-lead-review/)
#
# which proves a string is in a file and nothing about the script running.
#
# These tests run the REAL script with a stubbed runner and assert on what it PRODUCES. If the
# script cannot reach its invocation, they fail — which is the whole point.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    REVIEW="$REPO_ROOT/orchestrations/scripts/team-lead-review.sh"
    WORK="$(mktemp -d)"
    export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
    export PROJECT_ROOT="$WORK/codeline"
    mkdir -p "$PROJECT_ROOT/.epam" "$PROJECT_ROOT/src"

    git -C "$PROJECT_ROOT" init -q 2>/dev/null || true
    git -C "$PROJECT_ROOT" config user.email t@t 2>/dev/null || true
    git -C "$PROJECT_ROOT" config user.name t 2>/dev/null || true
    echo 'export const a = 1;' > "$PROJECT_ROOT/src/a.ts"
    printf '{"name":"fixture"}\n' > "$PROJECT_ROOT/package.json"
    git -C "$PROJECT_ROOT" add -A 2>/dev/null || true
    git -C "$PROJECT_ROOT" commit -qm base 2>/dev/null || true
    git -C "$PROJECT_ROOT" branch -f develop HEAD 2>/dev/null || true

    # A PRD with one story to review.
    export PRD_FILE="$WORK/prd.json"
    cat > "$PRD_FILE" <<'PRD'
{
  "implementationOrder": { "core": ["S-1"] },
  "stories": [{
    "id": "S-1", "title": "a story",
    "description": "the fare boundary excludes riders aged exactly 65",
    "status": "completed", "completed": true,
    "agentRole": "impl-agent",
    "technicalNotes": { "files": ["src/a.ts"] },
    "acceptanceCriteria": ["it works"],
    "verificationCriteria": ["the page renders"]
  }]
}
PRD

    # The runner the reviewer invokes. Returns a well-formed verdict.
    export AI_RUNNER_CMD="$WORK/runner.sh"
    cat > "$AI_RUNNER_CMD" <<'RUNNER'
#!/usr/bin/env bash
cat >/dev/null
echo '{"verdict":"approved","summary":"looks fine","issues":[]}'
RUNNER
    chmod +x "$AI_RUNNER_CMD"

    # THE REVIEW BASELINE, the way the pipeline supplies it.
    #
    # Without this _rev_base falls back to origin/<branch> (no remote here) and then to HEAD~5 — a
    # guessed base that does not exist in a small fixture, so `git diff` fails, `|| true` swallows
    # it, and STORY_DIFF comes back EMPTY. Every assertion about the diff then passes while the
    # block under test never ran.
    git -C "$PROJECT_ROOT" rev-parse develop > "$LOG_DIR/phase-baseline-sha.txt"

    # THE ENGINE REQUIRES A ROSTER. An agent's identity comes only from
    # projects/<project>/roster.json now — there is no engine-roster fallback — so a fixture
    # without one exercises the refusal rather than the reviewer. A private project dir is used
    # rather than the real one: the prompts are read from it too, so it is linked in, and the
    # repo is never written to by a test.
    export EPAM_PROJECT_CONFIG_DIR="$WORK/projectcfg"
    # A REAL project config carries llm-settings.json, and the reviewer needs it to resolve the
    # seam's ladder POSITION. Without it the run stops before invoking anything and the failure
    # reads as the regression this file exists to reproduce. Copied from the shipped project
    # rather than hand-written: a fixture that invents settings tests the fixture.
    mkdir -p "$WORK/projectcfg"
    cp "$REPO_ROOT/orchestrations/projects/mock3/llm-settings.json" "$WORK/projectcfg/" 2>/dev/null || true
    cp -r "$REPO_ROOT/orchestrations/projects/mock3/prompts" "$WORK/projectcfg/" 2>/dev/null || true
    cp "$REPO_ROOT/orchestrations/projects/mock3/prompt-agent-link.json" "$WORK/projectcfg/" 2>/dev/null || true

    mkdir -p "$EPAM_PROJECT_CONFIG_DIR"
    ln -sfn "$REPO_ROOT/orchestrations/projects/metrolinx/prompts" "$EPAM_PROJECT_CONFIG_DIR/prompts"
    "${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}" -e '
      const fs = require("fs");
      const canonical = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const { personaDigest } = require(process.argv[3]);
      const agents = {};
      for (const [n, p] of Object.entries(canonical)) {
        if (typeof p !== "string" || !p.trim()) continue;
        agents[n] = { persona: "[fixture] " + p, kind: "seam", ancestor: n,
                      derivedFromSha256: personaDigest(p) };
      }
      fs.writeFileSync(process.argv[1], JSON.stringify({ agents }, null, 2));
    ' "$EPAM_PROJECT_CONFIG_DIR/roster.json" \
      "$REPO_ROOT/orchestrations/agents/profiles.canonical.json" \
      "$REPO_ROOT/orchestrations/scripts/lib/project-roster.js"
    export PHASE=core
    # A real run always declares which stack it is on; the fixture did not, so the ladder
    # resolver had neither a project settings file nor a set to fall back to.
    export EPAM_PROVIDER_SET="$(jq -r .defaultSet "$REPO_ROOT/orchestrations/config/provider-sets.json")"
    export EPAM_MODEL=test-model
    # THE TIER ORDER COMES FROM THE STACK NOW. Seams ask for a ladder POSITION (base|mid|top) and the
    # order they index into used to live in each project's llm-settings.json. The 2026-08-25
    # migration moved it to the active provider set, so this fixture's empty project dir left the
    # reviewer unable to resolve 'top' and it stopped before invoking anything — reported as the very
    # regression this file exists to reproduce. A real run always has the order; so does this now.
    export EPAM_MODEL_LADDER_TIER_ORDER="$(jq -r '(.ladderTierOrder // []) | join(",")' \
        "$REPO_ROOT/orchestrations/config/llm-defaults.$(jq -r .defaultSet \
        "$REPO_ROOT/orchestrations/config/provider-sets.json").json")"
    export ORCH_GATE_MODEL=test-model

    # THE ENGINE ALWAYS PERSISTS A RUNG BEFORE REVIEW. claude.sh writes it on every attempt
    # before invoking the writer, so a story that reached review HAS one, and the reviewer
    # deliberately refuses to judge without it rather than falling back to a seam default.
    # A fixture with no rung reproduces a state the pipeline cannot be in.
    ( . "$REPO_ROOT/orchestrations/scripts/lib/story-outputs.sh"
      STORY_MODEL=test-model STORY_PROVIDER=test-provider \
      EPAM_REASONING_EFFORT=medium EPAM_TEMPERATURE=0 \
      story_rung_record "$LOG_DIR" S-1 )
}

teardown() { rm -rf "$WORK"; }

@test "the fixture is real — the script and a runner both exist" {
    [ -f "$REVIEW" ]
    [ -x "$AI_RUNNER_CMD" ]
}

@test "REPRODUCES run 5: the reviewer reaches its model invocation" {
    run bash "$REVIEW" core
    # The decisive signal from the live failure: `Invoking review-agent` appeared 0 times.
    [[ "$output" == *"Invoking review-agent"* ]]
}

@test "and it produces a verdict rather than dying silently" {
    run bash "$REVIEW" core
    [ -n "$output" ]
    [[ "$output" == *"Review"* ]]
}

@test "a runner that returns NOTHING is reported as incomplete, not as a verdict" {
    cat > "$AI_RUNNER_CMD" <<'RUNNER'
#!/usr/bin/env bash
cat >/dev/null
RUNNER
    chmod +x "$AI_RUNNER_CMD"
    run bash "$REVIEW" core
    # It must not silently approve. Either it says so, or it writes reviewIncomplete.
    [[ "$output" == *"unparseable"* ]] || [[ "$output" == *"NO VERDICT"* ]] \
      || grep -q reviewIncomplete "$LOG_DIR"/review-feedback-*.json 2>/dev/null
}
