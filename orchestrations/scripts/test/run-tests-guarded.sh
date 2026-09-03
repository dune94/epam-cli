#!/usr/bin/env bash
# run-tests-guarded.sh — sharded + memory-guarded test runner.
#
# 2026-09-03: `vitest run test/unit/orchestration/` (873 files, up to 6 parallel forked workers,
# many spawning bash/git/node subprocesses, one starting a docker-compose stack) exceeded this
# box's 14GB WSL memory ceiling and froze the VM hard enough to need a manual restart.
#
# vitest.config.ts's own MAX_WORKERS/--max-old-space-size cap only bounds each worker's OWN V8
# heap — nothing for the child processes those workers spawn, or for docker containers a test
# starts. Two OS-level guards were tried and REJECTED after being empirically disproven, not
# assumed to work:
#   - systemd-run --user --scope -p MemoryMax=...: the cgroup's memory.current stayed flat at
#     ~9MB while the guarded process demonstrably allocated 2GB (verified: printed allocation
#     progress while polling memory.current directly). Memory accounting is not reliable for a
#     delegated --user scope in this WSL2 setup. Do not trust it.
#   - ulimit -v (virtual address space): correctly rejects allocation in a synthetic test, but a
#     real `vitest`/esbuild/WASM toolchain reserves address space far beyond physical RAM just to
#     START — it still threw "Cannot allocate Wasm memory" at a 16GB ceiling on a 14GB machine.
#     Unusable for this toolchain.
#
# What DOES work, verified: /proc/meminfo's MemAvailable is the real WSL2-VM-wide number (it is
# what `free -h` reads too) — not a delegated, possibly-broken per-cgroup view. This script polls
# it directly and SIGKILLs the whole batch's process group the moment it drops below a floor,
# rather than trusting any accounting layer in between.
#
# Defense in depth, since no single layer above was trustworthy on its own:
#   1. TRUE sequential batching — small groups of files, one batch running at a time. Peak
#      concurrent subprocess fan-out is bounded by batch size, not by the full file count.
#   2. A low worker count per batch (not vitest.config's shared-run default).
#   3. A memory check BEFORE each batch starts (refuse to start already low).
#   4. A polling watchdog DURING each batch that kills on collapse.
set -uo pipefail
# MONITOR MODE, NOT setsid. setsid silently forks an extra layer when the CALLING shell is
# already a process-group leader (true in this harness's own shell) — $! then captures the
# setsid WRAPPER's pid, which exits almost immediately, and `kill -TERM -- "-$pid"` fails with
# "No such process": verified by testing directly, the watchdog would have been a no-op in
# exactly the scenario it exists for. `set -m` makes bash's OWN job control give a background
# job its own process group with PGID == its PID — verified: a TERM to that PGID reaches the
# job and every descendant, including one that traps TERM itself.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
VITEST="$ROOT/node_modules/.bin/vitest"

TARGET="${1:-test/unit/orchestration/}"
BATCH_SIZE="${TEST_GUARD_BATCH_SIZE:-15}"
WORKERS="${TEST_GUARD_WORKERS:-2}"
MIN_AVAILABLE_KB="${TEST_GUARD_MIN_AVAILABLE_KB:-2500000}"
POLL_SECS="${TEST_GUARD_POLL_SECS:-3}"
PRESTART_PAUSE_SECS="${TEST_GUARD_PRESTART_PAUSE_SECS:-20}"

cd "$ROOT" || exit 1

available_kb() {
  awk '/MemAvailable/{print $2}' /proc/meminfo
}

mapfile -t FILES < <(find "$TARGET" -name '*.test.ts' | sort)
TOTAL=${#FILES[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "[guarded-test] no *.test.ts files found under $TARGET" >&2
  exit 1
fi
TOTAL_BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "[guarded-test] $TOTAL files under $TARGET, $TOTAL_BATCHES batches of up to $BATCH_SIZE, $WORKERS workers/batch, kill floor ${MIN_AVAILABLE_KB}KB available" >&2

OVERALL_FAIL=0
BATCH_NUM=0
for ((i = 0; i < TOTAL; i += BATCH_SIZE)); do
  BATCH_NUM=$((BATCH_NUM + 1))
  BATCH=("${FILES[@]:i:BATCH_SIZE}")

  avail="$(available_kb)"
  if [ "$avail" -lt "$MIN_AVAILABLE_KB" ]; then
    echo "[guarded-test] ${avail}KB available before batch $BATCH_NUM/$TOTAL_BATCHES — pausing ${PRESTART_PAUSE_SECS}s" >&2
    sleep "$PRESTART_PAUSE_SECS"
    avail="$(available_kb)"
    if [ "$avail" -lt "$MIN_AVAILABLE_KB" ]; then
      echo "[guarded-test] still low (${avail}KB) — ABORTING the remaining run rather than risk the VM" >&2
      exit 2
    fi
  fi

  echo "[guarded-test] batch $BATCH_NUM/$TOTAL_BATCHES: ${#BATCH[@]} files (${avail}KB available)" >&2

  # Backgrounded under `set -m`: this job gets its OWN process group, PGID == TEST_PID — verified
  # above. The watchdog kills by process group, reaching every descendant, not just this pid.
  "$NODE_BIN" "$VITEST" run "${BATCH[@]}" \
    --poolOptions.forks.maxForks="$WORKERS" --poolOptions.forks.minForks=1 &
  TEST_PID=$!

  KILLED=0
  while kill -0 "$TEST_PID" 2>/dev/null; do
    avail="$(available_kb)"
    if [ "$avail" -lt "$MIN_AVAILABLE_KB" ]; then
      echo "[guarded-test] MEMORY GUARD TRIPPED at ${avail}KB available — killing batch $BATCH_NUM's process group (pgid $TEST_PID)" >&2
      kill -TERM -- "-$TEST_PID" 2>/dev/null
      sleep 2
      kill -KILL -- "-$TEST_PID" 2>/dev/null
      KILLED=1
      break
    fi
    sleep "$POLL_SECS"
  done

  wait "$TEST_PID" 2>/dev/null
  RC=$?
  if [ "$KILLED" = "1" ]; then
    echo "[guarded-test] batch $BATCH_NUM KILLED by the memory guard — treat as failed; narrow BATCH_SIZE or investigate which file in it grows unbounded: ${BATCH[*]}" >&2
    OVERALL_FAIL=1
  elif [ "$RC" != "0" ]; then
    echo "[guarded-test] batch $BATCH_NUM failed (exit $RC)" >&2
    OVERALL_FAIL=1
  fi
done

echo "[guarded-test] done. $TOTAL_BATCHES batches, overall $([ "$OVERALL_FAIL" = "0" ] && echo PASS || echo FAIL)" >&2
exit $OVERALL_FAIL
