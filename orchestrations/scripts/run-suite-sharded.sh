#!/usr/bin/env bash
# THE SUITE IN PIECES, BECAUSE IN ONE PIECE IT CANNOT BE RUN.
#
# 1,198 test files in a single vitest invocation exhausted a 14GB WSL box and took the machine
# down — three times. A suite that cannot be run informs nothing, so its failures went unmeasured
# and six seam defects reached production while 1,198 files passed over them.
#
# Each shard is a SEPARATE PROCESS. Memory is reclaimed between shards by the OS rather than by
# hoping a worker releases it, so the peak is one shard's worth, not the suite's. A shard that dies
# names itself and the next one still runs.
#
# Results are written into the REPO, never /tmp: a WSL restart has already destroyed one set of
# measurements that had to be taken again.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO" || exit 1

NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
SHARDS="${EPAM_TEST_SHARDS:-12}"
OUT="${EPAM_TEST_REPORT_DIR:-$REPO/test/reports}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
SUMMARY="$OUT/suite-$STAMP.tsv"
printf 'shard\tstatus\tfiles\ttests_passed\ttests_failed\n' > "$SUMMARY"

_only="${1:-}"                       # optional: run a single shard, e.g. `run-suite-sharded.sh 3`

for i in $(seq 1 "$SHARDS"); do
  [ -n "$_only" ] && [ "$_only" != "$i" ] && continue
  log="$OUT/shard-$i-of-$SHARDS-$STAMP.log"
  echo "[suite] shard $i/$SHARDS -> $log"
  "$NODE_BIN" ./node_modules/.bin/vitest run --shard="$i/$SHARDS" --reporter=basic > "$log" 2>&1
  rc=$?
  # Read vitest's own totals line, not a guess at it: "Tests  109 failed | 956 passed (1066)".
  _t=$(grep -E '^\s*Tests ' "$log" | tail -1)
  _f=$(grep -E '^\s*Test Files ' "$log" | tail -1)
  files=$(printf '%s' "$_f" | grep -oE '\(([0-9]+)\)' | tr -d '()' || echo 0)
  passed=$(printf '%s' "$_t" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
  failed=$(printf '%s' "$_t" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
  case $rc in
    0) st=pass ;;
    134|137) st=OOM ;;               # the shard, not the machine — that is the point
    *) st=fail ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\n' "$i" "$st" "${files:-0}" "${passed:-0}" "${failed:-0}" >> "$SUMMARY"
  echo "[suite]   $st  passed=${passed:-0} failed=${failed:-0}"
done

echo ""
echo "[suite] summary -> $SUMMARY"
column -t "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
