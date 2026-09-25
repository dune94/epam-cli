#!/usr/bin/env bash
# THE REAL LOOP, ON THE REAL STORY THAT FAILED.
#
# REGI-009a, effort low (maxIter=6, maxOutTok=8192), is the story that burned four attempts and
# ~$5.50 on 2026-09-22 while healing-events.jsonl stayed 0 bytes. This runs THAT story, through
# THE REAL pipeline, in a copy of the already-provisioned install — so the roster, profiles and
# 43 minted prompts are the ones the run used, and the prompt cache is warm.
#
# Nothing is mocked, stubbed or replayed. The install and codeline are copied; yours are untouched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_INSTALL="${SELFHEAL_INSTALL:-/home/bradleyjerome/projects/ai/regintel-pipeline}"
STORY="${SELFHEAL_STORY:-REGI-009a}"
MUTATE=0; [ "${1:-}" = "--mutate" ] && MUTATE=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/self-heal-real-XXXXXX")"
echo "[harness] work dir: $WORK   story: $STORY"

# 1. the provisioned install, copied (logs excluded: this run gets its own)
mkdir -p "$WORK/install"
tar -C "$SRC_INSTALL" -cf - --exclude='orchestrations/logs' --exclude='node_modules' --exclude='.git' \
    orchestrations 2>/dev/null | tar -C "$WORK/install" -xf -
# AND THE INSTALL'S OWN CLI. A run executes <install>/dist/epam.js (scripts/bin/epam), never the
# machine-wide `epam` — so a copy without dist/ could not call a model at all (2026-09-25; it had
# silently borrowed the source install's CLI through the global shim). dist is copied; the
# dependencies it loads are the source install's, read-only.
cp -a "$SRC_INSTALL/dist" "$WORK/install/dist"
ln -s "$SRC_INSTALL/node_modules" "$WORK/install/node_modules"
mkdir -p "$WORK/install/orchestrations/logs"
: > "$WORK/install/orchestrations/logs/healing-events.jsonl"
# THE RUN STATE A RESUME KEEPS. The logs directory was excluded wholesale, so the copy began with
# no phase-baseline-sha.txt — and without it the baseline is never computed, every pre-existing
# failure is charged to whichever story ran, and no scoped fix can converge. The harness was
# testing a state no real run is ever in. A resume keeps these ledgers (pre-run-reset.sh), so the
# copy does too: the baseline SHA, the per-story rungs and retry state, and the review findings.
for _keep in phase-baseline-sha.txt story-rung story-retry-state agent-ladder; do
  [ -e "$SRC_INSTALL/orchestrations/logs/$_keep" ] \
    && cp -a "$SRC_INSTALL/orchestrations/logs/$_keep" "$WORK/install/orchestrations/logs/" 2>/dev/null || true
done
# A RE-QUEUED STORY STARTS ITS LADDER AFRESH. The PRD copy below marks the story pending — which
# is what a resume's remediation does to a FAILED story — and that remediation also clears its
# rung and retry state (_prd_remediate_impl.py, _ladder_afresh). Carrying the spent rungs without
# clearing them reproduced a state no resume produces: REGI-009a resumed at retry_count=8, its
# ladder exhausted by the 402s, and the loop ended without running a single attempt.
rm -f "$WORK/install/orchestrations/logs/story-rung/${STORY}".* 2>/dev/null || true
rm -f "$WORK/install/orchestrations/logs/story-retry-state/${STORY}".* 2>/dev/null || true
rm -f "$WORK/install/orchestrations/logs/agent-ladder/"*".${STORY}" 2>/dev/null || true

for _f in "$SRC_INSTALL"/orchestrations/logs/review-*.json; do
  [ -e "$_f" ] && cp -a "$_f" "$WORK/install/orchestrations/logs/" 2>/dev/null || true
done

# 2. the codeline, copied at its current commit
SRC_CODELINE="$(grep -E '^OUTPUT_DIR=' "$SRC_INSTALL/orchestrations/projects/regintel/config.env" | cut -d= -f2-)"
CODELINE="$WORK/codeline"
# THE CODELINE AS IT IS ON DISK, NOT AS GIT SEES IT.
#
# `git clone` carries tracked files only, so the copy arrived without .venv (98MB, provisioned by
# the pipeline's own dependency step), .epam/, pytest.ini and the caches. The declared test command
# then resolved to a SYSTEM pytest that cannot import the package, and the analyst correctly
# diagnosed it twice — spending three real attempts on an environment the harness had broken:
#
#   [FailureAnalyst] Verification ran bare `pytest` (console script), which omits the codeline
#                    root from sys.path — Target=tool
#
# Copying the directory reproduces the environment under test instead of rebuilding it, which the
# harness is not entitled to do: provisioning is the pipeline's job, and a harness that provisions
# differently is testing something the run never does.
cp -a "$SRC_CODELINE" "$CODELINE"

# 3. THE MUTATION ARM — re-impose the guard, to prove this test fails without the fix
HEAL="$WORK/install/orchestrations/scripts/lib/failure-healing.sh"
if [ "$MUTATE" = "1" ]; then
  _b="$(md5sum "$HEAL" | cut -d' ' -f1)"
  perl -0pi -e 's/^(run_failure_analyst\(\) \{\n)/$1    [ -z "\${VERIFICATION_FAILURE:-}" ] \&\& return 0\n/m' "$HEAL"
  _a="$(md5sum "$HEAL" | cut -d' ' -f1)"
  [ "$_b" = "$_a" ] && { echo "[harness] MUTATION DID NOT APPLY — aborting rather than reporting a false result"; exit 3; }
  echo "[harness] mutation applied ($_b -> $_a)"
fi

# 4. this run's own PRD copy, with the story pending
PRD="$WORK/prd.json"
python3 - "$SRC_INSTALL/orchestrations/regintel-prd.json" "$PRD" "$STORY" <<'PY'
import json,sys
src,dst,sid=sys.argv[1:4]
d=json.load(open(src))
for s in d['stories']:
    if s['id']==sid:
        s['status']='pending'; s.pop('reviewStatus',None)
json.dump(d,open(dst,'w'),indent=1)
PY

# 5. run the real loop for that one story
RUNLOG="$WORK/run.log"
echo "[harness] running — log: $RUNLOG"
set -a
[ -f "$SRC_INSTALL/.env" ] && . "$SRC_INSTALL/.env"
# THE PROJECT'S OWN DECLARATIONS, BOTH HALVES. tier3-run.sh loads config.env and the active set's
# overlay before any seam runs; claude.sh does not, so a harness that skips them runs a different
# pipeline than the one that failed (no ORCH_GATE_PROVIDER, a different model, a different ladder).
. "$WORK/install/orchestrations/projects/regintel/config.env"
. "$WORK/install/orchestrations/projects/regintel/config.openrouter.env"
set +a
# the copies, not the originals
PRD_FILE="$PRD"; OUTPUT_DIR="$CODELINE"
# THE STARVED PROVISIONING THAT PRODUCED THE FAILURE. REGI-009a ran at effort low — 6 iterations,
# 8192 output tokens — and was truncated at its cap on four attempts. The cap is declared by the
# effort tier and overridable per run, so the condition is reproduced by declaring it, not by
# simulating a truncation: a real model, on real work, with the room the run actually gave it.
# SELFHEAL_CAP overrides it; unset means "whatever the tier declares", i.e. the run's own value.
[ -n "${SELFHEAL_CAP:-}" ]   && export EPAM_EFFORT_LOW_MAX_OUTPUT_TOKENS="$SELFHEAL_CAP"
[ -n "${SELFHEAL_ITERS:-}" ] && export EPAM_EFFORT_LOW_MAX_ITERATIONS="$SELFHEAL_ITERS"
PROJECT_ROOT="$CODELINE" PRD_FILE="$PRD" \
EPAM_PROJECT_CONFIG_DIR="$WORK/install/orchestrations/projects/regintel" \
EPAM_PROVIDER_SET=openrouter EPAM_MAX_RETRIES=2 \
  "${HOME}/.claude/bin/bounded" bash "$WORK/install/orchestrations/scripts/claude.sh" "$STORY" \
  > "$RUNLOG" 2>&1
_rc=$?
# WAIT FOR THE PROCESS TREE, NOT JUST THE SCRIPT. claude.sh returns while its writer and analyst
# children are still running — the same orphaning that kept an `epam run` alive after the
# orchestrator was killed on 2026-09-22. Asserting at that moment read an EMPTY healing log and a
# single Effort[final] line from a run that went on to record three attempts and three healing
# events: a FAIL that was the harness's, not the engine's.
_waited=0
while pgrep -f "claude.sh ${STORY}" >/dev/null 2>&1 || pgrep -f "$WORK/install/orchestrations/scripts" >/dev/null 2>&1; do
  sleep 5; _waited=$((_waited + 5))
  if [ "$_waited" -ge 21600 ]; then echo "[harness] children still running after 6h — refusing to assert on a half-written run"; exit 4; fi
done
echo "[harness] loop exited with $_rc; children settled after ${_waited}s — asserting"
WORK="$WORK" RUNLOG="$RUNLOG" STORY="$STORY" bash "$HERE/assert.sh"
echo "[harness] kept for inspection: $WORK"
