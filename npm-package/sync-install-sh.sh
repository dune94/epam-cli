#!/bin/bash
# sync-install-sh.sh — the ONE place install.sh is copied into the npm package.
#
# SINGLE POINT OF MAINTENANCE: orchestrations-installer/install.sh is the source of truth. The
# copy at npm-package/amsd-pipeline/install.sh is generated, gitignored, and never hand-edited —
# run this (via `npm run npm-package:sync`) before `npm publish`, which is exactly what the
# publish workflow does.
#
# Deliberately a BARE copy — no lib/ directory alongside it in the npm package — because that is
# what makes install.sh take its own self-clone path (the "obtained alone: npx, a raw single-file
# download" branch already built for exactly this). No special-casing needed for npx at all.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../orchestrations-installer/install.sh"
DEST="$HERE/amsd-pipeline/install.sh"

if [ ! -f "$SRC" ]; then
    echo "sync-install-sh.sh: source not found at $SRC" >&2
    exit 1
fi

cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "synced $SRC -> $DEST"
