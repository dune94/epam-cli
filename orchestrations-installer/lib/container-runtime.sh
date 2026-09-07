# container-runtime.sh — ONE place resolves the container runtime, and callers ask.
#
# Three call sites invoke compose and every one hardcoded `docker`: install.sh,
# dashboard-health-check.sh and pre-run-reset.sh. Podman is already first-class elsewhere in this
# codebase — run-agent-orchestration.sh:4075 and lib/sandbox-invoke.sh:42 both do
# `for _rt in docker podman` — so the pattern existed and the compose path never adopted it.
#
# WHY PODMAN MATTERS FOR PACKAGING: Docker Desktop needs a paid subscription above 250 employees or
# $10M revenue. A procurement conversation, not a technical preference, is what stalls a client
# rollout. Podman on Windows runs on WSL2 too, so it is not a fourth platform.
#
# THREE COPIES OF A RESOLUTION RULE IS HOW THEY DRIFT — the same defect class as the writer and the
# gate each holding their own idea of what a test file is, which shipped a fix with no test.

# The runtimes this code can actually drive, in the order to try. A declaration, not a preference
# expressed in an if-statement.
: "${EPAM_CONTAINER_RUNTIMES:=docker podman}"

# container_runtime — print the runtime to use, or fail loudly.
#
# NEVER prints an empty string on failure: a caller that reads one goes on to run `"" compose ...`,
# which fails somewhere far from here with a message about nothing.
container_runtime() {
    local _declared="${EPAM_CONTAINER_RUNTIME:-}"
    if [ -n "$_declared" ]; then
        local _known=0 _r
        for _r in $EPAM_CONTAINER_RUNTIMES; do
            [ "$_declared" = "$_r" ] && { _known=1; break; }
        done
        if [ "$_known" = "0" ]; then
            echo "[container-runtime] unsupported runtime '$_declared' — this code can drive: $EPAM_CONTAINER_RUNTIMES" >&2
            return 2
        fi
        printf '%s' "$_declared"
        return 0
    fi

    local _rt
    for _rt in $EPAM_CONTAINER_RUNTIMES; do
        if command -v "$_rt" >/dev/null 2>&1; then
            printf '%s' "$_rt"
            return 0
        fi
    done
    echo "[container-runtime] none of these is on PATH: $EPAM_CONTAINER_RUNTIMES" >&2
    return 1
}

# container_compose <args...> — run compose on the resolved runtime.
#
# REFUSES WITHOUT -f. `docker compose up -d` with no file is what made install.sh report "docker is
# up" having started nothing: there is no docker-compose.yml at the repo root, only named files, and
# the failure was swallowed by `|| true`. Requiring the file here means no caller can reintroduce it.
container_compose() {
    local _rt
    _rt=$(container_runtime) || return $?

    local _has_f=0 _a
    for _a in "$@"; do
        [ "$_a" = "-f" ] || [ "$_a" = "--file" ] && { _has_f=1; break; }
    done
    if [ "$_has_f" = "0" ]; then
        echo "[container-runtime] refusing to run compose with no -f: there is no compose file at the repo root, only named ones" >&2
        return 2
    fi

    # PODMAN COMPOSE IS A WRAPPER, NOT AN IMPLEMENTATION. It hands the file to an EXTERNAL
    # provider, and left to choose it picks docker-compose — which speaks the Docker API over a
    # daemon socket. Rootless podman starts no such socket and neither does this installer, so
    # live (2026-09-07, a clean podman install) every stack died on its first image with
    # "failed to connect to the docker API at unix://…/podman.sock", having created zero
    # containers. podman-compose drives the podman CLI directly and needs no daemon.
    #
    # := so an operator who has a socket and prefers docker-compose keeps their choice.
    if [ "$_rt" = "podman" ]; then
        : "${PODMAN_COMPOSE_PROVIDER:=podman-compose}"
        export PODMAN_COMPOSE_PROVIDER
        _podman_runtime_dir
    fi

    "$_rt" compose "$@"
}

# ensure_bind_mount_ownership <dir...> — make bind-mount sources writable by the container.
#
# install.sh pre-creates ./data and ./spool as the HOST user, and that is correct for docker:
# host uid 1000 IS container uid 1000, so the container owns what it mounts.
#
# Under ROOTLESS PODMAN it is not. The host user maps to uid 0 INSIDE the user namespace and the
# container's uid maps to a subuid owning nothing, so the same mkdir reproduces exactly the
# failure install.sh's own comment was written for: "unable to open database file", launch-api
# crash-looping, and nginx reporting "host not found in upstream" downstream of that crash.
#
# `podman unshare` runs the chown INSIDE the namespace, so the uid given is the one the container
# sees. Docker needs none of this and gets none of it — the ownership is already right there.
ensure_bind_mount_ownership() {
    local _rt
    _rt=$(container_runtime) || return $?
    [ "$_rt" = "podman" ] || return 0

    local _uid="${LAUNCH_UID:-1000}"
    case "$_uid" in ''|*[!0-9]*) _uid=1000 ;; esac

    local _d
    for _d in "$@"; do
        [ -n "$_d" ] || continue
        podman unshare chown -R "${_uid}:${_uid}" "$_d" 2>/dev/null || {
            echo "[container-runtime] could not remap $_d into the user namespace — a rootless container may not be able to write it" >&2
        }
    done
    return 0
}

# _podman_runtime_dir — give podman a runtime directory that actually has systemd in it.
#
# Podman starts aardvark-dns (container DNS) and healthchecks as TRANSIENT SYSTEMD UNITS, found
# through $XDG_RUNTIME_DIR. A tool that exports its own value breaks both: `fnm` (a Node version
# manager) sets XDG_RUNTIME_DIR=/tmp/fnm-runtime, which has no systemd/, and podman says
#
#   unable to get systemd connection to add healthchecks: lstat /tmp/fnm-runtime/systemd:
#   no such file or directory
#
# once, at debug level, then carries on WITH NO DNS SERVER. Every name lookup between containers
# then fails, which live looked like three unrelated bugs: nginx "host not found in upstream
# launch-api", langfuse "Can't reach database server at postgres:5432", and grafana failing to
# resolve grafana.com to fetch a plugin.
#
# Only replaces a value that cannot work, only with one that does, and never invents a path.
# EPAM_RUNTIME_DIR_PROBE exists so this is testable without a real login session.
_podman_runtime_dir() {
    [ -d "${XDG_RUNTIME_DIR:-}/systemd" ] && return 0

    local _real="${EPAM_RUNTIME_DIR_PROBE:-/run/user/$(id -u 2>/dev/null)}"
    [ -d "$_real/systemd" ] || return 0

    XDG_RUNTIME_DIR="$_real"
    export XDG_RUNTIME_DIR
    return 0
}
