#!/usr/bin/env bash
# THE CLAUDE WORKFLOWS, INSTALLED BESIDE THE PIPELINE (install.sh --workflows). The amsd-pipeline-workflow package drives
# this pipeline as Claude workflows and calls this install's own scripts, so it is installed INTO the install tree:
# <root>/claude-workflows/, with install.json naming the install it belongs to.
#
# THE VERSION IS DECLARED, NOT WRITTEN HERE: orchestrations/config/claude-workflows.json {package, version} — the release
# the pipeline release was tested with. `--workflows <file.tgz>` installs a local package instead (a build not yet
# published). Callers provide _ok and _bad.

# install_claude_workflows <root> <pinned|file.tgz|local> <check: 0|1>
install_claude_workflows() {
    local root="$1" spec="$2" check="$3"
    local decl="$root/orchestrations/config/claude-workflows.json" dir="$root/claude-workflows"
    local pkg ver have src tmp
    pkg=$(jq -r '.package // empty' "$decl" 2>/dev/null); ver=$(jq -r '.version // empty' "$decl" 2>/dev/null)

    if [ "$check" = "1" ]; then
        [ -f "$dir/package.json" ] || { _bad "claude workflows: not installed in $dir"; return 1; }
        have=$(jq -r '.version // empty' "$dir/package.json")
        if [ "$spec" = "pinned" ] && [ "$have" != "$ver" ]; then
            _bad "claude workflows: $have installed, this release pins ${ver:-nothing} ($decl)"; return 1
        fi
        [ "$(jq -r '.install // empty' "$dir/install.json" 2>/dev/null)" = "$root" ] || { _bad "claude workflows: $dir/install.json does not name $root"; return 1; }
        _ok "claude workflows $have — $dir"
        return 0
    fi

    tmp=$(mktemp -d)
    if [ "$spec" = "pinned" ]; then
        if [ -z "$pkg" ] || [ -z "$ver" ]; then _bad "claude workflows: $decl declares no package and version"; rm -rf "$tmp"; return 1; fi
        ( cd "$tmp" && npm pack --silent "$pkg@$ver" >/dev/null ) || { _bad "claude workflows: npm could not fetch $pkg@$ver"; rm -rf "$tmp"; return 1; }
        src=$(ls "$tmp"/*.tgz 2>/dev/null | head -1)
    else
        src="$spec"
    fi
    if [ ! -f "$src" ]; then _bad "claude workflows: no package at '$src'"; rm -rf "$tmp"; return 1; fi
    mkdir -p "$tmp/x"
    tar -xzf "$src" -C "$tmp/x" --strip-components=1 && [ -f "$tmp/x/package.json" ] || { _bad "claude workflows: '$src' is not a package"; rm -rf "$tmp"; return 1; }
    jq -n --arg i "$root" '{install: $i}' > "$tmp/x/install.json"
    rm -rf "$dir" && mv "$tmp/x" "$dir"
    rm -rf "$tmp"
    _ok "claude workflows $(jq -r .version "$dir/package.json") — $dir"
}
