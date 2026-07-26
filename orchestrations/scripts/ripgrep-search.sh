#!/usr/bin/env bash
# ripgrep-search.sh — deterministic proof that a string or file exists.
# (grep-backed: ripgrep is not installed here — see the note at the search.)
#
# The CodeGraph index is a tree-sitter AST stored in SQLite: structurally exact,
# but it answers only what it indexed. When a symbol is absent from it — a
# spelling the model got slightly wrong, a construct the parser skipped, a file
# added since the last index — the tool returns empty, and an empty answer is
# where extrapolation starts. Runs 3 and 6 invented `lineItemKey`, a name that
# appears nowhere in the repository, after exactly that kind of miss.
#
# This is the fallback that makes "it does not exist" provable rather than
# assumed. It greps the real working tree, so a hit is ground truth and a miss
# is evidence of absence — neither is an inference.
#
# It is deliberately dumb. No ranking, no semantics, no interpretation: a
# literal string search over real files, because the failure it exists to
# prevent is the model reasoning past a gap instead of looking.
#
# Usage:
#   ripgrep-search.sh --string "applyReportDiscounts" [--glob "*.ts"] [--max N]
#   ripgrep-search.sh --file "apply-report-discounts"          # find by filename
#
# Exit: 0 found · 1 not found (definitive absence) · 2 usage/environment error

set -uo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
STRING=""; GLOB=""; FILEPAT=""; MAX="${RIPGREP_SEARCH_MAX:-40}"

while [ $# -gt 0 ]; do
    case "$1" in
        --string) STRING="${2:-}"; shift 2 ;;
        --glob)   GLOB="${2:-}";   shift 2 ;;
        --file)   FILEPAT="${2:-}"; shift 2 ;;
        --max)    MAX="${2:-40}";  shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"; exit 0 ;;
        *) shift ;;
    esac
done

if [ -z "$STRING" ] && [ -z "$FILEPAT" ]; then
    echo "ripgrep-search: need --string or --file" >&2
    exit 2
fi

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "ripgrep-search: PROJECT_ROOT does not exist: $PROJECT_ROOT" >&2
    exit 2
fi

cd "$PROJECT_ROOT" 2>/dev/null || { echo "ripgrep-search: cannot enter $PROJECT_ROOT" >&2; exit 2; }

# ── find a file by name ─────────────────────────────────────────────────────
if [ -n "$FILEPAT" ]; then
    _hits=$(find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null \
            | sed 's|^\./||' | grep -F -- "$FILEPAT" | head -n "$MAX")
    if [ -z "$_hits" ]; then
        echo "NOT FOUND: no file whose path contains '$FILEPAT' exists in this repository."
        echo "This is definitive — the working tree was searched directly, not an index."
        exit 1
    fi
    echo "FOUND $(printf '%s\n' "$_hits" | wc -l | tr -d ' ') file(s) matching '$FILEPAT':"
    printf '%s\n' "$_hits"
    exit 0
fi

# ── find a literal string ───────────────────────────────────────────────────
# -F: literal, never a pattern. The caller is proving a name exists, not
# writing a regex, and a stray character in a symbol name must not silently
# change the question being asked.
# grep, not ripgrep. `rg` is NOT installed on this machine — what answers to
# that name in an interactive shell is a wrapper function, invisible to any
# agent running this script. A search tool that silently reports "does not
# exist" because its binary is missing is the most dangerous wrong answer this
# script could give, so it uses the one tool guaranteed to be present.
#
# -F: literal, never a pattern. The caller is proving a name exists, not writing
# a regex, and a stray character in a symbol must not change the question.
_args=(-r -F -n --binary-files=without-match
       --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist)
[ -n "$GLOB" ] && _args+=(--include="$GLOB")

_out=$(grep "${_args[@]}" -- "$STRING" . 2>/dev/null | sed 's|^\./||' | head -n "$MAX")

if [ -z "$_out" ]; then
    echo "NOT FOUND: the literal string '$STRING' does not appear anywhere${GLOB:+ in files matching $GLOB} in this repository."
    echo "This is definitive — the working tree was searched directly, not an index."
    echo "Do not infer that it exists under a different name. If you expected it, your assumption was wrong."
    exit 1
fi

echo "FOUND '$STRING':"
printf '%s\n' "$_out"
exit 0
