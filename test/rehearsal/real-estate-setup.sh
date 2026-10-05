#!/usr/bin/env bash
# THE REAL ESTATE, COPIED — a £0 rehearsal runs on the operator's actual codelines and install, never a
# fixture (operator, 2026-10-05: "make your tests real even if you have to make a codeline copy").
#
#   real-estate-setup.sh <rehearsal-root> <real-install> <real-codeline-root> <codeline-dir>...
#
# Each codeline is copied whole (.git, node_modules, hooks, .epam) and its `origin` becomes a local bare
# mirror of the real origin's branches, so the run's own fetch/ff-sync works and nothing reaches a client
# remote. Linked-worktree registrations are dropped from the copies (they name the REAL worktree dirs).
# The install is copied whole, and every absolute path in its state that names the real install or the
# real codeline root is rewritten to the copies — the COPY only; the real install is never written.
set -euo pipefail
R="${1:?rehearsal root}"; REAL_INSTALL="${2:?real install}"; REAL_CL="${3:?real codeline root}"; shift 3
[ $# -gt 0 ] || { echo "no codelines named" >&2; exit 2; }
case "$R" in /tmp/*) echo "refusing a rehearsal root under /tmp (the Copilot CLI auto-allows it)" >&2; exit 2;; esac

rm -rf "$R"; mkdir -p "$R/origins" "$R/codelines"
for d in "$@"; do
    src="$REAL_CL/$d"; dst="$R/codelines/$d"; org="$R/origins/$d.git"
    # The real origin's branches, as the real checkout last fetched them: a copy of the real .git made
    # bare, with refs/remotes/origin/* as its own branches (a shallow real clone refuses a push).
    cp -a "$src/.git" "$org"
    git -C "$org" config core.bare true
    rm -rf "$org/worktrees"
    git -C "$org" for-each-ref --format='%(refname) %(objectname)' refs/remotes/origin | grep -v '/HEAD ' \
        | while read -r ref sha; do git -C "$org" update-ref "refs/heads/${ref#refs/remotes/origin/}" "$sha"; done
    cp -a "$src" "$dst"
    rm -rf "$dst/.git/worktrees"
    git -C "$dst" remote set-url origin "$org"
    git -C "$dst" fetch -q origin
    echo "codeline $d: $(git -C "$dst" rev-parse --short HEAD) on $(git -C "$dst" branch --show-current), origin $(git -C "$dst" for-each-ref --format='%(refname:short)' refs/remotes/origin | wc -l) branch(es)"
done

cp -a "$REAL_INSTALL" "$R/install"
# Rewrite absolute paths in the COPY's text state (never binaries, never node_modules).
grep -rlIZ --exclude-dir=node_modules --exclude-dir=.git -e "$REAL_INSTALL" -e "$REAL_CL" "$R/install" 2>/dev/null \
    | xargs -0 -r sed -i -e "s#${REAL_INSTALL}#${R}/install#g" -e "s#${REAL_CL}/#${R}/codelines/#g"
left=$(grep -rlI --exclude-dir=node_modules --exclude-dir=.git -e "$REAL_INSTALL" -e "$REAL_CL/" "$R/install" 2>/dev/null | wc -l)
echo "install copied; files still naming the real install or codelines: $left"
