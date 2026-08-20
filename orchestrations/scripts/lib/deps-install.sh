# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# deps-install.sh — provision a codeline's dependencies, naming no ecosystem.
#
# This was nine `if` branches inside run-agent-orchestration.sh, one per ecosystem the engine
# happened to know, each with a hardcoded command. A tenth ecosystem meant a tenth branch in an
# 11,000-line file — the ecosystems table again, expressed as control flow.
#
# WHAT MOVED OUT: which manifest means which package manager, and what that manager's install
# command is. Those are facts about an ecosystem and live with its provider.
#
# WHAT STAYED, because it is POLICY and policy is ours:
#
#   - THE DEFAULT IS NON-DESTRUCTIVE. `npm ci` and its equivalents delete the vendored tree before
#     installing. On 2026-07-28 a repair selected one because a lockfile existed, wiped a working
#     1,530-package install, hit a 401 on a private dependency, aborted, and left the codeline with
#     an EMPTY node_modules — strictly worse than it found it. We did not create these repositories
#     and cannot restore what we remove, so a clean install is opt-in via DEPS_CLEAN_INSTALL=1.
#
#   - A REPAIR THAT LEAVES LESS THAN IT FOUND IS DESTRUCTION, not a successful install. Counted
#     before and after through the provider's declared installDir, so it generalises to any
#     ecosystem that vendors in-tree.
#
#   - NOTHING PLANNED IS NOT SUCCESS. A codeline whose ecosystem no provider recognises is reported
#     as such; the caller must not read silence as "dependencies are fine".
#
#   detect_and_install_dependencies <codeline_root> <node_bin>   → 0 all good, 1 something is wrong
# ─────────────────────────────────────────────────────────────────────────────

detect_and_install_dependencies() {
    local codeline_root="$1"
    local node_bin="$2"
    local _ok=1
    local _ran_any=0

    local _plan_script="${SCRIPT_DIR:-}/lib/handlers/install-plan.js"
    if [ ! -f "$_plan_script" ]; then
        warning "  [deps-install] install-plan.js not found — cannot determine how to provision $codeline_root"
        return 1
    fi

    local _plan _plan_rc=0
    _plan=$("$node_bin" "$_plan_script" "$codeline_root" "${DEPS_CLEAN_INSTALL:-0}" 2>&1) || _plan_rc=$?
    if [ "$_plan_rc" -ne 0 ]; then
        warning "  [deps-install] could not plan an install for $codeline_root"
        printf '%s\n' "$_plan" | sed 's/^/    /' >&2
        return 1
    fi

    local _manifest _install_dir _cmd
    while IFS=$'\t' read -r _manifest _install_dir _cmd; do
        [ -z "${_manifest:-}" ] && continue
        [ -z "${_cmd:-}" ] && continue
        _ran_any=1

        # WHAT WAS THERE BEFORE, so the repair can be judged rather than trusted.
        local _before=0
        if [ "$_install_dir" != "-" ] && [ -d "$codeline_root/$_install_dir" ]; then
            _before=$(find "$codeline_root/$_install_dir" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
        fi

        local _log; _log=$(mktemp)
        ( cd "$codeline_root" && eval "$_cmd" ) > "$_log" 2>&1
        local _rc=$?

        local _after=0
        if [ "$_install_dir" != "-" ] && [ -d "$codeline_root/$_install_dir" ]; then
            _after=$(find "$codeline_root/$_install_dir" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
        fi

        if [ "$_rc" -eq 0 ]; then
            success "  [deps-install] $_manifest: '$_cmd' succeeded in $codeline_root"
        else
            warning "  [deps-install] $_manifest: '$_cmd' FAILED in $codeline_root — tail below (often a private-registry auth wall):"
            tail -10 "$_log" >&2
            _ok=0
        fi

        # Silence here is how a working codeline became an empty one and the next gate was handed
        # the wreckage as if it were a tree.
        if [ "$_install_dir" != "-" ] && [ "$_after" -lt "$_before" ]; then
            error "  [deps-install] REPAIR DESTROYED WHAT IT FOUND in $codeline_root/$_install_dir: $_before entries -> $_after"
            error "    The codeline is now in a worse state than before this ran, and its gates cannot run."
            error "    Reinstall its dependencies before relying on any result from this run."
            _ok=0
        fi
        rm -f "$_log"
    done <<< "$_plan"

    if [ "$_ran_any" -eq 0 ]; then
        info "  [deps-install] $codeline_root declares no manifest any provider recognises — nothing was installed"
    fi

    [ "$_ok" -eq 1 ] && return 0
    return 1
}
