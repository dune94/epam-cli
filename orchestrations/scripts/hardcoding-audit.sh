#!/usr/bin/env bash
# hardcoding-audit.sh — inventory of values baked into PIPELINE CODE that belong in
# configuration. A .sh/.js/.ts file is not a config file.
#
# Why this exists: a coarse sweep on 2026-08-05 reported 436 sites. Hand-checking the
# largest category showed almost every "branch name" hit was the LANE called "main"
# (agentGroup == "main", _dest="main", the monitor's lane argument) — not a git branch at
# all. Inflation of that kind is worse than no audit: it buries the real defects and
# invites a mass edit that breaks working code.
#
# So every pattern here is deliberately NARROW and is followed by --verify, which prints
# the actual matched lines for a category so a human can confirm each one is real before
# anything is changed. Counts alone are not evidence.
#
# Usage:
#   hardcoding-audit.sh                 # counts per category
#   hardcoding-audit.sh --verify <n>    # print every matching line for category n
#   hardcoding-audit.sh --files <n>     # per-file counts for category n
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Pipeline code only. Tests are excluded: a fixture naming a client is not a shipped fact.
mapfile -t FILES < <(find orchestrations/scripts orchestrations/plugins src \
  -type f \( -name '*.sh' -o -name '*.js' -o -name '*.ts' \) 2>/dev/null \
  | grep -vE 'node_modules|\.venv|/dist/|\.test\.|\.spec\.' \
  | grep -vE '/(tier[0-9]+-[a-z0-9-]+-run|mock[0-9]*-[a-z-]*run)\.sh$')
# Per-project LAUNCHERS are exempt, exactly as test/unit/orchestration/engine-is-generic.test.ts
# exempts them: a launcher exists to declare ONE project's facts — its branch, its codeline
# root, its models. That is configuration living in the file that owns it, not a fact baked
# into the engine. Reverting a "fix" that removed a mock launcher's own branch is what
# established this: the fixture's tests assert the branch it creates.

# Drop comment-only lines: this repo narrates incident history in comments, and a vendor
# name in a post-mortem is documentation, not a hardcoded fact.
drop_narration() { grep -vE ':[0-9]+:[[:space:]]*(#|//|\*|/\*)'; }

declare -a NAMES PATTERNS
add() { NAMES+=("$1"); PATTERNS+=("$2"); }

# 1. Absolute machine paths — never valid on another machine.
add "absolute machine paths" \
    '(/home/[a-z][a-z0-9_-]*|/Users/[a-z][a-z0-9_-]*)/'

# 2. A GIT BRANCH used as a literal. Narrow on purpose: only where the value is being
#    used AS a branch (origin/x, checkout x, a *BRANCH* variable). Excludes the lane
#    called "main", which is the mistake that inflated the first count.
# A `${JIRA_BASELINE_BRANCH:-develop}` default is NOT counted: the value is read from
# configuration and the literal is only the fallback. Widening the pattern to catch those
# also caught `${WORKTREE_MODE:-main}` — the LANE again — and took a verified count of 3 to
# a noisy 31. Whether those defaults should exist at all is a separate, deliberate call;
# see the backlog. This pattern stays narrow enough that every hit is real.
add "git branch literals" \
    "(origin/(main|master|develop)[^\"'}]|checkout[[:space:]]+(-B[[:space:]]+)?[\"']?(main|master|develop)[\"']?[[:space:]]|[A-Za-z_]*BRANCH[A-Za-z_]*=[\"']?(main|master|develop)[\"']?[[:space:]]*$|(echo|initial-branch=)[[:space:]]*[\"']?(main|master|develop)[\"']?[[:space:]]*(\\)|\\}|$))"

# 3. Model identifiers in code — model choice is llm-settings.json's job.
add "model identifiers" \
    "[\"'](z-ai/|glm-[0-9]|kimi-k[0-9]|MiniMax-|minimax-|qwen/)[A-Za-z0-9._/-]*[\"']"

# 4. Hosts and ports.
add "urls and ports" \
    "(https?://[a-zA-Z0-9][a-zA-Z0-9.-]*|localhost:[0-9]{2,5}|127\.0\.0\.1:[0-9]{2,5})"

# 5. Client / vendor / project names — NOT a category here.
#
# A literal list of client names in this file is itself the defect it would report, and
# test/unit/orchestration/engine-is-generic.test.ts already enforces this class properly:
# it derives the vocabulary rather than naming it, covers prompts, plugins, profiles and
# the CLI, and exempts a per-project launcher. It caught this file on the first run.
# Duplicating it here would mean two lists drifting apart. Run that test instead.

# 6. Numeric thresholds: a NAMED knob assigned a literal. Excludes bare numbers, array
#    indices and exit codes, which are structural rather than configurable.
add "numeric thresholds" \
    "[A-Za-z_]*(TIMEOUT|Timeout|timeout|LIMIT|Limit|limit|MAX|Max|max|MIN_|Min|RETRIES|Retries|retries|BUDGET|budget|THRESHOLD|threshold|_SECS|_MS|Secs|Ms)[A-Za-z_]*[[:space:]]*[:=][[:space:]]*[0-9]{2,}"

# 7. Truncations that decide how much a model sees.
add "truncations" \
    '(\.slice\(0, ?[0-9]{2,}\)|head -c ?[0-9]{2,}|head -[0-9]{2,})'

hits_for() { grep -rnE "${PATTERNS[$1]}" "${FILES[@]}" 2>/dev/null | drop_narration; }

case "${1:-}" in
  --verify)
    i=$(( ${2:?category number required} - 1 ))
    echo "### ${NAMES[$i]} — every matching line"; echo
    hits_for "$i"
    ;;
  --files)
    i=$(( ${2:?category number required} - 1 ))
    echo "### ${NAMES[$i]} — per file"; echo
    hits_for "$i" | awk -F: '{print $1}' | sort | uniq -c | sort -rn
    ;;
  *)
    echo "hardcoding audit — ${#FILES[@]} pipeline files (tests and config excluded)"; echo
    printf "  %-3s %-28s %s\n" "#" "CATEGORY" "SITES"
    total=0
    for i in "${!NAMES[@]}"; do
      c=$(hits_for "$i" | wc -l)
      total=$(( total + c ))
      printf "  %-3s %-28s %s\n" "$(( i + 1 ))" "${NAMES[$i]}" "$c"
    done
    echo
    printf "  %-32s %s\n" "TOTAL" "$total"
    echo
    echo "Counts are not evidence. Run --verify <n> and read the lines before changing anything."
    ;;
esac
