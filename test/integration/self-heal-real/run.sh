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
mkdir -p "$WORK/install/orchestrations/logs"
: > "$WORK/install/orchestrations/logs/healing-events.jsonl"

# 2. the codeline, copied at its current commit
SRC_CODELINE="$(grep -E '^OUTPUT_DIR=' "$SRC_INSTALL/orchestrations/projects/regintel/config.env" | cut -d= -f2-)"
CODELINE="$WORK/codeline"
git clone -q "$SRC_CODELINE" "$CODELINE" || cp -a "$SRC_CODELINE" "$CODELINE"

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
PROJECT_ROOT="$CODELINE" PRD_FILE="$PRD" \
EPAM_PROJECT_CONFIG_DIR="$WORK/install/orchestrations/projects/regintel" \
EPAM_PROVIDER_SET=openrouter EPAM_MAX_RETRIES=2 \
  "${HOME}/.claude/bin/bounded" bash "$WORK/install/orchestrations/scripts/claude.sh" "$STORY" \
  > "$RUNLOG" 2>&1
echo "[harness] loop exited with $? — asserting"
WORK="$WORK" RUNLOG="$RUNLOG" STORY="$STORY" bash "$HERE/assert.sh"
echo "[harness] kept for inspection: $WORK"
