#!/usr/bin/env bash
# codeline-health.sh — assess (and where possible repair) every codeline the run
# is about to work in, ONCE, before any spend.
#
# Live AMSD-2041, 2026-07-28. Discovery resolved three codelines. All three
# declared a test script and a runner; none could resolve one:
#
#   next.gotransit.com   node_modules present, runner NOT resolvable
#   next.upexpress.com   no node_modules
#   next.metrolinx.com   no node_modules
#
# Until that morning Step 5 skipped silently on exactly this, so an unverified
# baseline was accepted once per lane. Making it fail was right, but it fails
# INSIDE the phase — after the spec pass is already paid for. Assessing here
# turns a twenty-minute discovery into a few seconds.
#
# WHY NOT PREPARE THE REPOS BY HAND BEFOREHAND: the codelines are resolved per
# ticket, at runtime, by discovery. Preparing a fixed list would hardcode the
# output of discovery — the same defect one level up. This runs on whatever
# discovery returned.
#
# GENERIC BY CONSTRUCTION. It knows no package manager, no test runner and no
# language. It reads what each codeline DECLARES — a manifest, a lockfile naming
# its package manager — and prepares it accordingly. A codeline that declares
# nothing has nothing to install and is healthy by definition. The next client's
# stack may be none of these things and this must still hold.
#
# Usage:  codeline-health.sh <path> [<path> ...]
# Exit:   0 all healthy (or skipped)   1 one or more unhealthy
#
# Env:
#   SKIP_CODELINE_HEALTH=1       bypass entirely
#   CODELINE_HEALTH_NO_INSTALL=1 assess only, never install (tests, dry runs)
#   CODELINE_HEALTH_NO_PULL=1    assess only, never pull
set -uo pipefail

_ch_log()  { printf '[codeline-health] %s\n' "$*"; }
_ch_warn() { printf '[codeline-health] WARN: %s\n' "$*" >&2; }

if [ "${SKIP_CODELINE_HEALTH:-0}" = "1" ]; then
  _ch_log "skipped (SKIP_CODELINE_HEALTH=1)"
  exit 0
fi

# --root <dir>: the estate. Providers are found across ALL of it, not just the
# lanes this run selected — live AMSD-2041's shared library was a directory
# discovery never picked. Defaults to the parent of the first codeline.
_ch_root_dir=""
if [ "${1:-}" = "--root" ]; then
  _ch_root_dir="${2:-}"
  shift 2
fi

[ "$#" -gt 0 ] || { _ch_warn "no codelines given"; exit 0; }
[ -n "$_ch_root_dir" ] || _ch_root_dir="$(dirname "$1")"

# Package name -> directory, for every manifest in the estate. Built once.
# Nothing here knows a vendor, scope or repository name: it reads the `name`
# field each project declares about itself.
_ch_provider_map=""
if [ -d "$_ch_root_dir" ]; then
  for _ch_cand in "$_ch_root_dir"/*/; do
    [ -f "${_ch_cand}package.json" ] || continue
    _ch_pkg="$("${NODE_BIN:-node}" -e '
      try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name || "")); }
      catch (e) { /* unreadable manifest */ }
    ' "${_ch_cand}package.json" 2>/dev/null)"
    [ -n "$_ch_pkg" ] && _ch_provider_map="${_ch_provider_map}${_ch_pkg}|${_ch_cand%/}"$'\n'
  done
fi

_ch_provider_for() {
  printf '%s' "$_ch_provider_map" | awk -F'|' -v want="$1" '$1==want {print $2; exit}'
}

# Resolve a dependency from the estate when a registry cannot serve it.
#
# Live: every codeline depended on a private package whose registry returned 401,
# so nothing could install and no gate could run — while that package sat in the
# estate, cloned and built.
#
# A DIRECT symlink in the consumer's own node_modules, not `npm link`'s global
# store: nothing then depends on state outside the estate, and because health is
# assessed on every run a link broken by a restart is simply re-made. package.json
# is never touched — the declared dependency is unchanged, only its resolution.
_ch_link_local() {
  local root="$1" pkg="$2" provider="$3"
  local dest="$root/node_modules/$pkg"

  # Never substitute a working copy for a genuinely installed package.
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then return 1; fi

  mkdir -p "$(dirname "$dest")" 2>/dev/null || return 1
  # A dangling or stale link is replaced, which is the restart case.
  [ -L "$dest" ] && rm -f "$dest"
  ln -s "$provider" "$dest" 2>/dev/null || return 1
  _ch_log "  linked $pkg -> $provider (local estate; registry not required)"
  return 0
}

# Which package manager does THIS codeline use? Answered by its own lockfile,
# never assumed. Unknown lockfile => we do not know how to install, so we do not
# pretend to.
_ch_package_manager() {
  local root="$1"
  [ -f "$root/pnpm-lock.yaml" ] && { echo "pnpm"; return; }
  [ -f "$root/yarn.lock" ]      && { echo "yarn"; return; }
  [ -f "$root/package-lock.json" ] && { echo "npm"; return; }
  [ -f "$root/npm-shrinkwrap.json" ] && { echo "npm"; return; }
  echo ""
}

# The executables this codeline's own manifest says it needs. Read from its
# dependency lists — no tool names appear here.
_ch_declared_bins() {
  local root="$1"
  [ -f "$root/package.json" ] || return 0
  "${NODE_BIN:-node}" -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
      const deps = Object.assign({}, p.dependencies || {}, p.devDependencies || {});
      // Only the tooling the project actually invokes: whatever its own scripts
      // call that is also a declared dependency. That is the set whose absence
      // means the project cannot run its own commands.
      const scripts = Object.values(p.scripts || {}).join(" ");
      const needed = Object.keys(deps).filter(d => new RegExp("(^|[^\\\\w/@-])" + d.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&") + "([^\\\\w-]|$)").test(scripts));
      process.stdout.write(needed.join("\n"));
    } catch (e) { /* unreadable manifest: nothing declared */ }
  ' "$root" 2>/dev/null
}

_ch_sync() {
  local root="$1"
  [ "${CODELINE_HEALTH_NO_PULL:-0}" = "1" ] && return 0
  git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || return 0
  # NEVER discard client work: a tree with TRACKED changes is left exactly as is.
  #
  # --untracked-files=no is deliberate. The pipeline writes its own artefacts
  # into client repos (.epam/ manifests, .codegraph/ index), which are untracked
  # and therefore make every repo it has ever touched look permanently dirty.
  # Counting those would mean a codeline is synced exactly once — before the
  # pipeline first runs against it — and never again, silently. Found live:
  # all four codelines reported dirty with nothing but our own artefacts in them.
  #
  # Untracked files do not block a fast-forward anyway; only tracked
  # modifications can conflict, and those are real client work.
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    _ch_log "  tracked changes present — not pulling (client work left untouched)"
    return 0
  fi
  # Fast-forward ONLY. Never merge, never rebase, never force.
  if git -C "$root" pull --ff-only --quiet 2>/dev/null; then
    _ch_log "  synced (ff-only)"
  else
    _ch_log "  could not fast-forward — leaving at current HEAD"
  fi
}

_ch_install() {
  local root="$1" pm="$2"
  [ "${CODELINE_HEALTH_NO_INSTALL:-0}" = "1" ] && return 1
  [ -n "$pm" ] || { _ch_warn "  no recognised lockfile — cannot install dependencies"; return 1; }
  command -v "$pm" >/dev/null 2>&1 || { _ch_warn "  $pm not on PATH — cannot install"; return 1; }
  _ch_log "  installing dependencies with $pm (declared but not resolvable)..."
  ( cd "$root" && "$pm" install >/dev/null 2>&1 ) && return 0
  return 1
}

_ch_unhealthy=0
_ch_names=""

for _ch_root in "$@"; do
  _ch_name="$(basename "$_ch_root")"
  _ch_log "$_ch_name"

  if [ ! -d "$_ch_root" ]; then
    _ch_warn "  UNHEALTHY: path does not exist: $_ch_root"
    _ch_unhealthy=$((_ch_unhealthy + 1)); _ch_names="$_ch_names $_ch_name"
    continue
  fi

  _ch_sync "$_ch_root"

  _ch_needed="$(_ch_declared_bins "$_ch_root")"
  if [ -z "$_ch_needed" ]; then
    _ch_log "  healthy (declares no tooling to resolve)"
    continue
  fi

  # Resolvable == the package is INSTALLED, checked by its directory rather than
  # by a .bin entry matching its name. A scoped package's binary is usually named
  # differently from the package (@11ty/eleventy installs `eleventy`), so a
  # .bin-name check reports a perfectly healthy codeline as broken — and a check
  # that cries wolf gets bypassed, which is worse than no check.
  _ch_missing=""
  for _ch_bin in $_ch_needed; do
    [ -d "$_ch_root/node_modules/$_ch_bin" ] || _ch_missing="$_ch_missing $_ch_bin"
  done

  if [ -n "$_ch_missing" ]; then
    _ch_log "  declared but not resolvable:$_ch_missing"

    # First, satisfy anything the estate itself provides. Done BEFORE install so
    # a dead registry cannot block a dependency that is already on disk.
    _ch_still=""
    for _ch_bin in $_ch_missing; do
      _ch_prov="$(_ch_provider_for "$_ch_bin")"
      if [ -n "$_ch_prov" ] && _ch_link_local "$_ch_root" "$_ch_bin" "$_ch_prov"; then
        continue
      fi
      _ch_still="$_ch_still $_ch_bin"
    done
    _ch_missing="$_ch_still"

    if [ -n "$_ch_missing" ] && _ch_install "$_ch_root" "$(_ch_package_manager "$_ch_root")"; then
      _ch_missing=""
      for _ch_bin in $_ch_needed; do
        [ -d "$_ch_root/node_modules/$_ch_bin" ] || _ch_missing="$_ch_missing $_ch_bin"
      done
    fi
  fi

  if [ -n "$_ch_missing" ]; then
    _ch_warn "  UNHEALTHY: $_ch_name cannot resolve its own declared tooling:$_ch_missing"
    _ch_warn "  Its gates cannot run, so this run would accept an unverified baseline."
    _ch_unhealthy=$((_ch_unhealthy + 1)); _ch_names="$_ch_names $_ch_name"
  else
    _ch_log "  healthy"
  fi
done

if [ "$_ch_unhealthy" -gt 0 ]; then
  _ch_warn "$_ch_unhealthy codeline(s) UNHEALTHY:$_ch_names"
  _ch_warn "Resolve before running — or set SKIP_CODELINE_HEALTH=1 to proceed knowing the gates cannot run."
  exit 1
fi

_ch_log "all codelines healthy"
exit 0
