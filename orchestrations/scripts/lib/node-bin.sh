#!/usr/bin/env bash
# node-bin.sh — resolve the node interpreter the pipeline should run, without writing a
# path or a version down.
#
# Ten sites did this instead:
#
#   [ -x "/home/<user>/.nvm/versions/node/v20.20.0/bin/node" ] && NODE_BIN="/home/…/node"
#
# which is valid on exactly one machine, for exactly one nvm install, until that version is
# upgraded. The requirement itself is already declared where requirements belong —
# package.json `engines.node` — and the interpreter is DISCOVERABLE. Neither belongs in a
# shell script.
#
# Resolution order, first match wins:
#   1. EPAM_NODE_BIN            — explicit configuration, always honoured
#   2. node on PATH             — if it satisfies engines.node
#   3. newest nvm-installed node that satisfies it — found via NVM_DIR/$HOME, never a
#                                 username, never a pinned version
#   4. node on PATH regardless  — with a warning; better to run and fail loudly on a real
#                                 incompatibility than to resolve to nothing
#
# Usage:  . lib/node-bin.sh ; NODE_BIN="$(resolve_node_bin)"

# Minimum major version, read from package.json's engines.node (e.g. ">=20.0.0" -> 20).
# Falls back to 0 (accept anything) rather than inventing a number: if the repo does not
# state a requirement, this script is not the place to invent one.
_node_min_major() {
  local pkg="${1:-}"
  [ -n "$pkg" ] && [ -f "$pkg" ] || return 0
  sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$pkg" 2>/dev/null | head -1
}

_node_major_of() {
  local bin="$1" out
  [ -x "$bin" ] || return 1
  out="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  # Only a bare integer counts. Anything else means we could not read the version, and a
  # numeric comparison against a non-number silently evaluates to "not satisfied" — which
  # would skip a perfectly good interpreter with no explanation.
  case "$out" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s' "$out" ;;
  esac
}

# resolve_node_bin [repo_root]
resolve_node_bin() {
  local repo_root="${1:-${REPO_ROOT:-}}"
  [ -n "$repo_root" ] || repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local min; min="$(_node_min_major "$repo_root/package.json")"
  [ -n "${min:-}" ] || min=0

  # 1. Configured explicitly.
  if [ -n "${EPAM_NODE_BIN:-}" ] && [ -x "${EPAM_NODE_BIN}" ]; then
    printf '%s' "$EPAM_NODE_BIN"; return 0
  fi

  # 2. PATH node, if new enough.
  local path_node; path_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$path_node" ]; then
    local maj; maj="$(_node_major_of "$path_node" || echo 0)"
    if [ "${maj:-0}" -ge "${min:-0}" ] 2>/dev/null; then
      printf '%s' "$path_node"; return 0
    fi
  fi

  # 3. Newest nvm-managed node satisfying the requirement. NVM_DIR if set, else the
  #    conventional location under the CURRENT user's home — never a name.
  local nvm_root="${NVM_DIR:-${HOME:-}/.nvm}/versions/node"
  if [ -d "$nvm_root" ]; then
    local candidate
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      local bin="$nvm_root/$candidate/bin/node"
      local maj; maj="$(_node_major_of "$bin" || echo 0)"
      if [ "${maj:-0}" -ge "${min:-0}" ] 2>/dev/null; then
        printf '%s' "$bin"; return 0
      fi
    done < <(ls -1 "$nvm_root" 2>/dev/null | sort -Vr)
  fi

  # 4. Nothing satisfies it. Return PATH node and say so — a loud mismatch beats an empty
  #    NODE_BIN that fails later with "command not found" and no explanation.
  if [ -n "$path_node" ]; then
    echo "[node-bin] WARNING: no node >= ${min} found; using $path_node. Set EPAM_NODE_BIN to override." >&2
    printf '%s' "$path_node"; return 0
  fi
  echo "[node-bin] ERROR: no node interpreter found on PATH or under ${nvm_root}. Set EPAM_NODE_BIN." >&2
  return 1
}
