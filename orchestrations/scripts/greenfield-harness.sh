#!/bin/bash
# greenfield-harness.sh — the WHOLE greenfield flow, end to end, in a fresh install, with a verdict.
#
#   install.sh → real observability stack (and the mock stack for a £0 pass) → tier3-run.sh on the
#   named provider set → every declared phase → assertions on what landed: the launcher's exit, each
#   phase completed, commits in the codeline, the codeline's own tests green, every story completed
#   in the PRD, and EVERY SEAM THE REGISTRY DECLARES — executed or not, by name.
#
# Usage:
#   greenfield-harness.sh --set openrouter [--project greenfield-proof] [--ref <git ref>]
#                         [--dest <dir>] [--ceiling-usd 5]
#   greenfield-harness.sh --set mockserver ...        # the same flow at £0: the model is MockServer
#
# A paid set spends money: the run is halted the moment the ledger passes --ceiling-usd. The
# install is kept for evidence; its stacks are stopped (volumes preserved) at the end.
# Nothing here names a seam, a stage or a project: seams come from the registry, phases and
# projects from config, the test command from the codeline's ecosystem provider.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
# THE PROJECT'S BASE ENV FILE, resolved through the provider-set registry — never spelled here.
_project_env() {
  "$NODE_BIN" -e 'const {projectEnvFiles}=require(process.argv[1]);const f=projectEnvFiles(process.argv[2]);if(!f){process.stderr.write("no provider-set registry resolves the env files of "+process.argv[2]+"\n");process.exit(2)}process.stdout.write(f.base)' \
    "$DEST/orchestrations/scripts/lib/llm-settings-resolve.js" "$1"
}

SET=""; PROJECT="greenfield-proof"; REF="HEAD"; DEST=""; CEILING="5"; ASSESS_ONLY=0; RATCHET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --assess-only) ASSESS_ONLY=1; DEST="$2"; shift 2 ;;   # judge a kept install again; no install, no run, no spend
    --set)         SET="$2"; shift 2 ;;
    --project)     PROJECT="$2"; shift 2 ;;
    --ref)         REF="$2"; shift 2 ;;
    --dest)        DEST="$2"; shift 2 ;;
    --ceiling-usd) CEILING="$2"; shift 2 ;;
    --ratchet)     RATCHET="$2"; shift 2 ;;   # a previous run's verdict: nothing it had may be lost
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ "$ASSESS_ONLY" = "1" ]; then
  # A kept install is judged from what it recorded: the verdict, or — when the harness itself died
  # after the run and before judging (its script was edited while bash was reading it, run 24,
  # 2026-09-14) — the run's exit and spend as its own log recorded them.
  if [ -f "$DEST/harness-verdict.json" ]; then
    SET="$("$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).set)' "$DEST/harness-verdict.json")"
    PROJECT="$("$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).project)' "$DEST/harness-verdict.json")"
  elif grep -q '^\[harness\] run exited [0-9]* · spend \$' "$DEST/harness.log" 2>/dev/null; then
    SET="${SET:-$(sed -n 's/^\[harness\] ref .* · set \([^ ]*\) · project \([^ ]*\) .*/\1/p' "$DEST/harness.log" | head -1)}"
    PROJECT="$(sed -n 's/^\[harness\] ref .* · set \([^ ]*\) · project \([^ ]*\) .*/\2/p' "$DEST/harness.log" | head -1)"
  else
    echo "--assess-only: no harness verdict and no recorded run in $DEST — nothing ran there" >&2; exit 2
  fi
fi
[ -n "$SET" ] || { echo "--set <provider set> is required" >&2; exit 2; }
DEST="${DEST:-$(mktemp -d "${TMPDIR:-/tmp}/greenfield-harness-XXXXXX")}"
SHA="$(git -C "$REPO_ROOT" rev-parse --short "$REF")" || exit 2
LOG="$DEST/harness.log"; mkdir -p "$DEST"
VERDICT="$DEST/harness-verdict.json"
# Where the brownfield launcher builds its workspace — known to the launch AND to a later
# --assess-only, which judges the codeline it left there.
MOCK1_WORKSPACE_ROOT="$DEST/mock1-workspace"; export MOCK1_WORKSPACE_ROOT
say() { printf '[harness] %s\n' "$*" | tee -a "$LOG"; }
red() { printf '[harness] ✗ %s\n' "$*" | tee -a "$LOG" >&2; }
FAILS=()
check() { local ok="$1"; shift; if [ "$ok" = "0" ]; then say "✓ $*"; else red "$*"; FAILS+=("$*"); fi; }

say "ref $SHA · set $SET · project $PROJECT · install $DEST · ceiling \$$CEILING"

if [ "$ASSESS_ONLY" = "1" ]; then
  # A kept install is judged again: the run's exit and spend are read back from its verdict.
  cd "$DEST" || exit 1
  PROJECT_DIR="$DEST/orchestrations/projects/$PROJECT"
  PROJECT_ENV="$(_project_env "$PROJECT_DIR")" || exit 2
  PRD_FILE="$(sed -n 's/^PRD_FILE=//p' "$PROJECT_ENV" | tr -d '"')"
  PHASES="$(sed -n 's/^EPAM_PHASES=//p' "$PROJECT_ENV" | tr -d '"')"
  if [ -f "$VERDICT" ]; then
    RUN_EXIT="$("$NODE_BIN" -e 'process.stdout.write(String(require(process.argv[1]).runExit))' "$VERDICT")"
    SPENT="$("$NODE_BIN" -e 'process.stdout.write(String(require(process.argv[1]).spentUsd))' "$VERDICT")"
  else
    RUN_EXIT="$(sed -n 's/^\[harness\] run exited \([0-9]*\) · spend \$\(.*\)$/\1/p' "$LOG" | head -1)"
    SPENT="$(sed -n 's/^\[harness\] run exited \([0-9]*\) · spend \$\(.*\)$/\2/p' "$LOG" | head -1)"
  fi
  HALTED=""; grep -q "passed the ceiling" "$LOG" && HALTED="halted"
  say "assessing again: run exited $RUN_EXIT · spend \$$SPENT"
fi
if [ "$ASSESS_ONLY" != "1" ]; then
# ── 1. Install, as an operator does ──────────────────────────────────────────
_replay=off; [ "$SET" = "mockserver" ] && _replay=on
bash "$REPO_ROOT/orchestrations-installer/install.sh" --dest "$DEST" --ref "$REF" --stack "$SET" --docker --replay "$_replay" >>"$LOG" 2>&1
check $? "install.sh --stack $SET --replay $_replay"
if [ "${#FAILS[@]}" -gt 0 ]; then tail -20 "$LOG" >&2; exit 1; fi
# A paid set's credentials come from the operator's environment, never from this script.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  grep -q '^OPENROUTER_API_KEY=' "$DEST/.env" && sed -i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$OPENROUTER_API_KEY|" "$DEST/.env" || printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" >> "$DEST/.env"
fi
if [ "$SET" = "mockserver" ]; then
  bash "$DEST/orchestrations-installer/pipeline-services.sh" --start --mock >>"$LOG" 2>&1
  check $? "mock stack started"
fi
bash "$DEST/orchestrations-installer/pipeline-health.sh" >>"$LOG" 2>&1
check $? "pipeline-health.sh"
if [ "${#FAILS[@]}" -gt 0 ]; then tail -30 "$LOG" >&2; exit 1; fi

# ── 2. The run ───────────────────────────────────────────────────────────────
cd "$DEST" || exit 1
# The install's .env, through the pipeline's own loader — never sourced raw (a bare `cd` in it
# would relocate the harness).
# shellcheck source=/dev/null
. "$DEST/orchestrations/scripts/lib/env-file.sh"; load_env_file_safe "$DEST/.env"
export EPAM_PROVIDER_SET="$SET" OUTPUT_DIR="$DEST/build" EPAM_PAUSE_AFTER_AGENT_MINT=0 EPAM_PAUSE_BEFORE_WRITER=0 NODE_BIN
# Pre-flight's shellcheck verdict is cached per digest of the orchestrator's bytes; the same bytes
# in a fresh install carry the same verdict, so the harness shares the repository's cache and a
# run needs the 3.6 GB shellcheck pass only when the orchestrator actually changed.
export EPAM_PREFLIGHT_CACHE_DIR="${EPAM_PREFLIGHT_CACHE_DIR:-$REPO_ROOT/orchestrations/scripts/.preflight-cache}"
_node_dir="$(dirname "$NODE_BIN")"; export PATH="$_node_dir:$PATH"
PROJECT_DIR="$DEST/orchestrations/projects/$PROJECT"
[ -d "$PROJECT_DIR" ] || { red "no project '$PROJECT' in the install"; exit 1; }
PROJECT_ENV="$(_project_env "$PROJECT_DIR")" || exit 2
[ -n "$PROJECT_ENV" ] || { red "the provider-set registry resolves no env file for $PROJECT_DIR"; exit 2; }
PRD_CANONICAL="$(sed -n 's/^PRD_CANONICAL=//p' "$PROJECT_ENV" | tr -d '"')"
PRD_FILE="$(sed -n 's/^PRD_FILE=//p' "$PROJECT_ENV" | tr -d '"')"
PHASES="$(sed -n 's/^EPAM_PHASES=//p' "$PROJECT_ENV" | tr -d '"')"
if [ "$SET" = "mockserver" ]; then
  export EPAM_FREE_RUN=1 ANTHROPIC_API_KEY=mock-no-spend
  # WHERE THE MOCK LISTENS is what the set redirects its runners to: the first URL among the env
  # values the set's runners resolve — the same value the run itself will export.
  # WHERE THE MOCK LISTENS is what the set redirects the run's runner to: the URL among the env
  # values that runner resolves — the same value the run itself exports. The runner is the one the
  # project's set overlay names for orchestration.
  _runner="$(sed -n 's/^EPAM_ORCHESTRATION_PROVIDER=//p' "$PROJECT_DIR/config.$SET.env" | tr -d '"')"
  _mock_host="${EPAM_MOCK_BASE_URL:-$("$NODE_BIN" -e '
    const r = require(process.argv[1]); const v = r.runnerValues(process.argv[3], { projectConfigDir: process.argv[2] });
    process.stdout.write(Object.values((v && v.env) || {}).find((x) => /^https?:\/\//.test(String(x))) || "");
  ' "$DEST/orchestrations/scripts/lib/llm-settings-resolve.js" "$PROJECT_DIR" "$_runner")}"
  [ -n "$_mock_host" ] || { red "the $SET set redirects runner '$_runner' to no mock endpoint"; exit 1; }
  [ -n "$_mock_host" ] || { red "the $SET set redirects no runner to a mock endpoint"; exit 1; }
  export EPAM_MOCK_BASE_URL="$_mock_host"
  if [ -d "$PROJECT_DIR/seed" ]; then
    say "mock answers are registered by the paused launcher itself, from the tracker's issues (no PRD exists before ingest)"
  else
    [ -n "$PRD_CANONICAL" ] || { red "project env declares no PRD_CANONICAL — the mock would register no story answers"; exit 2; }
    PRD_FILE="$DEST/$PRD_CANONICAL" EPAM_PROJECT_CONFIG_DIR="$PROJECT_DIR" "$NODE_BIN" "$DEST/orchestrations/scripts/mock-expectations.js" --host "$_mock_host" >>"$LOG" 2>&1
    check $? "mock answers registered at $_mock_host"
  fi
fi

ledger_total() {
  find "$DEST/orchestrations/logs" -name phase-cost.jsonl -print0 2>/dev/null | xargs -0 cat 2>/dev/null \
    | "$NODE_BIN" -e 'let t=0;require("readline").createInterface({input:process.stdin}).on("line",l=>{try{t+=Number(JSON.parse(l).task_cost_usd)||0}catch{}}).on("close",()=>process.stdout.write(t.toFixed(4)))'
}

# WHICH LAUNCHER: the project's own declaration decides. A project carrying a seed/ is the
# pipeline's brownfield rehearsal estate (mock1-paused-run.sh builds the codeline from it, serves
# its ticket from the stub tracker, pauses before the writer, and resumes); any other project is
# launched by the operator's launcher, tier3-run.sh. Neither is named by mode here.
BROWNFIELD_SEED=""; [ -d "$PROJECT_DIR/seed" ] && BROWNFIELD_SEED="$PROJECT_DIR/seed"
if [ -n "$BROWNFIELD_SEED" ]; then
  say "launching mock1-paused-run.sh for $PROJECT (set $SET): start, pause before the writer, resume"
  # Exported (set -a) for the launcher below — shellcheck cannot see the consumer.
  # shellcheck disable=SC2034
  ( set -a; EPAM_PROJECT_CONFIG_DIR="$PROJECT_DIR"; LOG_DIR="$DEST/orchestrations/logs"
    bash "$DEST/orchestrations/scripts/mock1-paused-run.sh" && {
      _rid="$(grep -o 'RUN NUMBER:[[:space:]]*[0-9TZ]*' "$LOG" | head -1 | awk '{print $NF}')"
      [ -n "$_rid" ] || { echo "[harness] the paused launcher printed no RUN NUMBER — nothing to resume" >&2; exit 1; }
      bash "$DEST/orchestrations/scripts/mock1-paused-run.sh" --resume "$_rid"
    } ) >>"$LOG" 2>&1 &
  RUN_PID=$!
else
  say "launching tier3-run.sh --project $PROJECT (set $SET)"
  setsid bash "$DEST/orchestrations/scripts/tier3-run.sh" --project "$PROJECT" --yes >>"$LOG" 2>&1 &
  RUN_PID=$!
fi
HALTED=""
while kill -0 "$RUN_PID" 2>/dev/null; do
  sleep 20
  _spent="$(ledger_total)"
  if awk -v s="$_spent" -v c="$CEILING" 'BEGIN{exit !(s>c)}'; then
    HALTED="spend \$$_spent passed the ceiling \$$CEILING"
    red "$HALTED — halting the run"
    # THE WHOLE SESSION, not the launcher alone: the runner CLI re-parents into its own process
    # group and survived a group kill (one `claude --print` was still spending after a halt).
    pkill -TERM -s "$RUN_PID" 2>/dev/null; sleep 5; pkill -KILL -s "$RUN_PID" 2>/dev/null
    break
  fi
done
wait "$RUN_PID"; RUN_EXIT=$?
SPENT="$(ledger_total)"
say "run exited $RUN_EXIT · spend \$$SPENT"
if [ "$SET" = "mockserver" ] && [ -n "${_mock_host:-}" ]; then
  # WHAT THE MOCK ANSWERED, request by request: the recorded pairs, kept beside the log, and a
  # count per answering seam — a request that fell to the catch-all is named here, not guessed at.
  curl -s -X PUT "$_mock_host/mockserver/retrieve?type=REQUEST_RESPONSES&format=JSON" > "$DEST/mock-traffic.json" 2>/dev/null || true
  "$NODE_BIN" -e '
    const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const c = {};
    for (const x of a) { const s = ((x.httpResponse && x.httpResponse.headers && x.httpResponse.headers["x-seam"]) || ["(no seam header)"])[0]; c[s] = (c[s] || 0) + 1; }
    process.stdout.write(Object.entries(c).sort((p, q) => q[1] - p[1]).map(([k, v]) => `${v} × ${k}`).join("\n") + "\n");
  ' "$DEST/mock-traffic.json" 2>/dev/null | sed 's/^/[harness]   mock served: /' | tee -a "$LOG" || true
fi
fi   # not --assess-only

# ── 3. What landed ───────────────────────────────────────────────────────────
check "$RUN_EXIT" "launcher exit 0"
_rc=0; [ -z "$HALTED" ] || _rc=1; check "$_rc" "run completed under the ceiling"
if [ -d "$PROJECT_DIR/seed" ]; then
  # The brownfield rehearsal: one phase, paused and resumed; the codeline is the clone the launcher
  # built under the workspace root, and the PRD is the one ingest synthesised from the tracker.
  grep -q "STOPPED before the writer" "$LOG"; check $? "the run paused before the writer"
  grep -q "resume finished (exit 0)" "$LOG"; check $? "the resume finished (exit 0)"
  _rid="$(grep -o 'RUN NUMBER:[[:space:]]*[0-9TZ]*' "$LOG" | head -1 | awk '{print $NF}')"
  CODELINE="$(ls -d "$MOCK1_WORKSPACE_ROOT/$_rid/workspace/codelines"/*/ 2>/dev/null | head -1)"
  PRD_FILE_ABS="$MOCK1_WORKSPACE_ROOT/$_rid/workspace/synthesized-prd.json"
  PHASES="${PHASES:-core}"
else
  CODELINE="$DEST/build"; PRD_FILE_ABS="$DEST/$PRD_FILE"
fi
# A PHASE IS COMPLETE WHEN ITS GATE SAID GO — the pipeline's own record (check-phase-gate.sh →
# logs/phase-gates.jsonl), written by every launcher. Grepping the greenfield lifecycle's log
# phrase judged the brownfield lane loop, which prints another, as never completing (run 12).
for p in $PHASES; do
  "$NODE_BIN" -e 'const fs=require("fs");const [f,p]=process.argv.slice(1);let ok=false;try{for(const l of fs.readFileSync(f,"utf8").split("\n")){try{const j=JSON.parse(l);if(j.phase_id===p&&String(j.decision).toLowerCase()==="go")ok=true}catch{}}}catch{}process.exit(ok?0:1)' "$DEST/orchestrations/logs/phase-gates.jsonl" "$p"
  check $? "phase '$p' completed (its gate decided GO)"
done
_commits="$(git -C "$CODELINE" rev-list --count HEAD 2>/dev/null || echo 0)"
_rc=0; [ "${_commits:-0}" -gt 1 ] || _rc=1; check "$_rc" "codeline holds committed work ($_commits commits)"
# THE CODELINE'S OWN TESTS, by the command its ecosystem provider declares for it — resolved from
# the codeline being judged: looked up under the greenfield output dir, a brownfield codeline was
# judged to declare nothing whatever it declared (run 11, 2026-09-14).
_test_cmd="$("$NODE_BIN" -e '
  const fs = require("fs"), path = require("path");
  const { resolveEcosystem } = require(process.argv[1]); const root = process.argv[2];
  const hit = resolveEcosystem(root); if (!hit) process.exit(0);
  const tc = hit.eco.testCommand;
  const text = fs.readFileSync(path.join(root, hit.present), "utf8");
  process.stdout.write(String(typeof tc === "function" ? tc(text) : (tc || "")));
' "$DEST/orchestrations/scripts/lib/handlers/codeline-manifests.js" "$CODELINE" 2>/dev/null)"
if [ -n "$_test_cmd" ]; then
  (cd "$CODELINE" && bash -c "$_test_cmd") >>"$LOG" 2>&1
  check $? "codeline tests green: $_test_cmd"
else
  check 1 "the codeline's ecosystem declares a test command"
fi
_incomplete="$("$NODE_BIN" -e 'const p=require(process.argv[1]);process.stdout.write((p.stories||[]).filter(s=>!s.completed).map(s=>s.id).join(" "))' "$PRD_FILE_ABS" 2>/dev/null)"
_rc=0; [ -z "$_incomplete" ] || _rc=1; check "$_rc" "every story completed in the PRD${_incomplete:+ (incomplete: $_incomplete)}"

# ── 4. Every seam the registry declares ──────────────────────────────────────
# THE SEAMS THIS PROJECT'S RUN IS EXPECTED TO EXECUTE, from the registry's own declarations
# (lib/seams-expected.js): a seam declaring appliesTo for modes this project is not in is listed
# with its declared reason, and neither counted missing nor silently dropped.
_expected_json="$("$NODE_BIN" "$REPO_ROOT/orchestrations/scripts/lib/seams-expected.js" "$DEST/orchestrations/agents/invocation-profiles.json" "$PROJECT_DIR")"
_seams="$(printf '%s' "$_expected_json" | "$NODE_BIN" -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(JSON.parse(b).expected.join("\n")))')"
_all_n="$("$NODE_BIN" -e 'const r=require(process.argv[1]);process.stdout.write(String(Object.keys(r.profiles||{}).length))' "$DEST/orchestrations/agents/invocation-profiles.json")"
say "seams the registry declares for this project's modes ($(printf '%s' "$_expected_json" | "$NODE_BIN" -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(JSON.parse(b).modes.join("+")))')): $(printf '%s\n' "$_seams" | grep -c .) of $_all_n"
printf '%s' "$_expected_json" | "$NODE_BIN" -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const e=JSON.parse(b).excluded;for(const [s,w] of Object.entries(e))process.stdout.write("  - "+s+" — not expected: "+w+"\n")})' | while IFS= read -r l; do say "$l"; done
# From the run's own records, resolved through the registry (lib/seams-executed.js): the ledger,
# the activity log and Langfuse, every name put through resolveSeam.
_run_id="$(grep -o 'RUN NUMBER:[[:space:]]*[0-9TZ]*' "$LOG" | head -1 | awk '{print $NF}')"
_lf_port="$(sed -n 's/^OBS_LANGFUSE_PORT=//p' "$DEST/.pipeline-services-state.env" 2>/dev/null)"
_executed="$(LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-http://localhost:${_lf_port:-3100}}" EPAM_PROJECT_CONFIG_DIR="$PROJECT_DIR" \
  "$NODE_BIN" "$REPO_ROOT/orchestrations/scripts/lib/seams-executed.js" "$DEST" "$_run_id" | "$NODE_BIN" -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const j=JSON.parse(b);process.stdout.write(j.executed.join("\n"));if(j.unresolved.length)process.stderr.write("[harness] names resolving to no seam: "+j.unresolved.join(", ")+"\n")})')"
_n=0; _x=0; _missing=()
say "seams (registry): executed / NOT EXECUTED"
while IFS= read -r s; do
  [ -n "$s" ] || continue; _n=$((_n+1))
  if printf '%s\n' "$_executed" | grep -Fxq -- "$s" || printf '%s\n' "$_executed" | grep -Fxq -- "${s%%:*}"; then
    say "  ✓ $s"; _x=$((_x+1))
  else
    say "  ✗ $s — NOT EXECUTED"; _missing+=("$s")
  fi
done <<< "$_seams"
_rc=0; [ "${#_missing[@]}" -eq 0 ] || _rc=1; check "$_rc" "every seam declared for this project's modes executed ($_x of $_n; $_all_n in the registry)"

# ── THE RATCHET ──────────────────────────────────────────────────────────────
# A FIX THAT MAKES THE NEXT RUN WORSE IS NOT A FIX (operator, 2026-09-14: run 15 fell from 35/40 to
# 27/40 on a "fix"). Judged against a previous run's verdict, a seam that executed then and not
# now, or a check that passed then and fails now, is a failure of its own — whatever was gained.
# A check is compared by its key: the label before any parenthesised count, so "(1 commits)" and
# "(2 commits)" are the same check.
_ckey() { printf '%s' "$1" | sed 's/ *(.*//'; }
_executed_now="$(printf '%s\n' "$_seams" | while IFS= read -r s; do [ -n "$s" ] || continue; printf '%s\n' "${_missing[@]}" | grep -Fxq -- "$s" || printf '%s\n' "$s"; done)"
if [ -n "$RATCHET" ]; then
  [ -f "$RATCHET" ] || { echo "--ratchet: no verdict at $RATCHET" >&2; exit 2; }
  _prev_sha="$("$NODE_BIN" -e 'process.stdout.write(String(require(process.argv[1]).sha||""))' "$RATCHET")"
  _prev_seams="$("$NODE_BIN" -e 'process.stdout.write((require(process.argv[1]).seamsExecutedList||[]).join("\n"))' "$RATCHET")"
  _prev_fails="$("$NODE_BIN" -e 'process.stdout.write((require(process.argv[1]).failureKeys||[]).join("\n"))' "$RATCHET")"
  say "ratchet against $RATCHET ($_prev_sha): nothing that run had may be lost"
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    # A seam the registry now declares inapplicable to this project is excluded with its stated
    # reason (printed above), not lost: it is not held against this run.
    if ! printf '%s\n' "$_seams" | grep -Fxq -- "$s"; then say "ratchet: $s executed on $_prev_sha and is not expected here — excluded by declaration, not lost"; continue; fi
    if ! printf '%s\n' "$_executed_now" | grep -Fxq -- "$s"; then check 1 "ratchet: $s executed on $_prev_sha and not on this run"; fi
  done <<< "$_prev_seams"
  # A check that failed then is not ratcheted; every other check of this run must still pass.
  _fails_snapshot=("${FAILS[@]}")
  for f in "${_fails_snapshot[@]}"; do
    case "$f" in ratchet:*) continue ;; esac
    if ! printf '%s\n' "$_prev_fails" | grep -Fxq -- "$(_ckey "$f")"; then check 1 "ratchet: '$(_ckey "$f")' passed on $_prev_sha and fails on this run"; fi
  done
fi

# ── 5. Verdict, teardown ─────────────────────────────────────────────────────
[ "$ASSESS_ONLY" = "1" ] || bash "$DEST/orchestrations-installer/pipeline-services.sh" --stop >>"$LOG" 2>&1 || true
"$NODE_BIN" -e '
  const [sha,set,project,spent,exit,fails,missing,x,n,executed]=process.argv.slice(1);
  const failures = fails? fails.split(""):[];
  process.stdout.write(JSON.stringify({sha,set,project,spentUsd:Number(spent),runExit:Number(exit),
    verdict: fails==="" ? "GREEN" : "RED", failures, seamsExecuted:Number(x), seamsDeclared:Number(n),
    seamsNotExecuted: missing? missing.split(""):[],
    // What the next run is ratcheted against: the seams this run executed, and its failures by key.
    seamsExecutedList: executed? executed.split("\n").filter(Boolean):[],
    failureKeys: failures.filter((f)=>!f.startsWith("ratchet:")).map((f)=>f.replace(/ *\(.*$/,"")),
    at:new Date().toISOString()},null,2)+"\n")
' "$SHA" "$SET" "$PROJECT" "$SPENT" "$RUN_EXIT" "$(IFS=$'\x1f'; echo "${FAILS[*]-}")" "$(IFS=$'\x1f'; echo "${_missing[*]-}")" "$_x" "$_n" "$_executed_now" > "$VERDICT"
if [ "${#FAILS[@]}" -eq 0 ]; then
  say "VERDICT GREEN — $PROJECT on $SET at $SHA, \$$SPENT, $_x/$_n seams · $VERDICT"; exit 0
else
  red "VERDICT RED — ${#FAILS[@]} failure(s): $(IFS='; '; echo "${FAILS[*]}") · $VERDICT · log $LOG"; exit 1
fi
