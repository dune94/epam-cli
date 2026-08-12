#!/usr/bin/env bash
# update-invalidated-tests.sh <story_id>
#
# B12 — a brownfield fix legitimately invalidates PRE-EXISTING tests, and until now
# nobody updated them.
#
# Caught by mock1 (2026-07-24): the story changes getGreeting() 'hello world' ->
# 'hello dolly'; the seeded src/hello.test.ts asserts 'hello world', so after the fix
# it fails. impl may no longer edit tests (B1 — it burned 7 attempts / $1.11 fighting
# a test it should never have written), and brownfield-repro-test-writer.sh only
# AUTHORS A NEW co-located repro test. Nothing updated the stale one, so Step 5's
# regression guard blocked, the phase failed, and the self-heal retry failed
# identically — the pipeline breaking on an artifact it produced itself, exactly like
# the metrolinx deadlock.
#
# For a DEFECT the pre-existing test encodes the BUG, so it must change. But the
# naive version of this step is far more dangerous than the bug it fixes:
#
#   A pre-existing test failing after a fix means EITHER
#     (a) it asserted the buggy behaviour the fix corrects  -> update it, or
#     (b) the fix broke something real                      -> a REGRESSION.
#
# "Make the failing tests pass" would let a WRONG fix rewrite its own oracle. So this
# step is deliberately narrow: the agent is given the Verification Criteria (the
# declared intended behaviour change) and may only update assertions that VC change
# explains. Anything else it must report as a regression, and we BLOCK.
#
# Exit 0 = suite green (either nothing to do, or invalidated tests updated + committed)
# Exit 1 = BLOCKED — a real regression, or the update did not make the suite green.
set -uo pipefail

STORY_ID="${1:?Usage: update-invalidated-tests.sh <story_id>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "repro-test-writer"

PROJECT_ROOT="${PROJECT_ROOT:?PROJECT_ROOT must be set}"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
BASELINE="${JIRA_BASELINE_BRANCH:-develop}"

log() { echo "[update-invalidated-tests] $*" >&2; }

# Only meaningful for brownfield: greenfield has no pre-existing tests to invalidate.
[ "${EPAM_BROWNFIELD:-0}" = "1" ] || { log "not brownfield — nothing to do"; exit 0; }

# ── Run the suite ────────────────────────────────────────────────────────────
run_suite() {
    ( cd "$PROJECT_ROOT" || exit 3
      if   [ -x node_modules/.bin/vitest ]; then node_modules/.bin/vitest run 2>&1
      elif [ -x node_modules/.bin/jest ];   then node_modules/.bin/jest 2>&1
      elif [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then npm test 2>&1
      else exit 3; fi )
}

_out="$(run_suite)"; _rc=$?
if [ "$_rc" -eq 3 ]; then
    log "no supported test runner — nothing to do"; exit 0
fi
if [ "$_rc" -eq 0 ]; then
    log "suite already green — no invalidated tests, nothing to do"; exit 0
fi

log "suite is RED after the fix — deciding whether the failures are invalidated expectations or a real regression"

# Which test files existed BEFORE this story's work? Only those can be "invalidated";
# a test this run just authored is the repro test and is never rewritten here.
_baseline_sha="$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${BASELINE}" 2>/dev/null \
              || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "$BASELINE" 2>/dev/null || echo "")"
_preexisting=""
if [ -n "$_baseline_sha" ]; then
    _preexisting="$(git -C "$PROJECT_ROOT" ls-tree -r --name-only "$_baseline_sha" 2>/dev/null \
                    | grep -iE '\.(test|spec)\.[tj]sx?$|__tests__/' || true)"
fi

# The committed fix, whole. Cut at 6000 bytes it was a partial account of what changed,
# with nothing in the prompt saying so — and this agent's job is to decide which tests the
# fix legitimately invalidated, which cannot be judged from part of the diff.
_fix_diff="$(git -C "$PROJECT_ROOT" diff "${_baseline_sha:-HEAD~1}" HEAD -- . 2>/dev/null \
             | grep -viE '^\+\+\+|^---' || true)"

read -r -d '' _prompt <<PROMPT || true
You are updating tests that a COMMITTED bug fix has legitimately invalidated.

The fix is already committed and is CORRECT — do not change any non-test file.
The test suite is now RED. Your ONLY job is to decide, per failure, which case it is:

 (a) the test asserted the OLD, BUGGY behaviour that this fix deliberately changes
     -> update JUST that assertion to the new expected behaviour.
 (b) the failure is NOT explained by the intended change — the fix broke something
     -> this is a REGRESSION. Do NOT edit anything. Reply with the single line:
        REGRESSION: <one sentence saying what broke>

Case (b) matters more than case (a): silently rewriting a test so a broken fix goes
green destroys the only signal that the fix is wrong. When in doubt, choose (b).

Only these PRE-EXISTING test files may be edited (a test authored during this run is
the new bug-reproducing test and must NEVER be rewritten here):
${_preexisting:-(none)}

=== INTENDED BEHAVIOUR CHANGE (Verification Criteria — the authority on what SHOULD change) ===
${STORY_VERIFICATION_CRITERIA:-(not supplied)}

=== THE COMMITTED FIX (diff) ===
${_fix_diff:-(unavailable)}

=== FAILING TEST OUTPUT ===
$(printf '%s' "$_out")
PROMPT

_agent_log="${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}/update-invalidated-tests-${STORY_ID}.log"
_reply="$(printf '%s' "$_prompt" | \
    EPAM_ALLOWED_WRITE_PATHS="$(printf '%s' "$_preexisting" | tr '\n' ',')" \
    bash "$AI_RUNNER_CMD" 2>"$_agent_log" || echo "")"
printf '%s\n' "$_reply" >> "$_agent_log" 2>/dev/null || true

# The agent judged it a real regression — believe it and BLOCK.
if printf '%s' "$_reply" | grep -qiE '^[[:space:]]*REGRESSION:|REGRESSION:'; then
    log "BLOCKED — reported as a REGRESSION, not an invalidated expectation:"
    printf '%s' "$_reply" | grep -iE 'REGRESSION:' | head -2 | sed 's/^/    /' >&2
    log "the fix is suspect; NOT rewriting any test to hide it"
    exit 1
fi

# Guard: only test files may have changed. A non-test edit here means the agent
# "fixed" the failure by changing production code — never allowed at this step.
# TRACKED modifications only: `git status --porcelain` also lists untracked paths
# (node_modules/, build output), which are not edits the agent made and must not be
# mistaken for "the agent changed a non-test file".
_dirty="$(git -C "$PROJECT_ROOT" diff --name-only 2>/dev/null || true)"
_bad="$(printf '%s\n' "$_dirty" | grep -vE '\.(test|spec)\.[tj]sx?$|__tests__/' | grep -v '^$' || true)"
if [ -n "$_bad" ]; then
    log "BLOCKED — non-test file(s) modified at the test-update step: $(echo "$_bad" | tr '\n' ' ')"
    git -C "$PROJECT_ROOT" checkout -- $_bad 2>/dev/null || true
    exit 1
fi

# Re-run: the update only counts if it actually made the suite green.
_out2="$(run_suite)"; _rc2=$?
if [ "$_rc2" -ne 0 ]; then
    log "BLOCKED — suite still RED after the update attempt (the fix or the update is wrong)"
    printf '%s' "$_out2" | tail -15 | sed 's/^/    /' >&2
    exit 1
fi

if [ -n "$_dirty" ]; then
    git -C "$PROJECT_ROOT" add -- $(printf '%s\n' "$_dirty" | tr '\n' ' ') 2>/dev/null || true
    # Ticket-ID-first message — same commitlint-compatibility fix as
    # brownfield-repro-test-writer.sh's identical commit call (found live
    # 2026-08-02, AMSD-2041 Writer Retest); see that file's comment for the
    # full root cause. Real stderr is captured (not discarded) instead of a
    # generic "(non-fatal)" log line — a client repo's commit-msg hook can
    # reject for ANY reason, and this pipeline cannot and should not
    # hardcode every possible hook's exact rule set per project; surfacing
    # the hook's own output is the generic fix.
    _commit_output=$(git -C "$PROJECT_ROOT" commit -m "${STORY_ID}: update tests invalidated by the fix" --quiet 2>&1)
    _commit_rc=$?
    if [ "$_commit_rc" -eq 0 ]; then
        log "committed updated test(s) — suite green"
        # Reindex CodeGraph so this commit's writes are visible to the
        # reviewer's codegraph_query tool (see codegraph-reindex.sh).
        [ -f "$SCRIPT_DIR/codegraph-reindex.sh" ] && bash "$SCRIPT_DIR/codegraph-reindex.sh" "$PROJECT_ROOT" "post-commit test-update ${STORY_ID}" || true
    else
        log "commit failed. Output: $_commit_output"
    fi
else
    log "suite went green with no test edits"
fi
exit 0
