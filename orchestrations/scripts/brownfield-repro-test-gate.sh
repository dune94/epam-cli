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

STORY_ID="${1:?usage: brownfield-repro-test-gate.sh <story_id>}"
PROJECT_ROOT="${PROJECT_ROOT:?PROJECT_ROOT required}"
BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}"

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
TEST_FILES=(); FIX_FILES=()
for f in "${_CHANGED[@]}"; do
    [ -z "$f" ] && continue
    # Never treat dependency/build output as a fix file (a real repo gitignores
    # these, but be defensive — reverting/deleting them would break the runner).
    case "$f" in
        node_modules/*|*/node_modules/*|dist/*|build/*|coverage/*|.git/*) continue ;;
    esac
    case "$f" in
        *.test.*|*.spec.*|*/__tests__/*|*_test.*) TEST_FILES+=("$f") ;;
        *) FIX_FILES+=("$f") ;;
    esac
done

if [ "${#TEST_FILES[@]}" -eq 0 ]; then
    block "no test file accompanies the change — every brownfield change must ship a test that reproduces the fixed behavior."
fi
if [ "${#FIX_FILES[@]}" -eq 0 ]; then
    log "no non-test files changed for $STORY_ID — nothing to revert; reproduction check not applicable, passing"; exit 0
fi

# Pick the test runner (project-local binaries preferred; npm test as fallback).
# Output is CAPTURED, never discarded: the exit code alone cannot distinguish
# "the test could not be parsed" from "the test ran and failed its assertions",
# and those two demand opposite responses. Discarding it caused a live
# misdiagnosis on 2026-07-24 (see _test_never_ran below).
_LAST_TEST_OUTPUT=""
run_new_tests() {
    local _out _rc
    _out=$( cd "$PROJECT_ROOT" || exit 2
      if [ -x node_modules/.bin/vitest ]; then node_modules/.bin/vitest run "$@" 2>&1
      elif [ -x node_modules/.bin/jest ]; then node_modules/.bin/jest "$@" 2>&1
      elif [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then npm test -- "$@" 2>&1
      else exit 3; fi )
    _rc=$?
    _LAST_TEST_OUTPUT="$_out"
    return "$_rc"
}

# Did the test fail to PARSE/COMPILE (i.e. never actually execute), as opposed to
# running and failing an assertion? A test that never ran proves nothing about the
# fix, so blaming the fix for it sends the investigation the wrong way.
_test_never_ran() {
    printf '%s' "$_LAST_TEST_OUTPUT" | grep -qiE \
      "Transform failed|Failed to parse|Failed to load url|SyntaxError|Unexpected token|ERROR: Expected|Cannot find (module|package)|Tests +no tests|No test files found"
}

# 3. The new test(s) must PASS with the fix in place.
if ! run_new_tests "${TEST_FILES[@]}"; then
    _rc=$?
    [ "$_rc" = "3" ] && { log "no supported test runner found — skipping reproduction gate"; exit 0; }
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
if run_new_tests "${TEST_FILES[@]}"; then
    _repro_ok=0   # tests PASSED without the fix → they do NOT reproduce the bug
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
