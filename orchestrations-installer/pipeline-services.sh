#!/bin/bash
# pipeline-services.sh — restart the docker stacks + runner-host without a full re-install.
#
#   ./orchestrations-installer/pipeline-services.sh --stop [--dest PATH]   pause everything
#   ./orchestrations-installer/pipeline-services.sh --start [--dest PATH]  bring it back up
#
# WHY THIS EXISTS, SEPARATE FROM install.sh AND --uninstall: neither fits "the machine went down
# (WSL restart) or the operator wants to bounce services, and nothing about the install itself
# needs to change." install.sh re-packages a ref and rebuilds; --uninstall deletes the docker
# footprint (containers, network, volumes, images) — DATA LOSS, not what a restart needs. --stop
# here only ever runs `down` (never `-v`, never `--rmi`) and stops the host runner-host process;
# --start only ever runs `up -d` and starts it — the SAME identity as the original install, not a
# fresh roll.
#
# THE IDENTITY MUST BE THE SAME ACROSS A STOP/START. `down` (no -v) still removes the network, so
# a later `up` with no env at all would fall back to the compose file's own default subnet/ports
# and could collide with the dev stack or another install — install.sh persists the subnet/ports/
# project names it actually resolved to .pipeline-services-state.env on every successful bring-up;
# this script reads that back rather than re-deciding anything.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
NODE_BIN="${NODE_BIN:-node}"
ACTION=""
DEST=""

_ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
_warn() { printf '\033[0;33m  !\033[0m %s\n' "$*"; }
_bad()  { printf '\033[0;31m  ✗\033[0m %s\n' "$*" >&2; }
_head() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --start)  ACTION=start; shift ;;
        --stop)   ACTION=stop; shift ;;
        --dest)   DEST="${2:-}"; shift 2 ;;
        --help|-h)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) _bad "unknown option '$1'"; exit 1 ;;
    esac
done
if [ -z "$ACTION" ]; then
    _bad "one of --start or --stop is required"
    exit 1
fi
if [ -n "$DEST" ]; then
    ROOT="$(cd "$DEST" 2>/dev/null && pwd)"
    if [ -z "$ROOT" ]; then
        _bad "--dest $DEST does not exist"
        exit 1
    fi
else
    ROOT="$(cd "$ROOT" && pwd)"
fi

STATE_FILE="$ROOT/.pipeline-services-state.env"
LAUNCH_DIR="$ROOT/launch-dashboard"
OBS_COMPOSE="$ROOT/docker-compose.observability.yml"
LAUNCH_COMPOSE="$LAUNCH_DIR/docker-compose.yml"

if [ ! -f "$STATE_FILE" ]; then
    _bad "no $STATE_FILE — this install has never brought its docker stacks up successfully (run install.sh first)"
    exit 1
fi
set -a
. "$STATE_FILE"
set +a

if [ -f "$HERE/lib/container-runtime.sh" ]; then
    . "$HERE/lib/container-runtime.sh"
else
    _bad "missing $HERE/lib/container-runtime.sh — cannot resolve a container runtime"
    exit 1
fi
. "$HERE/lib/runner-host-control.sh"

FAILED=0

case "$ACTION" in
stop)
    _head "Stopping"
    if CONTAINER_RUNTIME="$(container_runtime 2>/dev/null)"; then
        for _SPEC in "$OBS_COMPOSE:${OBS_PROJECT:-}" "$LAUNCH_COMPOSE:${LAUNCH_PROJECT:-}"; do
            _FILE="${_SPEC%%:*}"; _PROJECT="${_SPEC##*:}"
            [ -f "$_FILE" ] || continue
            [ -n "$_PROJECT" ] || { _warn "no saved project name for $_FILE — was it ever brought up?"; continue; }
            # NEVER -v, NEVER --rmi: this is a pause, not an uninstall. Volumes (Langfuse's
            # postgres/clickhouse, launch-api's own sqlite) and built images both survive.
            if (cd "$(dirname "$_FILE")" && container_compose -f "$(basename "$_FILE")" -p "$_PROJECT" down --remove-orphans) >/dev/null 2>&1; then
                _ok "stopped $_PROJECT (data preserved)"
            else
                _ok "$_PROJECT: nothing to stop or already gone"
            fi
        done
    else
        _ok "no container runtime found — nothing docker-related to stop"
    fi
    if [ -f "$LAUNCH_DIR/.runner-host.pid" ]; then
        _RH_PID="$(cat "$LAUNCH_DIR/.runner-host.pid" 2>/dev/null)"
        if stop_runner_host "$LAUNCH_DIR" && [ -n "$_RH_PID" ]; then
            _ok "stopped runner-host (pid $_RH_PID)"
        else
            _ok "runner-host: nothing to stop or already gone"
        fi
    else
        _ok "runner-host: nothing to stop or already gone"
    fi
    ;;

start)
    _head "Starting"
    if ! CONTAINER_RUNTIME="$(container_runtime 2>/dev/null)"; then
        _bad "no container runtime found — cannot start the docker stacks"
        FAILED=1
    else
        if [ -f "$OBS_COMPOSE" ] && [ -n "${OBS_PROJECT:-}" ]; then
            if (cd "$ROOT" && EPAM_OBS_SUBNET="${OBS_SUBNET:-}" \
                    EPAM_OBS_CLICKHOUSE_PORT="${OBS_CLICKHOUSE_PORT:-}" \
                    EPAM_OBS_LANGFUSE_PORT="${OBS_LANGFUSE_PORT:-}" \
                    EPAM_OBS_DASHBOARD_PORT="${OBS_DASHBOARD_PORT:-}" \
                    EPAM_OBS_GRAFANA_PORT="${OBS_GRAFANA_PORT:-}" \
                    container_compose -f "$OBS_COMPOSE" -p "$OBS_PROJECT" up -d) >/dev/null 2>&1; then
                _ok "$OBS_PROJECT is up (subnet: ${OBS_SUBNET:-default})"
            else
                _bad "failed to bring $OBS_PROJECT back up"
                FAILED=1
            fi
        fi
        if [ -f "$LAUNCH_COMPOSE" ] && [ -n "${LAUNCH_PROJECT:-}" ]; then
            if (cd "$LAUNCH_DIR" && LAUNCH_SUBNET="${LAUNCH_SUBNET:-}" LAUNCH_UI_PORT="${LAUNCH_UI_PORT:-}" \
                    container_compose -f "docker-compose.yml" -p "$LAUNCH_PROJECT" up -d) >/dev/null 2>&1; then
                _ok "$LAUNCH_PROJECT is up (port: ${LAUNCH_UI_PORT:-default})"
            else
                _bad "failed to bring $LAUNCH_PROJECT back up"
                FAILED=1
            fi
        fi
    fi
    if [ -f "$LAUNCH_DIR/backend/src/runner-host.js" ]; then
        start_runner_host "$ROOT" "$LAUNCH_DIR" || FAILED=1
    fi
    ;;
esac

_head "Result"
if [ "$FAILED" = "1" ]; then
    _bad "some services did not $ACTION cleanly — see above"
    exit 1
fi
_ok "done"
