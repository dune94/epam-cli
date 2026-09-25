#!/usr/bin/env bash
# EVERY GATE THAT CALLS NO MODEL IS TESTABLE FOR £0 — SO IT IS TESTED HERE, NOT IN A PAID RUN.
#
# The baseline gate, the verification runner, the lint gate, the deliverables check: none of them
# asks a model anything. They are shell, node and the codeline's own test command. Yet on
# 2026-09-23 the baseline question — why a build that yields 5 failure ids by hand yields 0 inside
# a run — was chased through three paid runs, because every probe was driven with a hand-built
# environment instead of THE ONE THE PIPELINE SETS.
#
# That is the whole difference. This harness loads the project's own env exactly as tier3-run.sh
# does (load_project_env: config.env plus the active set's overlay), against a COPY of the install
# and the codeline, and then runs the gate under test. No model is called and nothing is spent.
#
#   ./run.sh [install-dir] [project] [set]
#
# Exits non-zero if a gate misbehaves, printing what it saw.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_INSTALL="${1:-/home/bradleyjerome/projects/ai/regintel-pipeline}"
PROJECT="${2:-regintel}"
SET_NAME="${3:-openrouter}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gates-offline-XXXXXX")"
echo "[gates] work dir: $WORK"

# 1. the install and the codeline, copied — never the originals
mkdir -p "$WORK/install"
tar -C "$SRC_INSTALL" -cf - --exclude='orchestrations/logs' --exclude='node_modules' --exclude='.git' orchestrations 2>/dev/null \
  | tar -C "$WORK/install" -xf -
mkdir -p "$WORK/install/orchestrations/logs"
# THE ENGINE UNDER TEST, on the install's state. ENGINE_UNDER_TEST=<an epam-cli checkout> replaces the
# copied install's engine (scripts, plugins, engine config, templates, ecosystems) and keeps its
# state (projects, agents, logs) — so a fix is proven on the real state BEFORE it is released.
if [ -n "${ENGINE_UNDER_TEST:-}" ]; then
  for _d in orchestrations/scripts orchestrations/plugins orchestrations/config orchestrations/prompts/templates orchestrations/ecosystems; do
    rm -rf "$WORK/install/$_d" && cp -a "$ENGINE_UNDER_TEST/$_d" "$WORK/install/$_d" || { echo "[gates] could not install $_d under test"; exit 3; }
  done
  echo "[gates] engine under test: $ENGINE_UNDER_TEST ($(git -C "$ENGINE_UNDER_TEST" rev-parse --short HEAD 2>/dev/null)+working tree)"
fi
SRC_CODELINE="$(grep -E '^OUTPUT_DIR=' "$SRC_INSTALL/orchestrations/projects/$PROJECT/config.env" | cut -d= -f2-)"
cp -a "$SRC_CODELINE" "$WORK/codeline"

# 2. the run state a resume keeps — the baseline SHA above all
for _k in phase-baseline-sha.txt story-rung story-retry-state agent-ladder; do
  [ -e "$SRC_INSTALL/orchestrations/logs/$_k" ] && cp -a "$SRC_INSTALL/orchestrations/logs/$_k" "$WORK/install/orchestrations/logs/" 2>/dev/null || true
done

# 3. THE PROJECT'S OWN ENVIRONMENT, loaded the way the launcher loads it
SCRIPT_DIR="$WORK/install/orchestrations/scripts"
PROJ_DIR="$WORK/install/orchestrations/projects/$PROJECT"
# shellcheck source=/dev/null
set -a
[ -f "$SRC_INSTALL/.env" ] && . "$SRC_INSTALL/.env"
[ -f "$PROJ_DIR/config.env" ] && . "$PROJ_DIR/config.env"
[ -f "$PROJ_DIR/config.${SET_NAME}.env" ] && . "$PROJ_DIR/config.${SET_NAME}.env"
set +a
export PROJECT_ROOT="$WORK/codeline"
export OUTPUT_DIR="$WORK/codeline"
export LOG_DIR="$WORK/install/orchestrations/logs"
export AUTOMATION_DIR="$WORK/install/orchestrations"
export SCRIPT_DIR
export EPAM_PROJECT_CONFIG_DIR="$PROJ_DIR"
export EPAM_PROVIDER_SET="$SET_NAME"
export NODE_BIN="${NODE_BIN:-node}"

# THE CODE AS A RUN LOADS IT. This sourced lib/tsc-baseline-gate.sh alone, so it saw the one
# section-aware _run_project_verification while every real process ran a later copy that dropped the
# section: this harness said "baseline subtracted" while live runs built an EMPTY baseline and blamed
# every story (2026-09-24). claude.sh, sourced, defines exactly what a run defines and stops
# (it ends with `if (return 0); then return 0; fi`).
# claude.sh runs under set -e; this harness does its own error handling.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/claude.sh" >/dev/null 2>&1
set +e

rc=0
echo "== the codeline's own suite, as the pipeline runs it =="
_cur="$(mktemp)"
_run_project_verification "$PROJECT_ROOT" test > "$_cur" 2>&1; _cur_exit=$?
_n_failed=$(grep -c '^FAILED' "$_cur" 2>/dev/null); echo "  suite exit=$_cur_exit, ${_n_failed:-0} FAILED line(s), $(wc -c < "$_cur") bytes"
# THE SUITE MUST HAVE RUN. Asked for the `test` section, a copy of _run_project_verification that
# dropped it ran the typecheck: exit 0, nothing printed — and every check below passed vacuously
# ("no new failures") while live runs blamed every story for inherited failures (2026-09-24).
if [ ! -s "$_cur" ]; then
  echo "FAIL  the test section produced no output — the declared test suite did not run (was the section dropped?)"
  exit 1
fi

echo "== the baseline the pipeline would subtract =="
_sha="$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)"
echo "  baseline sha: ${_sha:-<none declared>}"
_delta="$(baseline_new_failures "$PROJECT_ROOT" "$NODE_BIN" "$LOG_DIR" test "$_cur")"; _delta_rc=$?
_cache="$LOG_DIR/baseline-failures-test-${_sha:0:12}.txt"
_n_ids=$([ -f "$_cache" ] && grep -c '[^[:space:]]' "$_cache" 2>/dev/null); echo "  cache: $([ -f "$_cache" ] && wc -c < "$_cache" || echo 'absent') bytes, ${_n_ids:-0} id(s)"
echo "  delta rc=$_delta_rc ($([ "$_delta_rc" -eq 0 ] && echo 'no NEW failures — a story would NOT be blamed' || echo 'new failures — a story WOULD be blamed'))"

# THE ASSERTION THIS HARNESS EXISTS FOR. A codeline whose suite fails, judged against a baseline
# taken at a commit whose suite fails the same way, must yield NO new failures. Anything else
# charges a story for what it inherited — which is what blocked REGI-002 twice.
# A delta may legitimately be non-empty: a genuinely new failure IS the story's. What must never
# happen is a baseline id reappearing in the delta — that is an inherited failure charged to
# whoever ran last, which is what blocked REGI-002 twice.
_leaked=0
if [ -f "$_cache" ]; then
    while IFS= read -r _bid; do
        [ -n "$_bid" ] || continue
        if printf '%s' "$_delta" | grep -Fq "$_bid"; then
            echo "  LEAKED: $_bid is in the baseline AND in the delta"
            _leaked=$((_leaked + 1))
        fi
    done < "$_cache"
fi
if [ "$_leaked" -ne 0 ]; then
    echo "FAIL  $_leaked pre-existing failure(s) were reported as NEW — a story would be blamed for them"
    rc=1
elif [ ! -f "$_cache" ] && [ "$_cur_exit" -ne 0 ]; then
    echo "FAIL  no baseline was built at all, so every pre-existing failure is charged to the story"
    rc=1
else
    echo "PASS  every baseline failure is subtracted; the delta holds only genuinely new failures"
    printf '%s\n' "$_delta" | grep -c '[^[:space:]]' | sed 's/^/      new failures: /'
fi
rm -f "$_cur"
echo "[gates] kept for inspection: $WORK"
exit $rc
