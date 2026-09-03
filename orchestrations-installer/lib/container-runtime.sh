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

    "$_rt" compose "$@"
}
