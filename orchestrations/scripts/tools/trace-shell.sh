#!/usr/bin/env bash
# TRACE ONE TARGET, IN SECONDS, AND ACCUMULATE.
#
# The whole-suite collector was the wrong shape: one monolithic run measuring everything, taking
# minutes, and unusable in a normal edit-test loop. This traces exactly what you name — one test
# file, one directory, one bats file — and MERGES its result into the accumulated shell lcov.
#
# Coverage therefore grows the way tests are written: a file at a time, each run costing what that
# one file costs. Nothing here runs a suite.
#
#   trace-shell.sh test/unit/orchestration/pre-run-reset-without-prd.test.ts
#   trace-shell.sh test/shell/steps/the-reset-copies-a-run-before-it-deletes-it.bats
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
# MANY TARGETS, ONE PROCESS. Tracing files one at a time pays vitest's ~3s startup per file, so 43
# files cost two minutes of startup to collect thirty seconds of trace. Passed together they cost one.
[ "$#" -gt 0 ] || { echo "usage: trace-shell.sh <test-file|dir|.bats> [more...]" >&2; exit 2; }
TARGETS=("$@")
TARGET="$1"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
ACC="${SHELL_COVERAGE_ACC:-$ROOT/coverage/.shell-trace-lines}"
OUT="${SHELL_COVERAGE_OUT:-$ROOT/coverage/lcov.shell.info}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/traces" "$(dirname "$ACC")"
touch "$ACC"

cat > "$W/on.sh" <<'ENABLER'
if [ -n "${SHCOV_TRACES:-}" ]; then
  exec 9>>"$SHCOV_TRACES/$$.trace" 2>/dev/null || true
  BASH_XTRACEFD=9
  PS4='@@${BASH_SOURCE}:${LINENO}@@
'
  set -x
fi
ENABLER

export SHCOV_TRACES="$W/traces" BASH_ENV="$W/on.sh"
if [[ "$TARGET" == *.bats ]]; then
    bash "$ROOT/orchestrations/scripts/run-shell-tests.sh" "$TARGET" >"$W/run.log" 2>&1
else
    "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run --maxWorkers=2 "${TARGETS[@]}" >"$W/run.log" 2>&1
fi
_rc=$?
unset SHCOV_TRACES BASH_ENV

# Everything traced, reduced to unique file:line and merged with what previous runs found.
cat "$W/traces"/*.trace 2>/dev/null | grep -o '@@[^@]*@@' | sort -u >> "$ACC"
sort -u "$ACC" -o "$ACC"

"$NODE_BIN" "$ROOT/orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js" "$ACC" "$OUT" 2>&1 | tail -1
echo "[trace-shell] ${#TARGETS[@]} target(s) (exit $_rc) — accumulated $(wc -l < "$ACC") unique shell lines"
