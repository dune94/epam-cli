#!/usr/bin/env bash
# mock1-paused — operator-driven pause/restart of the real mock pipeline.
#
# This is NOT the vitest test (brownfield-mock-e2e-paused.test.ts). That test runs both
# passes back to back to prove the mechanism; useful for CI, useless for driving the thing
# by hand, because it resumes itself and never waits for anyone.
#
# This script is the workflow:
#
#   1. START — prints the RUN NUMBER immediately, before any work, then runs the real
#      pipeline up to the point just BEFORE the writer and STOPS. Everything the writer
#      consumes is settled by then. It does not resume. It does not
#      ask. It exits and leaves the checkpoint on disk.
#   2. RESUME — a separate, later invocation, given that run number, starts at
#      implementation. Repeatable: the same run number can be resumed as often as needed.
#
# The mock workspace (git repo + Jira stub fixture) is persisted under the run directory,
# NOT in a scratch temp dir, because a resume that happens minutes or days later must find
# the same codeline it paused against.
#
# Usage:
#   mock1-paused-run.sh                 # start; pauses just before the writer
#   mock1-paused-run.sh --resume <id>   # continue that run at implementation
#   mock1-paused-run.sh --list          # run numbers that can be resumed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# No project name is written here. This is a generic harness, not a per-project launcher
# (those are tier<N>-<project>-run.sh and may name their own project). The mock project is
# CONFIGURABLE via EPAM_PROJECT_CONFIG_DIR, and otherwise DETERMINABLE: read the default
# out of the launcher that actually owns it, so the two can never drift and this file
# stays valid for the next unknown mock project.
PROJECT_CONFIG_DIR="${EPAM_PROJECT_CONFIG_DIR:-}"
if [ -z "$PROJECT_CONFIG_DIR" ]; then
  PROJECT_CONFIG_DIR=$(
    sed -n 's|^export EPAM_PROJECT_CONFIG_DIR="\${EPAM_PROJECT_CONFIG_DIR:-\(.*\)}".*$|\1|p' \
      "$SCRIPT_DIR/tier3-mock-run.sh" 2>/dev/null | head -1
  )
  PROJECT_CONFIG_DIR="${PROJECT_CONFIG_DIR//\$REPO_ROOT/$REPO_ROOT}"
fi
if [ -z "$PROJECT_CONFIG_DIR" ] || [ ! -d "$PROJECT_CONFIG_DIR" ]; then
  echo "[mock1-paused] cannot determine the mock project config dir — set EPAM_PROJECT_CONFIG_DIR" >&2
  exit 2
fi
MOCK_JIRA_SERVER="$REPO_ROOT/test/fixtures/mock-pipeline/mock-jira-server.js"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"

STORY_ID="MOCK-HW-1"
SUMMARY="getGreeting should return hello dolly"
DESCRIPTION="The getGreeting() function in this codebase currently returns the string 'hello world'. It should instead return 'hello dolly'. Update any test that asserts the old value to match the new one. The change is a one-line edit in src/hello.ts plus its test."

source "$SCRIPT_DIR/lib/run-checkpoint.sh"
export EPAM_PROJECT_CONFIG_DIR="$PROJECT_CONFIG_DIR"

# WHERE THE MOCK CODELINE LIVES — outside this repo, always.
#
# It was briefly placed under orchestrations/projects/<p>/runs/<id>/workspace so a resume
# could find it. That cost a full retry cycle live on 2026-08-03: vitest walks UP the tree
# for a config, found epam-cli's own vitest.config.ts (include: ['test/**/*.test.ts',
# 'greet.test.ts']), and the mock's src/hello.test.ts matched nothing —
#     filter: src/hello.test.ts / include: test/**/*.test.ts, greet.test.ts
#     No test files found, exiting with code 1
# The repro-gate correctly blocked the story, remediation fired, the phase restarted. The
# code change was fine the entire time; only the fixture's location was wrong.
#
# It also broke a standing rule: test app files live OUTSIDE the engine repo. So the
# workspace goes to a durable path that is NOT under any project checkout — durable
# because a resume may happen days later, and /tmp does not survive a reboot.
MOCK_WORKSPACE_ROOT="${MOCK1_WORKSPACE_ROOT:-$HOME/.epam/mock1-paused}"

RESUME_ID=""
case "${1:-}" in
  --list)
    list_run_checkpoints
    exit 0
    ;;
  --where)
    # Report where a workspace WOULD go, without creating anything or starting a run.
    # Exists so the location can be asserted in a test rather than discovered in a run.
    printf '%s\n' "$MOCK_WORKSPACE_ROOT/<run-id>/workspace"
    exit 0
    ;;
  --seed)
    # Build ONLY the seed fixture into <dir>, then exit. No Jira stub, no pipeline, no
    # LLM, no spend. Exists so a test can run vitest against the real fixture and prove
    # the test file is actually discovered — the check that would have caught the live
    # 2026-08-03 failure before it cost a run.
    SEED_ONLY_DIR="${2:-}"
    [ -n "$SEED_ONLY_DIR" ] || { echo "--seed requires a target directory" >&2; exit 2; }
    ;;
  --resume)
    RESUME_ID="${2:-}"
    [ -n "$RESUME_ID" ] || { echo "--resume requires a run number" >&2; exit 2; }
    ;;
  "" ) ;;
  * ) echo "unknown option '$1'" >&2; exit 2 ;;
esac

# ── Run identity ─────────────────────────────────────────────────────────────
# On a resume the run id is GIVEN; on a start it is minted here and announced before
# anything happens, so the operator has a handle even if the run later dies.
if [ -n "$RESUME_ID" ]; then
  ORCH_RUN_ID="$RESUME_ID"
else
  ORCH_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
fi
export ORCH_RUN_ID

# The checkpoint stays in the project config dir (that is engine state, and it is what
# pre-run-reset must not touch). The WORKSPACE — a fake client codeline — lives outside
# this repo entirely. See the MOCK_WORKSPACE_ROOT note above for what mixing them cost.
RUN_DIR="$PROJECT_CONFIG_DIR/runs/$ORCH_RUN_ID"
WORKSPACE="${SEED_ONLY_DIR:-$MOCK_WORKSPACE_ROOT/$ORCH_RUN_ID/workspace}"
CODELINE_ROOT="$WORKSPACE/codelines"
CLONE="$CODELINE_ROOT/mock-hello-world"
SYNTH_PRD="$WORKSPACE/synthesized-prd.json"

echo ""
echo "════════════════════════════════════════════════════════════════════"
if [ -n "$RESUME_ID" ]; then
  echo "  mock1-paused — RESUMING at implementation"
else
  echo "  mock1-paused — STARTING (will stop just before the writer)"
fi
echo "  RUN NUMBER:  ${ORCH_RUN_ID}"
echo "  Workspace:   ${WORKSPACE}"
echo "════════════════════════════════════════════════════════════════════"
echo ""

# ── Mock codeline: a real git repo with a real failing expectation ───────────
# Built once per run and kept, so a resume works against the same repo it paused on.
build_workspace() {
  mkdir -p "$CODELINE_ROOT"
  chmod 755 "$RUN_DIR" "$WORKSPACE" "$CODELINE_ROOT" 2>/dev/null || true

  local bare="$WORKSPACE/origin.git" seed="$WORKSPACE/seed"
  git init --bare --initial-branch=main --quiet "$bare"

  mkdir -p "$seed/src"
  git -C "$seed" init --quiet --initial-branch=main
  git -C "$seed" config user.email test@test.com
  git -C "$seed" config user.name Test

  printf 'node_modules\n' > "$seed/.gitignore"
  cat > "$seed/package.json" <<'JSON'
{ "name": "mock-hello-world", "version": "1.0.0", "private": true,
  "devDependencies": { "typescript": "5.9.3" } }
JSON
  cat > "$seed/tsconfig.json" <<'JSON'
{ "compilerOptions": { "module": "CommonJS", "moduleResolution": "node", "target": "ES2020",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true, "noEmit": true,
    "types": ["vitest/globals", "node"] },
  "include": ["src/**/*.ts"] }
JSON

  # PIN THE TEST GLOB. Without its own config, vitest walks UP the directory tree and
  # adopts whatever it finds — which on 2026-08-03 was epam-cli's own
  # include: ['test/**/*.test.ts','greet.test.ts']. The mock's src/hello.test.ts then
  # matched nothing ("No test files found, exiting with code 1"), the repro-gate blocked
  # the story, and the phase restarted. Moving the workspace out of the repo fixes the
  # instance; owning the config fixes the class, wherever the workspace ends up.
  # The seed sources live with the project, not in this launcher. A seed file written by a
  # heredoc is a project fact inside the pipeline, and it cannot be opened, linted or
  # type-checked where it was.
  _seed_src="$PROJECT_CONFIG_DIR/seed"
  [ -d "$_seed_src" ] || { echo "[mock1-paused] seed sources not found at $_seed_src" >&2; exit 1; }
  cp -R "$_seed_src/." "$seed/"

  git -C "$seed" add -A
  git -C "$seed" commit -m "seed: hello world baseline" --quiet
  git -C "$seed" remote add origin "$bare"
  git -C "$seed" push origin main --quiet

  git clone --quiet "$bare" "$CLONE"
  git -C "$CLONE" config user.email test@test.com
  git -C "$CLONE" config user.name Test
  ln -sfn "$REPO_ROOT/node_modules" "$CLONE/node_modules"
}

if [ -n "$RESUME_ID" ]; then
  [ -d "$CLONE" ] || { echo "[mock1-paused] no workspace for run '$ORCH_RUN_ID' — cannot resume" >&2; exit 1; }
  [ -d "$RUN_DIR/checkpoint" ] || { echo "[mock1-paused] no checkpoint for run '$ORCH_RUN_ID'" >&2; exit 1; }
  echo "[mock1-paused] reusing the workspace this run paused against"
else
  [ -e "$WORKSPACE" ] && { echo "[mock1-paused] workspace already exists for '$ORCH_RUN_ID'" >&2; exit 1; }
  build_workspace
fi

# --seed stops here: the fixture is built, nothing is launched, nothing is spent.
if [ -n "${SEED_ONLY_DIR:-}" ]; then
  echo "[mock1-paused] seed fixture built at $CLONE (no pipeline started)"
  exit 0
fi

# ── Jira stub (the ONLY stubbed piece of the chain) ──────────────────────────
JIRA_PORT=""
JIRA_PID=""
start_jira() {
  local out; out="$WORKSPACE/jira.out"
  "$NODE_BIN" "$MOCK_JIRA_SERVER" "$STORY_ID" "$SUMMARY" "$DESCRIPTION" > "$out" 2>&1 &
  JIRA_PID=$!
  for _ in $(seq 1 100); do
    JIRA_PORT=$(grep -o 'LISTENING:[0-9]*' "$out" 2>/dev/null | head -1 | cut -d: -f2)
    [ -n "$JIRA_PORT" ] && return 0
    sleep 0.1
  done
  echo "[mock1-paused] mock Jira server never reported a port" >&2
  return 1
}
cleanup() { [ -n "$JIRA_PID" ] && kill "$JIRA_PID" 2>/dev/null || true; }
trap cleanup EXIT

start_jira || exit 1
echo "[mock1-paused] mock Jira on 127.0.0.1:${JIRA_PORT}"

# ── Launch ───────────────────────────────────────────────────────────────────
# Production agent routing (qwen/glm), identical to the vitest mock — a run that
# exercises a provider path production does not use proves nothing.
export JIRA_PIPELINE=1
export JIRA_URL="http://127.0.0.1:${JIRA_PORT}"
export JIRA_EMAIL="mock@test.com"
export JIRA_TOKEN="mock-token"
export JIRA_PROJECT_KEY="MOCK"
export JIRA_STATUS_FILTER="To Do"
export JIRA_SYNTH_PRD_PATH="$SYNTH_PRD"
export EPAM_BROWNFIELD=1
export JIRA_CODELINE_ROOT="$CODELINE_ROOT"
export JIRA_BASELINE_BRANCH="main"
export AGENT_PROFILES_FILE="$REPO_ROOT/orchestrations/agents/profiles.json"
export EPAM_DANGEROUS_SKIP_APPROVAL=1
export ORCH_GATE_PROVIDER="qwen"
export SPEC_MODE_PROVIDER="qwen"
export SPEC_MODE_OPENSPEC_MODEL="z-ai/glm-5.2"
export SPEC_MODE_SPECKIT_MODEL="z-ai/glm-5.1"
export SPEC_MODE_MODEL="z-ai/glm-5.2"
export ORCH_GATE_MODEL="z-ai/glm-5.1"

if [ -n "$RESUME_ID" ]; then
  export EPAM_RESUME_RUN="$ORCH_RUN_ID"
  unset EPAM_PAUSE_BEFORE_WRITER
else
  export EPAM_PAUSE_BEFORE_WRITER=1
fi

bash "$SCRIPT_DIR/tier3-mock-run.sh" \
  --prd "$SYNTH_PRD" --project-root "$CLONE" --phase core
_exit=$?

echo ""
if [ -n "$RESUME_ID" ]; then
  echo "[mock1-paused] resume finished (exit ${_exit})"
  echo "[mock1-paused] greeting now: $(grep -o "return '[^']*'" "$CLONE/src/hello.ts" 2>/dev/null || echo '?')"
else
  echo "════════════════════════════════════════════════════════════════════"
  echo "  STOPPED before the writer. Nothing else will happen."
  echo ""
  echo "  RUN NUMBER:  ${ORCH_RUN_ID}"
  echo "  Checkpoint:  ${RUN_DIR}/checkpoint"
  echo "  Greeting:    $(grep -o "return '[^']*'" "$CLONE/src/hello.ts" 2>/dev/null || echo '?')  (unchanged — implementation not started)"
  echo ""
  echo "  To continue:  $0 --resume ${ORCH_RUN_ID}"
  echo "════════════════════════════════════════════════════════════════════"
fi
exit $_exit
