#!/usr/bin/env bash
# hardcoding-audit.sh — inventory of decisions baked into the ENGINE that belong to a project.
#
# NOT ONLY CODE. This once scanned .sh/.js/.ts and declared "a .sh/.js/.ts file is not a config
# file", which made RELOCATION look like repair: /^docs\./i moved out of codeline-discovery.js
# into orchestrations/config/codeline-scan.json and stopped being counted, while it went on
# deciding which client repository was excluded from every project. The engine's own data files
# are engine facts wherever they sit, so they are scanned too. A PROJECT's config is different —
# that is where a project's facts belong — and is not scanned.
#
# AND IT CALIBRATES. Every defect found on 2026-08-23 was invisible here: the numeric category
# needed a NAMED knob so topN = 8 and w.length >= 4 matched nothing, the truncation category
# required two digits so slice(0, 3) was invisible, and there was no category at all for another
# tenant's schema, a fixed vocabulary of domain values, or prose addressed to a model. `--calibrate`
# runs every pattern against test/fixtures/hardcoding/known-hardcoding.txt and FAILS on any
# category that cannot see its own example. A detector that finds only what its author already
# knew reports clean, and clean is what everyone remembers.
#
# NOTHING RAN THIS. preflight-static.sh ratchets on scan-duplicated-literals.js, a different tool;
# this audit was invoked by hand, when someone thought to. So its blindness was never even
# observed. --calibrate is now a pre-flight check: not the COUNT, which is a research number that
# needs reading, but the question of whether this tool can still see at all.
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

# WHAT IS SCANNED IS DECLARED — config/hardcoding-audit-scope.json.
#
# This swept orchestrations/config and orchestrations/agents JSON too, on the argument that a
# shipped default is an engine fact. It made the headline number unreadable: 205 of 658 sites
# were llm-defaults.*.json naming the models it exists to name. Those files ARE the configuration
# the engine reads, which is the opposite of a value baked into code.
#
# The scope lives in config so narrowing it shows up in review. Narrowing a scanner is how a
# scanner comes to report clean while the defect is still there, so a test asserts this one still
# finds engine sites.
_AUDIT_SCOPE="${EPAM_HARDCODING_AUDIT_SCOPE:-$ROOT/orchestrations/config/hardcoding-audit-scope.json}"
mapfile -t FILES < <(
  "${NODE_BIN:-node}" -e '
    const fs=require("fs"),path=require("path"),cp=require("child_process");
    const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const out=[];
    for (const s of cfg.scan) {
      const args=[s.path,"-type","f","("];
      s.types.forEach((t,i)=>{ if(i) args.push("-o"); args.push("-name","*."+t); });
      args.push(")");
      try { out.push(...cp.execFileSync("find",args,{encoding:"utf8"}).trim().split("\n")); } catch {}
    }
    const ex=(cfg.excludePatterns||[]).map(p=>new RegExp(p));
    process.stdout.write(out.filter(Boolean).filter(f=>!ex.some(r=>r.test(f))).join("\n"));
  ' "$_AUDIT_SCOPE" 2>/dev/null)

SCOPE_DIRS="$("${NODE_BIN:-node}" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.scan.map(s=>s.path).join(" "))' "$_AUDIT_SCOPE" 2>/dev/null)"
CALIBRATION="test/fixtures/hardcoding/known-hardcoding.txt"
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
# The branch alternative ends in ([[:space:]]|$), not [[:space:]]: it required a character AFTER
# the branch name, so `git checkout develop` at the end of a line matched nothing. Found by
# --calibrate on its first run, which is the entire argument for having it.
#
# A `${JIRA_BASELINE_BRANCH:-develop}` default is NOT counted: the value is read from
# configuration and the literal is only the fallback. Widening the pattern to catch those
# also caught `${WORKTREE_MODE:-main}` — the LANE again — and took a verified count of 3 to
# a noisy 31. Whether those defaults should exist at all is a separate, deliberate call;
# see the backlog. This pattern stays narrow enough that every hit is real.
add "git branch literals" \
    "(origin/(main|master|develop)[^\"'}]|checkout[[:space:]]+(-B[[:space:]]+)?[\"']?(main|master|develop)[\"']?([[:space:]]|$)|[A-Za-z_]*BRANCH[A-Za-z_]*=[\"']?(main|master|develop)[\"']?[[:space:]]*$|(echo|initial-branch=)[[:space:]]*[\"']?(main|master|develop)[\"']?[[:space:]]*(\\)|\\}|$))"

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

# 7. Truncations that decide how much a model sees. ANY length: this required two digits, so
#    slice(0, 3) — which cut the ranked evidence a discovery decision was explained by — was
#    invisible. A single-digit cut is a smaller window, not a lesser decision.
add "truncations" \
    '(\.slice\(0, ?[0-9]+\)|head -c ?[0-9]{2,}|head -[0-9]{2,})'

# 8. ANOTHER SYSTEM'S PRIVATE SCHEMA. A tracker custom-field id is per-tenant: customfield_10016
#    is story points on one Jira instance and nothing on the next. Compiled into the engine it
#    reads as absent everywhere else, silently — and on 2026-08-23 the ids in this repo turned out
#    to be wrong for its own tenant.
add "foreign schema" \
    'customfield_[0-9]+'

# 9. A FIXED VOCABULARY OF DOMAIN VALUES used in logic — issue types, workflow states, kinds.
#    supportedTypes = ['story','task','bug'] dropped every ticket outside it with `return null`,
#    and KINDS/AGENT_KINDS were two copies of one vocabulary that had already drifted apart.
add "domain vocabularies" \
    "=[[:space:]]*\\[[[:space:]]*['\"][a-z][a-z-]{2,}['\"][[:space:]]*,[[:space:]]*['\"][a-z][a-z-]{2,}['\"]"

# 10. A NUMBER DECIDING SOMETHING, with no name to configure it by. Category 6 needs a knob
#     (TIMEOUT, MAX, LIMIT); these have none, which is precisely why nobody could change them:
#     topN = 8, w.length >= 4, score += 3, tier2 * 10. Every one chose a client repository.
#     NARROWED after its first run reported 304. `x += 1` is a COUNTER, not a decision, and it
#     was most of them — the same inflation this file was written to avoid, reintroduced by me in
#     the pattern meant to catch it. What remains is a value that sets a bound: a parameter
#     default, a comparison against a length, or a scaling factor. Length comparisons against 0
#     and 1 are excluded: those ask "is it empty" and "is there more than one", which are
#     structural questions with no other possible answer. `w.length >= 4` — the filter that
#     discarded every product identifier — is kept, because 4 is a choice.
add "unnamed numeric decisions" \
    '([a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*=[[:space:]]*[0-9]+[,)]|\.length[[:space:]]*[<>]=?[[:space:]]*([2-9]|[0-9]{2,})|[[:space:]]\*[[:space:]]*[0-9]{2,}[[:space:]]*[;)])'

# 11. PROSE ADDRESSED TO A MODEL, living in code. One prompt, one file: text in .js cannot be
#     reviewed in the prompt layer, is invisible to the drift checks that hold every project copy
#     to its template, and cannot be changed per project.
add "model-facing prose" \
    "['\"\`](Produce|Rename|Return only|You are|You MUST|Your task|Do not) [a-z][^'\"\`]{20,}['\"\`]"

# 12. A NAMING CONVENTION ASSERTED BY THE ENGINE — a regex over names, shipped as a default that
#     every project inherits. /^docs\./i excluded two repositories from every estate.
add "naming conventions in engine data" \
    '\^[a-z][a-z0-9]*\\\\?\.'

# NO MATCHES IS AN ANSWER, NOT A FAILURE. grep exits 1 when it finds nothing, and that status
# propagated out of --verify, so inspecting a clean category looked like the audit had broken.
# A caller wiring this into a gate would have read "this class is clear" as "the tool failed".
hits_for() { grep -rnE "${PATTERNS[$1]}" "${FILES[@]}" 2>/dev/null | drop_narration || true; }

case "${1:-}" in
  --scope)
    echo "### what this audit covers"
    echo
    for d in $SCOPE_DIRS; do echo "  $d"; done
    echo
    echo "  ${#FILES[@]} file(s). A PROJECT's own config is deliberately absent: that is where a"
    echo "  project's facts belong. These are the engine's, and apply to every project."
    ;;
  --calibrate)
    # EVERY CATEGORY MUST STILL SEE ITS OWN EXAMPLE. Without this, a pattern that stops matching
    # — a widened exclusion, a refactor, a typo — turns into a silent zero, and the ratchet
    # records the improvement.
    if [ ! -s "$CALIBRATION" ]; then
      echo "BLIND: no calibration fixture at $CALIBRATION — the audit cannot demonstrate it sees anything." >&2
      exit 1
    fi
    echo "### calibration — ${#NAMES[@]} categories against $CALIBRATION"
    echo
    blind=0
    for i in "${!NAMES[@]}"; do
      if grep -qE "${PATTERNS[$i]}" "$CALIBRATION" 2>/dev/null; then
        printf "  %-3s %-34s sees its example\n" "$(( i + 1 ))" "${NAMES[$i]}"
      else
        printf "  %-3s %-34s BLIND — no line in the fixture matches\n" "$(( i + 1 ))" "${NAMES[$i]}"
        blind=$(( blind + 1 ))
      fi
    done
    echo
    if [ "$blind" -gt 0 ]; then
      echo "BLIND: $blind categor(y/ies) can no longer see the defect they claim to cover." >&2
      echo "A count from this audit is worth nothing until every category demonstrates it sees." >&2
      exit 1
    fi
    echo "  every category demonstrates it can still see."
    ;;
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
    echo "hardcoding audit — ${#FILES[@]} engine files (tests and PROJECT config excluded)"; echo
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
