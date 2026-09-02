#!/usr/bin/env bash
# brownfield-repro-test-gate.sh <story_id>
# ─────────────────────────────────────────────────────────────────────────────
# HARD GATE (step 5 of the AC/VC/TC design): a brownfield fix must ship a test
# that REPRODUCES the bug — the story's new/changed test(s) must FAIL against the
# pre-fix baseline and PASS with the fix in place. This proves the fix actually
# works, not merely that some test exists. "One unit test per change" +
# "the test must reproduce the bug", enforced deterministically.
#
# Method (the fix + test are committed on the story branch):
#   1. Diff vs the baseline branch (JIRA_BASELINE_BRANCH, e.g. develop) → split
#      changed files into TEST files and FIX (non-test) files.
#   2. No test file changed  → BLOCK (the change shipped without a test).
#   3. Run the new test(s) with the fix (HEAD) → must PASS.
#   4. Temporarily revert ONLY the fix files to baseline (keep the test) → run the
#      new test(s) → they must FAIL (they reproduce the bug). Then restore the fix.
#   5. Test passed without the fix → BLOCK (the test does not reproduce the bug).
#
# Exit: 0 = gate passed (or safely skipped). 1 = BLOCK.  Env override:
#   EPAM_SKIP_REPRO_GATE=1 skips entirely (escape hatch, logged).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# This script resolves handlers from its own location: it is executed, not sourced, so it cannot
# borrow a caller's SCRIPT_DIR.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STORY_ID="${1:?usage: brownfield-repro-test-gate.sh <story_id>}"
PROJECT_ROOT="${PROJECT_ROOT:?PROJECT_ROOT required}"

# NO GUESSED BRANCH. This defaulted to the literal "develop"; every diff and every checkout in
# this gate is against that ref, so on a project whose trunk is named anything else the gate
# compared the fix against nothing. The caller declares it; otherwise take the repository's own
# checked-out branch, which is at least true.
BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-}"
if [ -z "$BASELINE_BRANCH" ]; then
    BASELINE_BRANCH="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    [ "$BASELINE_BRANCH" = "HEAD" ] && BASELINE_BRANCH=""
fi
if [ -z "$BASELINE_BRANCH" ]; then
    echo "[repro-gate] BLOCKED: no baseline branch declared and none resolvable in ${PROJECT_ROOT} — cannot diff the fix against anything, and will not report that as a pass." >&2
    exit 1
fi

log()   { echo "[repro-gate] $*"; }
block() { echo "[repro-gate] ⛔ BLOCK ($STORY_ID): $*" >&2; exit 1; }

if [ "${EPAM_SKIP_REPRO_GATE:-0}" = "1" ]; then
    log "EPAM_SKIP_REPRO_GATE=1 — skipping reproduction gate for $STORY_ID (escape hatch)"
    exit 0
fi
if [ ! -d "$PROJECT_ROOT/.git" ]; then
    log "$PROJECT_ROOT is not a git repo — skipping"; exit 0
fi

BASELINE_SHA=$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${BASELINE_BRANCH}" 2>/dev/null \
            || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${BASELINE_BRANCH}" 2>/dev/null || echo "")
if [ -z "$BASELINE_SHA" ]; then
    log "baseline branch '${BASELINE_BRANCH}' not resolvable in $PROJECT_ROOT — skipping (cannot compute reproduction)"; exit 0
fi

# Split changed files into test vs fix (non-test).
mapfile -t _CHANGED < <(git -C "$PROJECT_ROOT" diff --name-only "$BASELINE_SHA" HEAD 2>/dev/null)
TEST_FILES=(); FIX_FILES=(); _CANDIDATES=()
for f in "${_CHANGED[@]}"; do
    [ -z "$f" ] && continue
    # Never treat dependency/build output as a fix file (a real repo gitignores
    # these, but be defensive — reverting/deleting them would break the runner).
    case "$f" in
        node_modules/*|*/node_modules/*|dist/*|build/*|coverage/*|.git/*) continue ;;
    esac
    _CANDIDATES+=("$f")
done

# WHAT IS A TEST IS THE PROJECT'S DECLARATION, NOT THIS SCRIPT'S.
#
# This loop used to classify with its own four globs. That hardcoded stack filenames in engine
# code, and put a SECOND copy of the convention beside the writer's — two copies that drift, so the
# writer can produce a file this gate refuses. Live 2026-09-02 (AMSD-1919) they disagreed over
# .spec.ts vs .spec.tsx and a fix shipped with no test at all.
#
# .epam/verification.json test.testFilePattern already declared it. It is also stricter: a fixture
# or mock inside __tests__/ no longer counts as "ships a test", which the old globs allowed.
_ccf_out=$(printf '%s\n' "${_CANDIDATES[@]}" \
    | "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/classify-changed-files.js" "$PROJECT_ROOT" 2>&1) || {
    block "the project declares no test-file convention, so this gate cannot tell a test from a fix: $_ccf_out"
}
while IFS=$'\t' read -r _verdict _cf; do
    [ -n "$_cf" ] || continue
    if [ "$_verdict" = "TEST" ]; then TEST_FILES+=("$_cf"); else FIX_FILES+=("$_cf"); fi
done <<< "$_ccf_out"

if [ "${#TEST_FILES[@]}" -eq 0 ]; then
    block "no test file accompanies the change — every brownfield change must ship a test that reproduces the fixed behavior."
fi
if [ "${#FIX_FILES[@]}" -eq 0 ]; then
    log "no non-test files changed for $STORY_ID — nothing to revert; reproduction check not applicable, passing"; exit 0
fi

# Run the story's test files with whatever command THIS codeline's ecosystem declares.
# Output is CAPTURED, never discarded: the exit code alone cannot distinguish
# "the test could not be parsed" from "the test ran and failed its assertions",
# and those two demand opposite responses. Discarding it caused a live
# misdiagnosis on 2026-07-24 (see _test_never_ran below).
_LAST_TEST_OUTPUT=""
# THE RUNNER COMES FROM THE ECOSYSTEM REGISTRY, NOT FROM NAMES IN HERE.
#
# This probed node_modules/.bin/vitest, then jest, then `npm test`. lib/ecosystem-registry.js already
# knows how every supported ecosystem runs its tests, and how it targets specific files — one
# table, shared with the health check and the scanners.
_repro_file_command() {
    "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" \
        "$PROJECT_ROOT" "" "$(printf '%s,' "$@")" 2>/dev/null \
        | "${NODE_BIN:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
             try{process.stdout.write(JSON.parse(s).testFileCommand||"")}catch{}})' 2>/dev/null
}

# RESOLVED ONCE, BEFORE ANYTHING IS REVERTED.
#
# Step 4 below reverts the FIX FILES to the baseline so the test can be run against pre-fix code —
# and the manifest can be one of them, because a fix may legitimately touch package.json,
# Cargo.toml or pyproject.toml (a new dependency, a changed script). With the manifest reverted or
# gone, the ecosystem lookup resolves nothing, and the baseline run would report "cannot run" for a
# codeline that runs its tests perfectly well. The old code was accidentally immune: it probed
# node_modules/.bin directly, which survives a revert.
#
# The command is a property of the CODELINE, not of the working tree at one moment, so it is
# resolved once here and reused for both runs.
_REPRO_TEST_CMD=""

run_new_tests() {
    local _out _rc _cmd="$_REPRO_TEST_CMD"
    [ -n "$_cmd" ] || _cmd="$(_repro_file_command "$@")"
    [ -n "$_cmd" ] || return 3
    _out=$( cd "$PROJECT_ROOT" || exit 2
      eval "$_cmd" 2>&1 )
    _rc=$?
    _LAST_TEST_OUTPUT="$_out"
    # Held for the numeric never-ran check below, which parses it ONLY if it is JSON and falls
    # back to the pattern check otherwise. The gate used to force `--reporter=json` on vitest
    # specifically; it now runs whatever command the codeline declares, so JSON is available when
    # that command happens to emit it and the fallback covers the rest — self-adjusting, and no
    # reporter flag from any one ecosystem is named here.
    _LAST_TEST_JSON="$_out"
    return "$_rc"
}

# Did the test fail to PARSE/COMPILE (i.e. never actually execute), as opposed to
# running and failing an assertion? A test that never ran proves nothing about the
# fix, so blaming the fix for it sends the investigation the wrong way.
# DETERMINISTIC — same defect as the writer's validator (B22, 2026-07-24). The
# pattern `ERROR: Expected` (esbuild) matched vitest's ordinary
# `AssertionError: expected ...` case-insensitively, so an assertion failure — the
# NORMAL result for a reproducing test — read as "never ran". Decide on a number.
_LAST_TEST_JSON=""
_test_never_ran() {
    if [ -n "$_LAST_TEST_JSON" ]; then
        local total
        total=$(printf '%s' "$_LAST_TEST_JSON" | "${NODE_BIN:-node}" -e '
            let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              // -1 means "this output is not a test report" -> fall back to the pattern
              // check. The old form sliced from indexOf("{"), which is -1 when there is no
              // brace at all, so `s.slice(-1)` handed JSON.parse the LAST CHARACTER: any
              // runner output ending in a digit parsed cleanly, `numTotalTests` was
              // undefined, and 0 tests read as "the test never ran". An ordinary
              // "AssertionError: expected 1 to be 2" — the normal result for a reproducing
              // test — was reported as a malformed test. Same defect the pattern check was
              // replaced to fix, one layer down.
              const i = s.indexOf("{");
              if (i < 0) { process.stdout.write("-1"); return; }
              try { const j = JSON.parse(s.slice(i));
                    if (!j || typeof j !== "object" || typeof j.numTotalTests !== "number") {
                      process.stdout.write("-1"); return;
                    }
                    process.stdout.write(String(j.numTotalTests)); }
              catch { process.stdout.write("-1"); }
            });' 2>/dev/null || echo "-1")
        [ "$total" != "-1" ] && { [ "${total:-0}" -eq 0 ]; return; }
    fi
    # Fallback only when JSON is unavailable. `ERROR: Expected` deliberately absent.
    printf '%s' "$_LAST_TEST_OUTPUT" | grep -qiE \
      "Transform failed|Failed to parse|Failed to load url|SyntaxError|Cannot find (module|package)|Tests +no tests|No test files found"
}

# 3. The new test(s) must PASS with the fix in place.
# Resolve the runner while the tree still carries the fix — see _REPRO_TEST_CMD above.
_REPRO_TEST_CMD="$(_repro_file_command "${TEST_FILES[@]}")"
# `if ! run_new_tests ...; then _rc=$?` captured the status of the NEGATION, which is
# always 0 — so _rc was never 3 and the "declares no way to run its tests" branch below
# could not fire. The gate still blocked, but reported "the test(s) FAIL with the fix in
# place": it blamed the fix on a codeline that had never run a test at all, which is the
# wrong investigation. Captured before the test, the way the baseline call already does it.
_rc=0
run_new_tests "${TEST_FILES[@]}" || _rc=$?
if [ "$_rc" -ne 0 ]; then
    # "CANNOT PROVE" IS NOT "PROVED". This exited 0 — so on every codeline whose ecosystem was not
    # Node, the HARD gate that blocks a change shipping no working reproducing test passed
    # vacuously, silently. Steps 3.54 and 3.545 both defer their findings here, so the entire
    # brownfield test-proof chain evaporated on those projects while every step reported success.
    #
    # A codeline that declares no way to run its tests is a real, reportable condition. It is not
    # evidence that the fix ships a working test.
    if [ "$_rc" = "3" ]; then
        log "BLOCKED: ${PROJECT_ROOT} declares no way to run its tests, so this fix's reproducing test cannot be executed — the gate cannot prove it, and will not report that as a pass."
        exit 1
    fi
    if _test_never_ran; then
        # A malformed test still BLOCKS — it cannot be allowed through — but the
        # defect is in the TEST, not the fix. Say so, and show the runner's error.
        log "runner output (first 15 lines):"
        printf '%s\n' "$_LAST_TEST_OUTPUT" | head -15 | sed 's/^/    /' >&2
        block "the new test(s) could not be parsed/compiled and therefore never ran — the TEST is malformed and must be rewritten. This says NOTHING about whether the fix is correct; the fix was never exercised."
    fi
    block "the new test(s) FAIL with the fix in place — the fix is incomplete or the test is wrong."
fi

# 4. Revert ONLY the fix files to baseline (keep the test), re-run.
_reverted=()
for f in "${FIX_FILES[@]}"; do
    if git -C "$PROJECT_ROOT" cat-file -e "${BASELINE_SHA}:${f}" 2>/dev/null; then
        git -C "$PROJECT_ROOT" checkout "$BASELINE_SHA" -- "$f" 2>/dev/null && _reverted+=("$f")
    else
        # File was ADDED by the fix (absent in baseline) — remove it to simulate pre-fix.
        rm -f "$PROJECT_ROOT/$f" 2>/dev/null && _reverted+=("$f")
    fi
done

_repro_ok=1
_baseline_rc=0
run_new_tests "${TEST_FILES[@]}" || _baseline_rc=$?
if [ "$_baseline_rc" -eq 0 ]; then
    _repro_ok=0   # tests PASSED without the fix → they do NOT reproduce the bug
elif [ "$_baseline_rc" -eq 3 ]; then
    # 3 IS "COULD NOT RUN", NOT "FAILED". Every other non-zero here means the test failed on the
    # pre-fix tree, which is exactly what a reproducing test should do — so treating 3 the same way
    # turns "I could not execute anything" into "it reproduces the bug", and the gate PASSES.
    #
    # This is the same vacuous-pass shape as the skip that used to sit at the first call site, one
    # branch further in, and it is why exit 3 has to be handled at EVERY call site rather than once.
    for f in "${_reverted[@]}"; do
        git -C "$PROJECT_ROOT" checkout HEAD -- "$f" 2>/dev/null || true
    done
    block "the test(s) could not be executed against the pre-fix baseline, so nothing proves they reproduce the bug. The fix has been restored."
fi

# 5. Always restore the fix, regardless of outcome.
for f in "${_reverted[@]}"; do
    git -C "$PROJECT_ROOT" checkout HEAD -- "$f" 2>/dev/null || true
done

if [ "$_repro_ok" -ne 1 ]; then
    block "the new test(s) PASS even without the fix — they do NOT reproduce the bug. A reproducing test must fail on the pre-fix baseline."
fi

log "✓ $STORY_ID: the test reproduces the bug (fails on baseline, passes with the fix) — gate passed."
exit 0
