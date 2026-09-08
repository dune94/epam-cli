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

# ensure_shared_bind_mount <dir...> — a mount BOTH the host and the container write.
#
# ./spool is the boundary between the containerised API and runner-host.js, which runs ON THE
# HOST. The compose file states it: "a host process must own it". So the container-ownership
# remap that is correct for ./data (a container-private database) is WRONG here — applying it
# took the directory away from the host runner, which died on
#
#   EACCES: mkdir '.../launch-dashboard/spool/requests'
#
# and the install reported "runner-host failed to start". Caused by the ownership fix itself, on
# the next install after it landed.
#
# Ownership stays with the host user; the mode is widened so the container's mapped uid — which
# owns nothing here — can still write. Podman only: under docker the two uids are the same and
# nothing needs widening.
ensure_shared_bind_mount() {
    local _rt
    _rt=$(container_runtime) || return $?
    [ "$_rt" = "podman" ] || return 0

    local _d _rc=0
    for _d in "$@"; do
        [ -n "$_d" ] || continue
        if [ ! -d "$_d" ]; then
            echo "[container-runtime] cannot share '$_d' — not a directory" >&2
            _rc=1
            continue
        fi

        # OWNERSHIP BACK TO THE HOST FIRST. After a container-ownership remap the host user does
        # not own this directory, so `chmod` returns EPERM and changes nothing — that is how the
        # first correction shipped broken and the next install failed identically. uid 0 INSIDE
        # the user namespace is the host user, so this is the exact inverse of the remap.
        podman unshare chown -R 0:0 "$_d" 2>/dev/null || true

        # Then widen, so the container's mapped uid — which owns nothing here — can still write.
        chmod -R a+rwX "$_d" 2>/dev/null || true

        # VERIFIED, NOT ASSUMED. Both failures above were silent; the install only learned of them
        # when runner-host.js died on EACCES minutes later. A probe costs nothing and turns a
        # silent no-op into a named install failure.
        if : > "$_d/.epam-share-probe" 2>/dev/null; then
            rm -f "$_d/.epam-share-probe" 2>/dev/null || true
        else
            echo "[container-runtime] '$_d' is still not writable by the host — runner-host.js needs it" >&2
            _rc=1
        fi
    done
    return "$_rc"
}

# compose_services_running <project> — is this project's stack ACTUALLY up?
#
# `up` EXITING 0 IS NOT A RUNNING STACK. podman-compose returns 0 with containers left in state
# `created`: live 2026-09-07, six of eight sat there with their own error already recorded —
# "rootlessport listen tcp 0.0.0.0:8092: bind: address already in use" — because a previous
# install still held the ports. The installer believed the stack was up, the port-collision retry
# never fired (it had no failure to retry on), and the health check then passed against the OTHER
# install's services on those same ports. The install reported "✓ ready" over two containers.
#
# Prints each container that is not running, WITH the runtime's own error text — both so the
# operator is told the cause, and so install.sh's retry can match 'address already in use' and
# step to the next port offset, which is the fix it already knows how to apply.
compose_services_running() {
    local _proj="$1" _rt _rc=0 _seen=0 _line _name _state _err
    [ -n "$_proj" ] || return 2
    _rt=$(container_runtime) || return $?

    while IFS='|' read -r _name _state; do
        [ -n "$_name" ] || continue
        _seen=$((_seen + 1))
        case "$_state" in
            running|Running|Up*) : ;;
            *)
                _err="$("$_rt" inspect "$_name" --format '{{.State.Error}}' 2>/dev/null)"
                echo "[container-runtime] $_name is '$_state'${_err:+ — $_err}" >&2
                _rc=1
                ;;
        esac
    done <<EOF
$("$_rt" ps -a --filter "label=com.docker.compose.project=$_proj" --format '{{.Names}}|{{.State}}' 2>/dev/null)
EOF

    if [ "$_seen" = "0" ]; then
        echo "[container-runtime] project '$_proj' has no containers at all — nothing was created" >&2
        return 1
    fi
    return "$_rc"
}

# purge_project <project> — remove everything this compose project still owns, and SAY what stayed.
#
# `compose down` is not always enough: containers stuck in `created` (see
# compose_services_running) can survive it, and the previous uninstall reported a non-zero `down`
# as "nothing to remove or already gone" — the most reassuring wording available for the case
# where nothing was removed. Live 2026-09-07 that left EIGHT containers and TWO networks on the
# machine, which then held the ports the next install needed, so a fresh install validated itself
# against a previous install's services.
#
# Label-scoped, never a blanket prune: compose stamps every container and network it creates with
# com.docker.compose.project, so this can only ever touch this exact project.
purge_project() {
    local _proj="$1" _rt _ids _nets _left
    [ -n "$_proj" ] || return 2
    _rt=$(container_runtime) || return $?

    # ONE AT A TIME. A single `rm -f id1 id2 id3` stops at the first container it cannot remove
    # and leaves the rest — live 2026-09-07 that took 8 leftovers down to 4 and reported failure,
    # while removing each one individually succeeded. A stubborn container must not shelter the
    # others: its error is reported and the sweep continues.
    local _id
    for _id in $("$_rt" ps -aq --filter "label=com.docker.compose.project=$_proj" 2>/dev/null); do
        [ -n "$_id" ] || continue
        # CASCADE. compose writes depends_on as a container dependency (podman records it as
        # --requires), so removing a depended-on container is refused: "has dependent containers
        # which must be removed before it". Live 2026-09-07 that left 11 containers behind across
        # four installs, still holding 8099/8092/3100/3001 for the next one. --depend removes the
        # dependents with it; docker has no such flag and needs none, so the plain form follows.
        "$_rt" rm -f -t 2 --depend "$_id" >/dev/null 2>&1 \
            || "$_rt" rm -f -t 2 "$_id" >/dev/null 2>&1 \
            || echo "[container-runtime] could not remove $_id: $("$_rt" rm -f -t 2 "$_id" 2>&1 | head -1)" >&2
    done

    for _id in $("$_rt" network ls --quiet --filter "label=com.docker.compose.project=$_proj" 2>/dev/null); do
        [ -n "$_id" ] || continue
        "$_rt" network rm "$_id" >/dev/null 2>&1 || true
    done

    # VERIFIED. "Removed" is a claim about the machine, not about a command's exit code.
    _left="$("$_rt" ps -aq --filter "label=com.docker.compose.project=$_proj" 2>/dev/null)"
    if [ -n "$_left" ]; then
        echo "[container-runtime] $_proj still has containers after purge: $(echo $_left | tr '\n' ' ')" >&2
        return 1
    fi
    return 0
}

# find_free_port <start> [span] — the first port from <start> that is ACTUALLY free.
#
# THE INSTALLER OWNS THIS. Ports were derived from a hash offset and assumed free; a clash only
# surfaced when compose failed — and compose does not always fail. Live 2026-09-07 it exited 0
# over six containers stuck in `created` with "address already in use", so nothing ever
# discovered the clash and the install reported ready over a two-container stack.
#
# Free means "binding it succeeds", not "arithmetic says so". Probed with the runtime-agnostic
# tools every install already needs; a port nothing can bind is never returned.
find_free_port() {
    local _port="${1:-}" _span="${2:-40}" _tries=0
    case "$_port" in ''|*[!0-9]*) echo "[container-runtime] find_free_port: '$1' is not a port" >&2; return 2 ;; esac

    while [ "$_tries" -lt "$_span" ]; do
        if ! _port_in_use "$_port"; then
            printf '%s' "$_port"
            return 0
        fi
        _port=$((_port + 1))
        _tries=$((_tries + 1))
    done
    echo "[container-runtime] no free port in ${1}..$((_port - 1)) — every candidate is in use" >&2
    return 1
}

# _port_in_use <port> — is anything listening there RIGHT NOW?
#
# ss/lsof see every listener on the host, including other installs' containers, which is the case
# that matters: a port held by a previous install is exactly what breaks a new one. Falls back to
# an actual bind attempt so a machine with neither tool still gets a real answer.
_port_in_use() {
    local _p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH "sport = :$_p" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$_p" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0
        return 1
    fi
    # Last resort: try to bind it ourselves. Bash's /dev/tcp only CONNECTS, so a refused
    # connection means nothing is listening.
    (exec 3<>"/dev/tcp/127.0.0.1/$_p") >/dev/null 2>&1 && { exec 3<&- 3>&-; return 0; }
    return 1
}

# reconcile_env_endpoint <env-file> <KEY> <value> — make the .env name what this install allocated.
#
# The tree an install leaves behind must not name a port it does not own. Live 2026-09-07 an
# install allocated Langfuse on 3120 while its .env still read LANGFUSE_BASE_URL=localhost:3100 —
# a PREVIOUS install's Langfuse. langfuse-emit.js resolves `env.LANGFUSE_BASE_URL ||
# allocatedBase()`, so the stale literal wins and every trace from the run lands in another
# install's database. Copied .env files are the normal case, not an edge one.
reconcile_env_endpoint() {
    local _file="$1" _key="$2" _val="$3" _tmp
    [ -n "$_file" ] && [ -n "$_key" ] && [ -n "$_val" ] || return 2
    [ -f "$_file" ] || return 0

    if grep -qE "^${_key}=" "$_file" 2>/dev/null; then
        grep -qE "^${_key}=${_val}$" "$_file" 2>/dev/null && return 0
        _tmp="$(mktemp "${TMPDIR:-/tmp}/envrec-XXXXXX")"
        awk -v k="$_key" -v v="$_val" -F= '
            $1 == k { print k "=" v; next }
            { print }
        ' "$_file" > "$_tmp" 2>/dev/null && cat "$_tmp" > "$_file"
        rm -f "$_tmp" 2>/dev/null
    else
        printf '%s=%s\n' "$_key" "$_val" >> "$_file"
    fi
    return 0
}
