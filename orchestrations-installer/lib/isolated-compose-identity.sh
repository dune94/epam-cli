# isolated-compose-identity.sh — a compose project name and subnet, NEVER hand-picked.
#
# Two installs of this tree on the same machine (a dev checkout and a dogfood copy, say) must be
# able to run their docker services at the same time without colliding. That needs BOTH a distinct
# compose PROJECT NAME (containers/networks are namespaced by it) and a distinct SUBNET — compose
# networks default to the same hardcoded CIDR regardless of project name, so two projects still
# collide the moment a second one calls `up` unless one declares a different subnet. Hit directly
# during manual testing: "Pool overlaps with other one on this address space".
#
# DETERMINISTIC, NOT RANDOM: the SAME root path must produce the SAME first choice every time, so a
# re-install lands on identical identity rather than silently drifting to a new one. Random values
# would make "is this the same install as before" unanswerable from the outside.

# isolated_project_name <root> <suffix>
#
# Prefixed "test-install-amsd-pipeline-" — every install.sh-managed stack is, by definition, an
# INSTALL (never the hand-run dev checkout, which never calls this function and instead carries its
# own literal "dev-amsd-pipeline"/"dev-amsd-pipeline-launch" project names via each compose file's
# top-level `name:` key). The two prefixes can never collide by construction, which is what makes
# `install.sh --uninstall` structurally incapable of touching the dev environment.
isolated_project_name() {
    local _root="$1" _suffix="$2" _h
    _h=$(printf '%s' "$_root" | cksum | cut -d' ' -f1)
    printf 'test-install-amsd-pipeline-%s-%s' "$_suffix" "$((_h % 1000000))"
}

# isolated_subnet_candidates <root>
#
# A short, deterministic SEQUENCE, not a single value: the first choice is stable per root, but an
# unrelated stack already sitting on that exact CIDR must not be a dead end — the caller tries each
# candidate in turn and stops at the first that is not already claimed.
#
# Range 172.19-172.28: avoids 172.16-18 (this host's own docker bridge and several already-running
# stacks sit there) and 172.29-31 (this repo's own compose defaults and prior manual allocations).
# THE SUBNETS THIS INSTALL MAY TRY, BEST FIRST, NEVER ONE THE BOX ALREADY HOLDS.
#
# Live 2026-09-06 installing v1.50 into pipeline-tests-28: the observability stack took the first
# candidate and the launch dashboard exhausted the SAME five — one held by its own sibling, four by
# installs already running. The install reported incomplete, and a second attempt failed
# identically, because nothing in the loop could learn from the first.
#
# TWO DEFECTS, BOTH HERE. Five candidates out of a ten-wide window means six coexisting stacks
# exhaust the list by arithmetic. And nothing asked the daemon what was allocated, so subnets that
# could not possibly work were offered again and again, each costing a failed `compose up`.
#
# ASK, THEN OFFER. Docker knows what it holds and the answer is free. A held subnet is not a
# candidate. The daemon is consulted with a short timeout and its absence is not fatal: with no
# answer the full list is offered, which is exactly today's behaviour, and the retry loop above
# still sorts it out.
#
# DETERMINISTIC ORDER IS KEPT. The seed still decides where the walk STARTS, so an install lands on
# the same network every time it is repaired — an install that moves its network on every repair is
# its own kind of defect. The seed decides the order; the daemon decides what is possible.
#
# THE SPACE IS 172.16–172.31 THEN 10.100–10.199: 116 candidates, all inside RFC1918 ranges Docker
# itself defaults to, so nothing here can collide with a corporate VPN range that 192.168 might.
isolated_subnet_candidates() {
    local _root="$1" _h _base _i _v _held=""
    _h=$(printf '%s' "$_root" | cksum | cut -d' ' -f1)

    # WHAT THE DAEMON ALREADY HAS. Never fatal: no docker, no daemon, or a slow one all fall
    # through to the unfiltered list rather than leaving the installer with nothing to try.
    if command -v docker >/dev/null 2>&1; then
        _held=$(timeout 15 docker network ls --quiet 2>/dev/null \
            | timeout 20 xargs -r docker network inspect \
                --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
            | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)
    fi

    _offer() {
        case "$_held" in
            *"$1"*) return 0 ;;   # already on this box — not a candidate
        esac
        printf '%s\n' "$1"
    }

    # 172.16.0.0/16 .. 172.31.0.0/16, starting at the seed's own offset and wrapping.
    _base=$(( _h % 16 ))
    for _i in $(seq 0 15); do
        _v=$(( 16 + ((_base + _i) % 16) ))
        _offer "172.${_v}.0.0/16"
    done
    # A DEEP RESERVE. Sixteen /16s is enough for any plausible number of installs, but exhausting
    # them used to mean a failed install with no next step; 10.100–10.199 costs nothing to offer.
    _base=$(( _h % 100 ))
    for _i in $(seq 0 99); do
        _v=$(( 100 + ((_base + _i) % 100) ))
        _offer "10.${_v}.0.0/16"
    done
}
