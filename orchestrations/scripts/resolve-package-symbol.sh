#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# resolve-package-symbol.sh — an AGENT-FACING tool for verifying a third-party
# SDK symbol's REAL declared shape before calling it.
#
# Why this exists (live regression, AMSD-2041, 2026-08-05): the writer called
# `ContentstackLivePreview.unsubscribeOnEntryChange` — a symbol that genuinely
# exists in @contentstack/live-preview-utils's .d.ts files, verified directly
# against the installed package. But it is an INSTANCE METHOD of an internal
# class requiring `new LivePreview()`, not a call on the default export. The
# package's own README documents `onEntryChange` as an `init()` config callback
# instead — a completely different, simpler, intended usage. Regression tests
# failed at runtime on code that type-checked and passed review, because
# nothing checked whether the symbol was used the way the package intends.
#
# This wraps the same plugin tool the writer already gets automatically
# (orchestrations/plugins/codeline-context-plugin.js, resolve_package_symbol) so
# the code-graph-detective — restricted to the bash tool only — can call it too,
# during fix-site investigation, before prescribing a fix that names a
# third-party symbol.
#
# Usage:
#   resolve-package-symbol.sh <packageName> <symbol>
#   PROJECT_ROOT=/path/to/repo resolve-package-symbol.sh @contentstack/live-preview-utils onEntryChange
#
# Exit 0 with a JSON result on stdout (found:true/false either way — a symbol
# genuinely not existing is a normal, useful answer, not a tool failure).
# Exit non-zero only if the package itself is not installed or args are missing.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="${PROJECT_ROOT:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$SCRIPT_DIR/../plugins/codeline-context-plugin.js"
NODE_BIN="${NODE_BIN:-node}"

err() { echo "[resolve-package-symbol] $*" >&2; }

[ $# -ge 2 ] || { err "usage: resolve-package-symbol.sh <packageName> <symbol>"; exit 2; }
[ -f "$PLUGIN" ] || { err "plugin not found at $PLUGIN — tool unavailable"; exit 3; }

PACKAGE_NAME="$1"
SYMBOL="$2"

RPS_REPO="$REPO" RPS_PLUGIN="$PLUGIN" RPS_PACKAGE="$PACKAGE_NAME" RPS_SYMBOL="$SYMBOL" \
"$NODE_BIN" -e "
process.chdir(process.env.RPS_REPO);
const { tools } = require(process.env.RPS_PLUGIN);
const tool = tools.find((t) => t.name === 'resolve_package_symbol');
tool.execute({ packageName: process.env.RPS_PACKAGE, symbol: process.env.RPS_SYMBOL }).then((result) => {
  console.log(result.content);
  process.exit(result.isError ? 1 : 0);
});
"
