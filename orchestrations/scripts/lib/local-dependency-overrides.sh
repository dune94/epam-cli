#!/usr/bin/env bash
# local-dependency-overrides.sh — a codeline's declared local package sources, packed and installed.
# Moved from brownfield-preflight-reset.sh (2026-10-02) so a brownfield LANE can also run it at its
# start: a site lane must build against its provider codeline's CURRENT checkout, after the provider's
# lane has merged its change (AMSD-2974). Sourced by brownfield-preflight-reset.sh and
# run-agent-orchestration.sh; uses the caller's log/warn when defined.
command -v log  >/dev/null 2>&1 || log()  { echo "[local-deps] $*"; }
command -v warn >/dev/null 2>&1 || warn() { echo "[local-deps] WARN: $*" >&2; }

# _apply_local_dependency_overrides <project_root>
#
# Re-provisions any packages this codeline declares in dependency-check.json's
# localDependencyOverrides — for the case a registry is genuinely unreachable
# (private-registry auth unavailable, e.g. GitHub Packages with no GH_TOKEN)
# but the real package source is already cloned locally as another codeline.
# Live case, 2026-07-31: @metrolinx/cx-shared's GitHub Packages 401 left
# next.upexpress.com's node_modules half-installed and every build broken.
#
# MUST run on every call, regardless of which git-reset branch above fired —
# node_modules can be broken independently of git state (first-ever run, or
# something else wiped it), and git status alone can never tell.
#
# `npm install <pkg>@file:<tarball> --no-save`: installs into node_modules
# WITHOUT touching package.json/package-lock.json — the standing rule is
# NEVER commit to a client repo, not even locally (feedback_no_client_repo_
# writes_or_hardcoding.md), so this must never produce a tracked-file change
# that would need committing to survive. Untracked node_modules survives
# `git reset --hard` on its own; re-running this every launch is what makes
# the fix durable without ever touching the client's git index or history.
#
# Packs the source via `npm pack` FIRST rather than referencing the source
# directory directly with `file:<dir>`. Confirmed live (2026-07-31): a
# direct directory reference pulls in the ENTIRE directory verbatim,
# including the source package's own node_modules — for cx-shared that
# meant its own copy of react/react-dom (a declared peerDependency, meant to
# resolve to the CONSUMER's copy), producing a dual-React-instance "Invalid
# hook call"-shaped test failure. `npm pack` correctly respects the source
# package's own `files` field (excludes node_modules/src, includes only the
# built output), which is exactly the shape a real registry install would
# have produced.
_apply_local_dependency_overrides() {
    local _proj_root="$1"
    local _codeline_name
    _codeline_name="$(basename "$_proj_root")"
    local _config="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_config" ] || return 0

    local _overrides_json
    _overrides_json=$(jq -c --arg cl "$_codeline_name" \
        '[(.localDependencyOverrides // [])[] | select(.codeline == $cl)]' \
        "$_config" 2>/dev/null) || return 0
    [ -z "$_overrides_json" ] && return 0

    local _pack_dir
    _pack_dir=$(mktemp -d)

    # Batched into ONE npm install call: separate sequential `npm install X`
    # then `npm install Y` calls each independently prune the OTHER package as
    # "extraneous" (unlisted in package.json, since --no-save deliberately
    # never adds it there) — confirmed live, a 2nd override silently deleted
    # the 1st. One call, one dependency-tree resolution, both survive.
    local _n
    _n=$(echo "$_overrides_json" | jq 'length' 2>/dev/null || echo 0)
    local _i=0 _specs=() _names=()
    while [ "$_i" -lt "$_n" ]; do
        local _pkg _src
        _pkg=$(echo "$_overrides_json" | jq -r ".[$_i].package")
        _src=$(echo "$_overrides_json" | jq -r ".[$_i].localSourcePath")
        # A relative source is a sibling codeline: resolved against the folder this codeline lives in.
        case "$_src" in /*) ;; *) _src="$(cd "$_proj_root/.." && pwd)/$_src" ;; esac
        if [ ! -e "$_src" ]; then
            warn "local dependency override for $_codeline_name: localSourcePath '$_src' does not exist — skipping $_pkg"
        elif [ -f "$_src" ]; then
            # Already a tarball — use it directly, no packing needed.
            log "re-provisioning $_pkg for $_codeline_name from local tarball: $_src"
            _specs+=("${_pkg}@file:${_src}")
            _names+=("$_pkg")
        else
            log "re-provisioning $_pkg for $_codeline_name from local source: $_src"
            local _before _tgz
            _before=$(ls "$_pack_dir" 2>/dev/null)
            if ! ( cd "$_src" && npm pack --silent --pack-destination "$_pack_dir" >/dev/null 2>&1 ); then
                warn "  npm pack failed for $_pkg at $_src — skipping"
            else
                _tgz=$(ls "$_pack_dir" 2>/dev/null | comm -13 <(echo "$_before" | sort) - | head -1)
                if [ -z "$_tgz" ] || [ ! -f "$_pack_dir/$_tgz" ]; then
                    warn "  npm pack produced no tarball for $_pkg at $_src — skipping"
                else
                    _specs+=("${_pkg}@file:${_pack_dir}/${_tgz}")
                    _names+=("$_pkg")
                fi
            fi
        fi
        _i=$(( _i + 1 ))
    done

    if [ "${#_specs[@]}" -gt 0 ]; then
        if ( cd "$_proj_root" && npm install "${_specs[@]}" --no-audit --no-fund --no-save >/dev/null 2>&1 ); then
            log "  provisioned from local source: ${_names[*]}"
        else
            warn "  npm install for ${_names[*]} from local source failed — codeline may still be broken"
        fi
    fi
    rm -rf "$_pack_dir" 2>/dev/null || true
}
