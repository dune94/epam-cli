#!/bin/bash
# bounded-exec.sh — nothing the pipeline spawns is entitled to the whole machine.
#
# WHY THIS EXISTS, from the run it cost:
#
# Step 5's regression guard runs the CLIENT's own test command, deliberately, so the engine names
# no runner. On next.gotransit.com that is jest over 3,389 tests. Jest sizes its worker pool from
# os.availableParallelism() — 16 on this host — and the suite took 9.7GB, driving the box to 988MB
# free and 4GB of swap.
#
# The resource damage was not the expensive part. Under that pressure, WHICH interaction tests
# exceeded their 5s timeout varied between attempts. The guard runs three attempts precisely to
# tell a flake from a regression, and RG-DELTA then intersects the failing sets to tolerate a
# pre-existing baseline. Attempt 1 failed one suite, attempts 2 and 3 failed two; the sets
# disagreed; RG-DELTA correctly refused to trust them, and the run hard-failed on three timeouts
# unrelated to the story. ~2.5 hours and ~$17.
#
# So this is a CORRECTNESS control, not merely a resource one: an unbounded suite manufactures the
# instability that defeats the pipeline's own tolerance logic.
#
# ────────────────────────────────────────────────────────────────────────────────────────────────
# WHY CPU AFFINITY, AND NOT A RUNNER FLAG
#
# `--maxWorkers` would mean the engine knowing a runner's arguments, which is exactly what this
# codebase refuses. It also does not survive the shape several metrolinx codelines actually
# declare — `npm --prefix a run test && npm --prefix b run test` — where an appended argument
# reaches only the last link, if it is accepted at all.
#
# availableParallelism() honours CPU affinity (measured on this host: `taskset -c 0-3` reports 4),
# so restricting affinity shrinks the pool with NO change to the command. jest-config's
# getMaxWorkers.js reads exactly that call. Vitest sizes its pool the same way.
#
# Note the limit of this lever: a runner that reads os.cpus().length instead is NOT bounded by it
# (cpus().length still reports every core under taskset). That is a known, stated gap rather than
# a silent one — see the warning path below.
#
# ────────────────────────────────────────────────────────────────────────────────────────────────
# PROBED, NEVER ASSUMED
#
# run-bounded.sh gated on `command -v systemd-run` — the BINARY, which is always present — while
# what it needed was the per-user systemd BUS, which is not. It printed a confident
# "MemoryHigh=... MemoryMax=..." line and then applied nothing, for months. `command -v` answers
# "is it installed"; the question is "does it work here", and only running it answers that.
# So the probe below EXECUTES taskset, and when it cannot bound, it says so and still runs.

# resolve_test_workers — how many test workers this machine can afford right now.
#
# Derived from what is actually available, never a literal: a fixed count is wrong on both a
# laptop and a build server, and wrong again on the same host under different load.
resolve_test_workers() {
    local avail_mb cpus per_worker_mb share_pct budget workers

    # Available memory. The override exists so the derivation itself can be tested with the
    # machine held constant.
    if [ -n "${EPAM_TEST_AVAIL_MB_OVERRIDE:-}" ]; then
        avail_mb="${EPAM_TEST_AVAIL_MB_OVERRIDE}"
    else
        avail_mb="$(free -m 2>/dev/null | awk 'NR==2{print $7}')"
    fi
    # Unknown memory is not an excuse to run unbounded; it is a reason to be conservative.
    case "$avail_mb" in ''|*[!0-9]*) avail_mb=1024 ;; esac

    cpus="$(nproc 2>/dev/null || echo 2)"
    case "$cpus" in ''|*[!0-9]*) cpus=2 ;; esac

    # A jsdom/react test worker measures in the high hundreds of MB. Both figures are policy, and
    # both are overridable, because the right number is a property of the codeline's suite rather
    # than of this engine.
    per_worker_mb="${EPAM_TEST_WORKER_MB:-700}"
    share_pct="${EPAM_TEST_MEM_SHARE_PCT:-60}"
    case "$per_worker_mb" in ''|*[!0-9]*) per_worker_mb=700 ;; esac
    case "$share_pct" in ''|*[!0-9]*) share_pct=60 ;; esac

    budget=$(( avail_mb * share_pct / 100 ))
    workers=$(( budget / per_worker_mb ))

    # Leave the host a core. A run that owns every CPU makes the machine unusable and starves the
    # pipeline's own supervision alongside the suite it is watching.
    local ceiling=$(( cpus - 1 ))
    [ "$ceiling" -lt 1 ] && ceiling=1
    [ "$workers" -gt "$ceiling" ] && workers="$ceiling"
    [ "$workers" -lt 1 ] && workers=1

    printf '%s\n' "$workers"
}

# _affinity_works — can this host actually restrict CPU affinity? Answered by DOING it.
_affinity_works() {
    taskset -c 0 true >/dev/null 2>&1
}

# run_test_bounded <workers> <command...>
#
# Runs the command with its visible parallelism restricted to <workers>. Passes stdout, stderr and
# the exit status through untouched — RG-DELTA parses that output for failing-test identity, and a
# wrapper that swallowed either would disable tolerance or, worse, read a red suite as green.
run_test_bounded() {
    local workers="$1"; shift
    case "$workers" in ''|*[!0-9]*) workers=1 ;; esac
    [ "$workers" -lt 1 ] && workers=1

    if _affinity_works; then
        taskset -c "0-$(( workers - 1 ))" "$@"
        return $?
    fi

    # SAY IT. An unavailable bound that stays quiet is how an operator comes to believe a run is
    # bounded when it is not.
    printf '[bounded-exec] WARNING: CPU affinity is unavailable on this host — the test command is running UNBOUNDED (requested %s workers). A suite that sizes its pool from the host can exhaust it.\n' \
        "$workers" >&2
    "$@"
    return $?
}
