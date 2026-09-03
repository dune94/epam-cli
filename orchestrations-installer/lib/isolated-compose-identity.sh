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
isolated_subnet_candidates() {
    local _root="$1" _h _base _i _v
    _h=$(printf '%s' "$_root" | cksum | cut -d' ' -f1)
    _base=$(( 19 + (_h % 10) ))
    for _i in 0 1 2 3 4; do
        _v=$(( _base + _i ))
        [ "$_v" -gt 28 ] && _v=$(( _v - 10 ))
        printf '172.%d.0.0/16\n' "$_v"
    done
}
