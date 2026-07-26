#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# codegraph-agent-query.sh — an AGENT-FACING tool for querying a codebase's
# CodeGraph index during brownfield fix-site discovery.
#
# Why this exists (proven live 2026-07-23, AMSD-1820): a bug ticket describes a
# SYMPTOM ("promo code amount not displayed in the email confirmation"), but the
# fix lives in the CAUSE — a discount-matching service whose code says nothing
# about "display" or "email". Pre-computed similarity retrieval on the raw ticket
# text ranks the real fix site past #20. But an AGENT that reads the ticket,
# extracts DOMAIN NOUNS (promo, discount, return-trip, dispatch, report — NOT the
# symptom words displayed/email/expected), and queries CodeGraph with them lands
# the true fix site (applyReportDiscountsService) at rank #1 — deterministically,
# because CodeGraph is a static FTS5 symbol index.
#
# The agent is expected to call this tool ITERATIVELY (5-10 times), refining its
# domain-noun query based on the blast-radius/caller output each call returns,
# until it converges on the symbol that computes the wrong field.
#
# Subcommands (thin wrappers over the codegraph CLI):
#   explore  <query…>   Domain-noun search → ranked symbols + blast radius +
#                       callers/callees. START HERE. Use domain nouns, not
#                       symptom/UI words.
#   query    <symbol>   Exact symbol lookup → definition site(s).
#   callers  <symbol>   Who calls this symbol (trace a symptom back to its cause).
#   callees  <symbol>   What this symbol calls (trace forward).
#   impact   <symbol>   What breaks if you change this symbol.
#   helpers  <term…>    Scan for EXISTING reusable functions (util/helper/parser/
#                       formatter/mapper) matching the term, with their exact
#                       symbol name AND import path — so you reuse one instead of
#                       writing novel code. ALWAYS run this before adding a new
#                       function; reusing an existing helper is required, not
#                       optional.
#
# Usage:
#   codegraph-agent-query.sh <subcommand> <args…>          # repo = $PROJECT_ROOT or cwd
#   PROJECT_ROOT=/path/to/repo codegraph-agent-query.sh explore promo discount return trip
#
# Exit 0 with results on stdout. Exit non-zero only on a genuinely broken index
# or missing binary (the agent should treat that as "tool unavailable", not "no
# results").
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="${PROJECT_ROOT:-$(pwd)}"

err() { echo "[codegraph-agent-query] $*" >&2; }

if ! command -v codegraph >/dev/null 2>&1; then
  err "codegraph binary not found on PATH — tool unavailable"
  exit 3
fi

# Self-heal: re-index on demand if the index is missing/invalid. The index is
# only protected by an untracked .codegraph/.gitignore, which the pipeline's own
# `git clean` can strip — so a valid-looking repo may still lack a usable index
# at the moment the agent reaches for it. Validate the real SQLite header.
_db="$REPO/.codegraph/codegraph.db"
_valid=0
if [ -f "$_db" ] && [ "$(head -c 15 "$_db" 2>/dev/null)" = "SQLite format 3" ]; then
  _valid=1
fi
if [ "$_valid" != "1" ]; then
  err "index missing/invalid for $REPO — indexing now (one-time, ~1s)…"
  if ! codegraph init "$REPO" >/dev/null 2>&1; then
    err "codegraph init failed for $REPO"
    exit 4
  fi
fi

[ $# -ge 1 ] || { err "usage: codegraph-agent-query.sh <explore|query|callers|callees|impact> <args…>"; exit 2; }

sub="$1"; shift
[ $# -ge 1 ] || { err "subcommand '$sub' needs at least one argument"; exit 2; }

case "$sub" in
  explore)
    # explore takes free-form multi-word query (domain nouns)
    codegraph explore "$*" --path "$REPO" 2>&1
    ;;
  query)
    codegraph query "$*" --path "$REPO" 2>&1
    ;;
  callers)
    codegraph callers "$1" --path "$REPO" 2>&1
    ;;
  callees)
    codegraph callees "$1" --path "$REPO" 2>&1
    ;;
  impact)
    codegraph impact "$1" --path "$REPO" 2>&1
    ;;
  show)
    # SHOW REAL SOURCE. The detective must emit `brokenLine` as a VERBATIM quote,
    # machine-checked against the file — but every other subcommand returns only
    # symbol names and import paths. It was being asked to copy text it had never
    # been shown, and forbidden from fetching it. The only thing it could do was
    # reconstruct the line from symbol names, which is exactly what the failures
    # looked like: right concept, invented identifiers (`lineItemKey`, which
    # exists nowhere in the repo). Intermittent, too — when the symbol names
    # happened to resemble the real expression it came out right by luck.
    #
    # With this, quoting is copying.
    #
    #   show <repo-relative-file> [start] [end]
    _file="${1:-}"
    [ -n "$_file" ] || { err "show: no file given"; exit 2; }
    _abs="$REPO/${_file#./}"
    # Never leave the repository under analysis.
    case "$(cd "$(dirname "$_abs")" 2>/dev/null && pwd -P)/" in
      "$(cd "$REPO" && pwd -P)"/*) : ;;
      *) err "show: refusing to read outside the project: $_file"; exit 2 ;;
    esac
    [ -f "$_abs" ] || { err "show: file not found: $_file"; exit 2; }
    _start="${2:-1}"
    _end="${3:-}"
    _total=$(wc -l < "$_abs" | tr -d ' ')
    if [ -z "$_end" ]; then
      # Whole file, capped: an unbounded dump swamps the context window on a
      # repository of this size.
      _cap=300
      _end=$(( _start + _cap - 1 ))
      [ "$_end" -gt "$_total" ] && _end="$_total"
      awk -v s="$_start" -v e="$_end" 'NR>=s && NR<=e {printf "%6d  %s\n", NR, $0}' "$_abs"
      # `|| true`: a false test as the LAST statement makes the subcommand exit
      # 1 even though it succeeded — exit status is a contract with the caller.
      [ "$_total" -gt "$_end" ] && echo "… truncated at line $_end of $_total — request a range to see more" || true
    else
      awk -v s="$_start" -v e="$_end" 'NR>=s && NR<=e {printf "%6d  %s\n", NR, $0}' "$_abs"
    fi
    ;;
  helpers)
    # Scan for EXISTING exported functions that likely already do what the agent
    # is about to hand-roll. Two signals, unioned:
    #   1. codegraph explore for the term (index-ranked symbols).
    #   2. a source scan for exported declarations whose SYMBOL NAME contains the
    #      term OR a helper verb (parse/format/normalize/convert/resolve/extract/
    #      build/map), reported as "path/to/file.ts  ->  exportedSymbol" so the
    #      agent has the exact import path + symbol to reuse.
    term="$*"
    echo "== indexed matches (codegraph) =="
    codegraph explore "$term" --path "$REPO" 2>&1
    echo
    echo "== existing exported functions to REUSE (symbol @ import path) =="
    # Prefer ripgrep; fall back to grep -r. Match exported fn/const declarations.
    _scan() {
      if command -v rg >/dev/null 2>&1; then
        rg -n --no-heading -g '*.ts' -g '*.tsx' -g '!*.test.*' -g '!*.spec.*' -g '!node_modules' \
          'export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)' "$REPO" 2>/dev/null
      else
        grep -rnE --include='*.ts' --include='*.tsx' \
          'export[[:space:]]+(async[[:space:]]+)?(function|const)[[:space:]]+[A-Za-z0-9_]+' \
          "$REPO" 2>/dev/null | grep -vE '\.(test|spec)\.|/node_modules/'
      fi
    }
    # term-driven filter: any query word (>=3 chars) OR a helper verb in the symbol name.
    _pat=$(printf '%s\n' $term | awk 'length>=3' | paste -sd'|' -)
    _verbs='parse|format|normalize|convert|resolve|extract|build|map|sanitize|transform|compute|calculate'
    _scan | sed -E 's#^'"$REPO"'/?##' \
      | sed -E 's#:[0-9]+:.*export[[:space:]]+(async[[:space:]]+)?(function|const)[[:space:]]+([A-Za-z0-9_]+).*#  ->  \3#' \
      | grep -iE "${_pat:-$_verbs}|$_verbs" \
      | sort -u | head -40
    echo "(reuse one of the above if it fits — do NOT write a new function that duplicates it)"
    ;;
  *)
    err "unknown subcommand '$sub' — use explore|query|callers|callees|impact|helpers"
    exit 2
    ;;
esac
