#!/usr/bin/env bash
# NOTHING THIS REPO LAUNCHES MAY TAKE THE MACHINE.
#
# Twice in one day a process started here consumed the host: an unsharded vitest run (1,198 files,
# no per-worker heap ceiling) and a MockServer container started ad-hoc with no memory limit and a
# JVM entitled to 75% of RAM, which grew to 7.1GB of a 14GB box. Both were bounded by nothing, so
# both ran until the OS chose a victim — and on WSL the victim is the whole environment, taking
# docker, Langfuse and the user's session with it.
#
# The rule is not "be careful". A long-running command is placed in its own cgroup scope with a
# memory ceiling, so exceeding it kills THE COMMAND and names it, leaving the machine alone.
#
#   run-bounded.sh [--share N] -- <command> [args...]
#
# The ceiling is a SHARE OF THE MACHINE, read at launch — a bigger box grants more, a smaller one
# less, and no number is frozen here. MemoryHigh throttles first (reclaim, not death) so a command
# that merely spikes is slowed rather than killed; MemoryMax is the hard stop behind it.
set -uo pipefail

_share="${EPAM_BOUNDED_SHARE:-40}"          # percent of total RAM this command may use
if [ "${1:-}" = "--share" ]; then _share="$2"; shift 2; fi
[ "${1:-}" = "--" ] && shift
[ $# -eq 0 ] && { echo "usage: run-bounded.sh [--share N] -- <command> [args...]" >&2; exit 2; }

_total_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${_total_kb:-0}" -le 0 ]; then
    echo "[bounded] cannot read MemTotal — refusing to launch unbounded" >&2
    exit 1
fi
_max_mb=$(( _total_kb / 1024 * _share / 100 ))
_high_mb=$(( _max_mb * 80 / 100 ))

if command -v systemd-run >/dev/null 2>&1 && [ -d /sys/fs/cgroup ]; then
    echo "[bounded] ${_share}% of $(( _total_kb / 1024 ))MB -> MemoryHigh=${_high_mb}M MemoryMax=${_max_mb}M : $*" >&2
    # SWAP IS BOUNDED TOO, OR THE CEILING IS ADVISORY.
    #
    # Proven here: a process told to allocate 4GB under a 698MB ceiling allocated all of it. The
    # host never grew — the cgroup held — but the pages went to swap, so the run continued,
    # thrashing, instead of failing. A limit a process can walk around by swapping is a slowdown,
    # not a limit, and a thrashing run is the hang that wastes the operator's time.
    exec systemd-run --user --scope --quiet --collect \
        -p MemoryHigh="${_high_mb}M" -p MemoryMax="${_max_mb}M" -p MemorySwapMax=0 \
        -- "$@"
fi

# NO CGROUPS AVAILABLE: say so rather than pretending. An unbounded run is a decision the operator
# makes knowingly, never one this script makes silently on their behalf.
echo "[bounded] systemd-run/cgroups unavailable — cannot bound '$1'." >&2
echo "[bounded] Set EPAM_BOUNDED_ALLOW_UNBOUNDED=1 to run it anyway." >&2
[ "${EPAM_BOUNDED_ALLOW_UNBOUNDED:-0}" = "1" ] || exit 1
exec "$@"
