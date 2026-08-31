#!/usr/bin/env bash
# THE DASHBOARDS ARE PART OF THE RUN, SO PRE-FLIGHT BRINGS THEM UP.
#
# The dashboards are how a run is watched while it happens: what is running now, what each agent
# cost, which stories moved. A run that starts with them down is a run nobody can see, and the
# operator finds that out hours in with the money already spent.
#
# ENSURE, NOT REPORT. A check that only complains leaves the operator doing by hand what the
# pipeline can do itself, so this restarts the dashboard container and re-checks before failing.
# It fails only when they are STILL down afterwards — at which point starting the run would mean
# flying blind.
#
# PROBE THE PAGE, NOT prd.json. The old check curled ${DASH}/prd.json, a file the dashboards no
# longer read: it could fail while every dashboard served perfectly, and pass while they were
# blank. The endpoint checked has to be the thing the operator actually opens.

# curl ALREADY prints 000 when it cannot connect, and it also exits non-zero. An `|| echo 000`
# on top of that appended a SECOND 000, making the value "000000" — which is a perfectly valid
# integer zero, so `-lt 400` passed and a dashboard on a dead port was reported as serving.
_dashboard_code() {
    local _c
    _c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null)"
    [ -n "$_c" ] || _c="000"
    printf '%s' "$_c"
}

# SERVING means a page came back, not merely that the socket accepted. A container that boots
# but answers 502 is exactly the state a reachability check calls healthy.
_dashboard_serving() {
    case "$1" in
        2[0-9][0-9]|3[0-9][0-9]) return 0 ;;
        *) return 1 ;;
    esac
}

# FILE SCOPE, DELIBERATELY. The probe is separate from the verdict so the verdict can be tested
# without a network: this sandbox cannot curl even its own loopback, and the defect that shipped was
# in the VERDICT (a dead port scoring as serving), not in curl. A test sources this file, replaces
# _dashboard_code, and exercises every status the real one can return.

# ensure_dashboards_up <url> [--no-fix]
#   0  the dashboards are serving (possibly after a restart)
#   1  they are down and could not be brought up
ensure_dashboards_up() {
    local _url="${1:-}" _nofix="${2:-}"
    local _dir _code
    _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [ -z "$_url" ]; then
        echo "  ✗ dashboard: no URL configured — services.json has no dashboard entry" >&2
        return 1
    fi

    _code="$(_dashboard_code "$_url")"
    if _dashboard_serving "$_code"; then
        echo "  ✓ dashboard serving at ${_url} (HTTP ${_code})"
        return 0
    fi

    if [ "$_nofix" = "--no-fix" ] || [ -n "${EPAM_DASHBOARD_NO_FIX:-}" ]; then
        echo "  ✗ dashboard NOT serving at ${_url} (HTTP ${_code})" >&2
        return 1
    fi

    echo "  … dashboard not serving at ${_url} (HTTP ${_code}) — restarting it before giving up" >&2
    if [ -x "$_dir/../dashboard-health-check.sh" ]; then
        bash "$_dir/../dashboard-health-check.sh" --fix >/dev/null 2>&1 || true
    else
        echo "  ✗ dashboard-health-check.sh is missing, so there is no way to restart them" >&2
        return 1
    fi

    _code="$(_dashboard_code "$_url")"
    if _dashboard_serving "$_code"; then
        echo "  ✓ dashboard serving at ${_url} after a restart (HTTP ${_code})"
        return 0
    fi

    echo "  ✗ dashboard STILL not serving at ${_url} after a restart (HTTP ${_code}) — a run started now cannot be watched" >&2
    return 1
}
