#!/usr/bin/env bash
# brownfield-repro-test-writer.sh <story_id>
#
# DEDICATED test-writing pass for a brownfield defect (AC/VC/TC design, 2026-07-24).
#
# Why this exists: the repro-gate (brownfield-repro-test-gate.sh) HARD-BLOCKS any
# brownfield change that ships no bug-reproducing test. But asking the impl agent to
# do BOTH the fix AND a good reproducing test in one budget failed live (AMSD-1820
# run #3): the agent understood the requirement, planned the test, but ran out of
# iterations after the fix + scope creep. This pass gives test-writing its OWN agent
# turn + budget, AFTER the fix is committed, so it sees the real fix diff and the VCs,
# and writes a test that MATCHES THE REPO'S CONVENTION (so the gate can actually run it).
#
# Runs BEFORE the repro-gate. Idempotent + safe:
#   - no-op unless EPAM_BROWNFIELD=1
#   - no-op if a test file already accompanies the change (impl already wrote one)
#   - no-op if there are no fix (non-test) files in the diff
#   - the repro-gate still independently validates whatever this writes (fail-on-
#     baseline / pass-with-fix); this pass only ensures a test EXISTS to validate.
#
# Exit: always 0 (best-effort). The repro-gate is the enforcer. Escape: EPAM_SKIP_REPRO_TEST_WRITER=1.
set -uo pipefail

STORY_ID="${1:-}"
PROJECT_ROOT="${PROJECT_ROOT:-}"
PRD_FILE="${PRD_FILE:-}"
BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
NODE_BIN="${NODE_BIN:-node}"
[ -x "/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node" ] && NODE_BIN="/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node"

log()  { echo "[repro-test-writer] $*"; }
# Both B30 (analyst failed) and B31 (no ladder escalation) called `warning`, which
# this script never defined — so bash printed "command not found" and the
# diagnostics were NEVER SEEN. A no-silent-failure fix that fails silently.
warning() { echo "[repro-test-writer] WARNING: $*" >&2; }

# ── Guards ──────────────────────────────────────────────────────────────────
[ "${EPAM_SKIP_REPRO_TEST_WRITER:-0}" = "1" ] && { log "skipped (EPAM_SKIP_REPRO_TEST_WRITER=1)"; exit 0; }
[ "${EPAM_BROWNFIELD:-0}" = "1" ] || { exit 0; }
[ -n "$STORY_ID" ] || { log "no story id — skipping"; exit 0; }
[ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT/.git" ] || { log "no git repo at PROJECT_ROOT — skipping"; exit 0; }

BASELINE_SHA=$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${BASELINE_BRANCH}" 2>/dev/null \
            || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${BASELINE_BRANCH}" 2>/dev/null || echo "")
[ -n "$BASELINE_SHA" ] || { log "baseline '${BASELINE_BRANCH}' not resolvable — skipping"; exit 0; }

# ── Classify changed files (same rule as the repro-gate) ────────────────────
mapfile -t _CHANGED < <(git -C "$PROJECT_ROOT" diff --name-only "$BASELINE_SHA" HEAD 2>/dev/null)
TEST_FILES=(); FIX_FILES=()
for f in "${_CHANGED[@]}"; do
    [ -z "$f" ] && continue
    case "$f" in node_modules/*|*/node_modules/*|dist/*|build/*|coverage/*|.git/*|.epam/*) continue ;; esac
    case "$f" in
        *.test.*|*.spec.*|*/__tests__/*|*_test.*) TEST_FILES+=("$f") ;;
        *) FIX_FILES+=("$f") ;;
    esac
done
[ "${#TEST_FILES[@]}" -gt 0 ] && { log "a test already accompanies the change (${TEST_FILES[0]}) — nothing to write"; exit 0; }
[ "${#FIX_FILES[@]}" -gt 0 ] || { log "no fix files in the diff — nothing to test"; exit 0; }

# ── Detect the repo's test convention so the gate can actually RUN the test ──
# Dominant extension (.spec.ts vs .test.ts), a real example test to mirror style,
# and a co-located target path next to the first fix file.
# B15 — pick a target the test can meaningfully live next to.
# `FIX_FILES[0]` was simply the first changed non-test file, so a lockfile leading
# the diff sent the test to `package-lock.test.ts` — which was then COMMITTED,
# because it parses and runs (validation asked "can this execute?", never "is this
# the right place?"). Caught by the mock1 re-run 2026-07-24.
#
# Authority order:
#   1. the detective's fixSiteAnalysis — it identified the CAUSAL site
#   2. the first changed file that is genuinely testable source
#   3. nothing sensible -> skip; a garbage test is worse than none, and the
#      repro-gate will report the absence honestly.
_is_testable_source() {
    case "$1" in
        # lockfiles / manifests / docs / config / data — never a test target
        package-lock.json|*/package-lock.json|yarn.lock|*/yarn.lock|pnpm-lock.yaml|*/pnpm-lock.yaml) return 1 ;;
        package.json|*/package.json|tsconfig*.json|*/tsconfig*.json) return 1 ;;
        *.md|*.markdown|*.txt|*.json|*.yml|*.yaml|*.toml|*.ini|*.env|*.lock) return 1 ;;
        *.snap|*.png|*.jpg|*.svg|*.ico|*.css|*.scss) return 1 ;;
        # genuinely testable source
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) return 0 ;;
        *) return 1 ;;
    esac
}

_primary_fix=""
# 1. detective fix site, if it is present in this change and testable
if [ -n "$PRD_FILE" ] && [ -f "$PRD_FILE" ]; then
    _det_site=$(jq -r --arg id "$STORY_ID" \
        '(.stories[]? | select(.id == $id) | .fixSiteAnalysis // [])[0].file // ""' \
        "$PRD_FILE" 2>/dev/null || echo "")
    if [ -n "$_det_site" ] && [ "$_det_site" != "null" ] && _is_testable_source "$_det_site"; then
        for f in "${FIX_FILES[@]}"; do
            [ "$f" = "$_det_site" ] && { _primary_fix="$_det_site"; break; }
        done
        # the detective may name a path the diff touched under a different prefix
        [ -z "$_primary_fix" ] && [ -f "$PROJECT_ROOT/$_det_site" ] && _primary_fix="$_det_site"
    fi
fi
# 2. first genuinely testable changed source file
if [ -z "$_primary_fix" ]; then
    for f in "${FIX_FILES[@]}"; do
        if _is_testable_source "$f"; then _primary_fix="$f"; break; fi
    done
fi
# 3. nothing testable changed
if [ -z "$_primary_fix" ]; then
    log "no testable source file in the change (only: ${FIX_FILES[*]}) — nothing to test"
    exit 0
fi
# grep -c already prints "0" on no match (and exits 1) — use `|| true` so the non-zero
# exit doesn't append a SECOND "0" (which broke the integer test: "0\n0" is not an int).
_spec_ct=$(git -C "$PROJECT_ROOT" ls-files '*.spec.ts' '*.spec.tsx' 2>/dev/null | grep -c . || true)
_test_ct=$(git -C "$PROJECT_ROOT" ls-files '*.test.ts' '*.test.tsx' 2>/dev/null | grep -c . || true)
if [ "${_spec_ct:-0}" -ge "${_test_ct:-0}" ] && [ "${_spec_ct:-0}" -gt 0 ]; then _ext="spec.ts"; else _ext="test.ts"; fi
_target_rel="${_primary_fix%.*}.${_ext}"
# An existing example test (prefer one near the fix dir; else the largest/any) to teach the framework + mocking style.
_example_rel=$(git -C "$PROJECT_ROOT" ls-files "$(dirname "$_primary_fix")/*.spec.ts" "$(dirname "$_primary_fix")/*.test.ts" 2>/dev/null | head -1)
[ -z "$_example_rel" ] && _example_rel=$(git -C "$PROJECT_ROOT" ls-files '*.spec.ts' '*.test.ts' 2>/dev/null | head -1)
_example_block=""
if [ -n "$_example_rel" ] && [ -f "$PROJECT_ROOT/$_example_rel" ]; then
    _example_block=$'\n## Example test from THIS repo (mirror its framework, imports, and mocking style EXACTLY)\nFile: '"$_example_rel"$'\n```\n'"$(head -80 "$PROJECT_ROOT/$_example_rel")"$'\n```\n'
fi

# ── Gather the fix diff + the verification criteria ─────────────────────────
_fix_diff=$(git -C "$PROJECT_ROOT" diff "$BASELINE_SHA" HEAD -- "${FIX_FILES[@]}" 2>/dev/null | head -300)
_vcs=$("$NODE_BIN" -e '
  const fs=require("fs");
  try { const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const s=(p.stories||[]).find(x=>x.id===process.argv[2])||{};
    process.stdout.write((s.verificationCriteria||[]).map(v=>"- "+v).join("\n"));
  } catch(e){}' "$PRD_FILE" "$STORY_ID" 2>/dev/null)

log "writing reproducing test for $STORY_ID → $_target_rel (convention: .$_ext, example: ${_example_rel:-none})"

# Activity emit — the test-writer is a first-class agent and MUST be visible in
# agent-activity.html like every other agent (found 2026-07-24: it emitted nothing).
_emit_tw() { bash "$SCRIPT_DIR/update-monitor.sh" event "$1" "$2" "$STORY_ID" "main" "repro-test-writer" 2>/dev/null || true; }
_emit_tw "spec_update" "repro-test-writer started for ${STORY_ID} → ${_target_rel}"

# ── Build the dedicated test-writer prompt ──────────────────────────────────
read -r -d '' _prompt <<PROMPT || true
You are a TEST ENGINEER. Your ONLY job in this turn is to write ONE bug-reproducing test for a fix that has ALREADY been implemented and committed. Do NOT modify any source file — write ONLY the test file.

## VERIFY IT COMPILES BEFORE YOU FINISH
Your test must TYPECHECK, not merely run — a spec that passes the test runner but fails tsc blocks the whole pipeline five steps later. Mock objects are the usual cause: they must satisfy the FULL type, with every required property, and no property the type does not declare. After writing the file, run:
  cd "${PROJECT_ROOT}" && ./node_modules/.bin/tsc --noEmit 2>&1 | grep "${_target_rel}"
If that prints anything, FIX YOUR FILE and re-check before finishing.

## The fix that was just made (diff vs baseline)
\`\`\`diff
${_fix_diff}
\`\`\`

## What the test must confirm (verification criteria — assert the OBSERVABLE outcome, not the mechanism)
${_vcs:-- The behavior described in the ticket is now correct, and related behavior did not regress.}
${_example_block}
## CodeGraph tool — confirm the impl's real signatures/imports (use SPARINGLY, then WRITE)
The fix diff is shown above. If you need the exact signature or import path of a symbol to write a faithful test, look it up with the Bash tool — at most 1-2 calls, then STOP looking and write:
  PROJECT_ROOT="${PROJECT_ROOT}" bash "${SCRIPT_DIR}/codegraph-agent-query.sh" query <SymbolName>    # exact definition + signature + import path
  PROJECT_ROOT="${PROJECT_ROOT}" bash "${SCRIPT_DIR}/codegraph-agent-query.sh" callees <SymbolName>   # what a function calls
Over-exploring here is the #1 failure mode — do the MINIMUM lookup, then WriteFile immediately.

## HARD REQUIREMENTS
1. Write the test to EXACTLY this path (nothing else, no other files): ${PROJECT_ROOT}/${_target_rel}
2. Use the SAME test framework, import style, and mocking approach as the example above (this repo uses .${_ext}). The test MUST be runnable by the repo's existing test runner — match its conventions so it is picked up.
3. The test MUST genuinely REPRODUCE the bug: it must FAIL against the pre-fix code and PASS with the fix. Assert the corrected observable value (e.g. the return-trip discount is present/correct) — a test that passes regardless of the fix is worthless and will be rejected.
4. Write REAL arrange/act/assert cases. Do NOT paste source code into the test. Do NOT use a bare filename like 'test'. Do NOT put a newline or space in the path.
5. Call WriteFile ONCE with the full test content at the path above, then stop.
PROMPT

# ── HIGH-ladder helpers (glm-5.1 → kimi-k3), same maps the detective/reviewer use ──
# B31: a ladder that does not escalate must say WHY. Empty previously collapsed
# three cases into one silent outcome: at the ceiling (fine), model not on the
# ladder (misconfiguration — escalation silently never happens), and ladder unset
# (no escalation at all this run). "The ladder didn't help" and "the ladder never
# ran" are very different diagnoses.
_ladder_skip_reason() {
    local _m="$1" _map="$2"
    if [ -z "$_map" ]; then
        echo "ladder is EMPTY/unset — NO escalation configured for this run"
    elif printf '%s' "$_map" | grep -qF -- "=${_m}"; then
        echo "at ladder ceiling (${_m}) — no further escalation available"
    else
        echo "model '${_m}' is NOT on the ladder — escalation impossible (renamed model or stale map?)"
    fi
}

_ladder_next_model() {
    local _m="$1" _map="${EPAM_MODEL_LADDER_HIGH:-${EPAM_MODEL_LADDER:-}}" _pair
    IFS='|' read -ra _pairs <<< "$_map"
    for _pair in "${_pairs[@]}"; do case "$_pair" in "${_m}="*) echo "${_pair#*=}"; return 0 ;; esac; done
    echo ""
}
_provider_for_model() {
    local _m="$1" _map="${EPAM_MODEL_PROVIDER_MAP:-}" _pair _pat _prov
    IFS='|' read -ra _pairs <<< "$_map"
    for _pair in "${_pairs[@]}"; do _pat="${_pair%%=*}"; _prov="${_pair#*=}"; case "$_m" in $_pat) echo "$_prov"; return 0 ;; esac; done
    echo ""
}

# ── Invoke the write-capable agent, with RETRY + LADDER + SELF-HEAL ──
# Single-shot failed live 2026-07-24: the agent burned all 15 iterations exploring and never
# wrote the test ("reached maximum iterations"). Same failure class as the detective. Now:
# retry (ladder up the HIGH ladder on escalation), and on a no-file/max-iter failure run the
# reusable agent-attempt-analyst to diagnose WHY and prepend a tailored corrective directive
# to the next attempt — instead of blindly re-running the same prompt.
_base_provider="${SPEC_MODE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-qwen}}"
_base_model="${SPEC_MODE_SPECKIT_MODEL:-${ESCALATION_MODEL_HIGH:-z-ai/glm-5.1}}"
_writer_log="${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}/repro-test-writer-${STORY_ID}.log"
_test_validated=0

# ── Validate the written test can actually be PARSED and EXECUTED ────────────
# Returns: 0 = runnable (parsed and executed — pass OR assertion-failure)
#          1 = NOT runnable (parse/transform error, or nothing collected)
#          3 = no usable test runner in this project — cannot validate
#
# The pass/fail VERDICT is deliberately NOT decided here: a test that runs and
# fails its assertions is a legitimate outcome that belongs to the repro-gate
# (it is how the gate proves the bug reproduces). This function only answers
# "can this file run at all?" — because a file that cannot run proves nothing
# and, once committed, breaks the regression guard for every later cycle.
# A generated test must COMPILE, not merely execute. vitest strips types rather
# than checking them, so a spec can run green and still fail tsc — which is exactly
# how the live metrolinx run died at Step 19 with TS2352 (a mock missing a required
# field) AFTER the fix, the test, the repro-gate and the team-lead review had all
# passed. Checking here means the writer still has a retry and a stronger model.
#
# SCOPED TO THE FILE JUST WRITTEN. Brownfield repos carry pre-existing type errors;
# failing on any tsc error would reject good tests in every real client repo.
_typecheck_written_test() {
    local rel="$1"
    local _tsc="$PROJECT_ROOT/node_modules/.bin/tsc"
    [ -x "$_tsc" ] || return 0
    [ -f "$PROJECT_ROOT/tsconfig.json" ] || return 0

    local _out
    _out=$(cd "$PROJECT_ROOT" && "$_tsc" --noEmit 2>&1)
    if printf '%s\n' "$_out" | grep -qF "${rel}("; then
        _typecheck_feedback="

## COMPILER ERRORS FROM YOUR PREVIOUS ATTEMPT — FIX THESE
Your last test ran but did NOT compile. tsc reported, for this exact file:
\`\`\`
$(printf '%s\n' "$_out" | grep -F "${rel}(" | head -8)
\`\`\`
Rewrite the file so these are gone. Mock objects must satisfy the full type."
        log "written test FAILS TYPECHECK — rejecting so the writer can retry:"
        printf '%s\n' "$_out" | grep -F "${rel}(" | head -5 | sed 's/^/    /'
        printf '%s\n' "$_out" | grep -F "${rel}(" >> "$_writer_log" 2>/dev/null || true
        return 1
    fi
    return 0
}

_validate_written_test() {
    local rel="$1" out="" json=""
    # DETERMINISTIC: ask the runner for machine-readable output and decide on a
    # NUMBER, not on English phrases.
    #
    # B22 (2026-07-24): this used to grep the terminal dump for ten patterns, one of
    # which was `ERROR: Expected` (esbuild's parse error). vitest's ordinary
    # `AssertionError: expected undefined to deeply equal ...` matches that
    # case-insensitively, so EVERY assertion failure was classified as unparseable.
    # Live cost: a genuine reproducing test (`4 tests | 1 failed`) was discarded on
    # all three attempts, the ladder escalated to kimi-k3, and the repro-gate then
    # blocked for "no test file". The pipeline threw away a working test 3 times.
    #
    # Exit code cannot separate the cases (both non-zero). numTotalTests can:
    #   assertion failure (VALID):  numTotalTests=1  numFailed=1
    #   parse error      (INVALID): numTotalTests=0  + a suite-level failureMessage
    # An assertion failure IS valid here — a reproducing test is SUPPOSED to fail
    # before the fix. Whether it reproduces the bug is the repro-gate's call, not
    # this function's.
    if [ -x "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
        json=$(cd "$PROJECT_ROOT" && ./node_modules/.bin/vitest run "$rel" --reporter=json 2>/dev/null)
    elif [ -x "$PROJECT_ROOT/node_modules/.bin/jest" ]; then
        json=$(cd "$PROJECT_ROOT" && ./node_modules/.bin/jest "$rel" --json 2>/dev/null)
    elif [ -f "$PROJECT_ROOT/package.json" ] && grep -q '"test"' "$PROJECT_ROOT/package.json" 2>/dev/null; then
        out=$(cd "$PROJECT_ROOT" && npm test -- "$rel" 2>&1)
    else
        return 3
    fi

    if [ -n "$json" ]; then
        printf '%s\n' "$json" >> "$_writer_log" 2>/dev/null || true
        local total
        total=$("$NODE_BIN" -e '
            let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              try{ const j=JSON.parse(s.slice(s.indexOf("{")));
                   process.stdout.write(String(j.numTotalTests ?? 0)); }
              catch { process.stdout.write("-1"); }   // unparseable JSON -> fall back
            });' <<< "$json" 2>/dev/null || echo "-1")
        if [ "$total" = "-1" ]; then
            out="$json"          # no usable JSON — fall through to the text heuristic
        elif [ "${total:-0}" -gt 0 ]; then
            # Executed is necessary but NOT sufficient — it must also compile.
            _typecheck_written_test "$rel" || return 1
            return 0             # tests EXECUTED and TYPECHECKED => valid
        else
            return 1             # nothing ran => the file never executed
        fi
    fi

    # FALLBACK for runners with no JSON reporter. Deliberately narrow: only
    # unambiguous "never ran" signals. `ERROR: Expected` is NOT here — it is what
    # broke this function.
    printf '%s\n' "$out" >> "$_writer_log" 2>/dev/null || true
    if printf '%s' "$out" | grep -qiE "Transform failed|Failed to parse|Failed to load url|SyntaxError|Cannot find (module|package)"; then
        return 1
    fi
    if printf '%s' "$out" | grep -qiE "Tests +no tests|No test files found|no tests found"; then
        return 1
    fi
    _typecheck_written_test "$rel" || return 1
    return 0
}
# Compiler errors from the PREVIOUS attempt, injected into the next prompt.
#
# NOT the banned self-heal prose channel: that ban covers accumulated cross-run KB
# knowledge injected as advice. This is the compiler's own output about the file
# THIS agent just wrote in THIS attempt — in-band, deterministic, tied to the exact
# action, the same category as a gate rejection returned as a tool result.
# Withholding it makes the agent guess at an error the toolchain knows exactly.
_typecheck_feedback=""
_ctx_file="$(mktemp 2>/dev/null || echo /tmp/rtw-ctx-$$)"; printf '%s' "$_prompt" > "$_ctx_file"
_max_attempts="${REPRO_TEST_WRITER_MAX_ATTEMPTS:-3}"
# Self-heal enforcement seam: constraints compiled onto this shell's knobs.
_kb_apply_lib="$SCRIPT_DIR/lib/kb-apply.sh"
# shellcheck disable=SC1090
[ -f "$_kb_apply_lib" ] && . "$_kb_apply_lib"


for _attempt in $(seq 1 "$_max_attempts"); do
    _model="$_base_model"; _provider="$_base_provider"
    if [ "$_attempt" -gt 1 ]; then
        _next="$(_ladder_next_model "$_base_model")"
        if [ -n "$_next" ]; then
            _model="$_next"; _provider="$(_provider_for_model "$_model")"; [ -z "$_provider" ] && _provider="$_base_provider"
            log "ladder escalation (attempt ${_attempt}/${_max_attempts}) — ${_base_model} → ${_model}"
        else
            warning "NO ladder escalation on attempt ${_attempt}/${_max_attempts} — $(_ladder_skip_reason "$_base_model" "${EPAM_MODEL_LADDER_HIGH:-${EPAM_MODEL_LADDER:-}}")"
        fi
    fi
    # Prepend the self-heal corrective directive (empty on attempt 1). printf '%s' on the prompt
    # so the diff's backslashes/backticks are never re-interpreted.
    # Self-heal arrives as ENFORCEMENT, never as prompt text. The analyst's
    # diagnosis became a validated Constraint; kb_apply_constraints compiles it
    # onto this shell's knobs (iteration budget, tool scope, output schema) before
    # the retry. Prose here would be silently trimmed on a long prompt with nothing
    # verifying the agent obeyed it — which is why the channel is banned.
    kb_apply_constraints "${STORY_ROLE:-repro-test-writer}" "story:${STORY_ID:-}" || true
    # 30, not 15. Live 2026-07-25: attempts 1 AND 2 both died with
    # class=max_iterations at 15, on two different models — the agent explored the
    # codebase and never wrote the file. The prompt now also asks it to typecheck
    # its own output, which costs turns. Self-heal should raise this itself, but
    # the model keeps proposing to LOWER it and the sanity guard (correctly)
    # refuses, so the floor has to be right to begin with.
    # An APPLIED constraint must win over the site default. These prefixes used to
    # hardcode the knobs, so kb_apply_constraints exported 40, logged success, and
    # the call site clobbered it back to 15 one line later — every layer reporting
    # success while the agent ran unconstrained. Worse: the Pillar 3 digest covers
    # EPAM_MAX_ITERATIONS, so in a REAL run ai-run.sh would have detected the drift
    # and ABORTED every retry. Found by the induced-failure test, not by a run.
    { printf '%s' "$_prompt"; [ -n "$_typecheck_feedback" ] && printf '%s' "$_typecheck_feedback"; } | \
      AI_GATE_ALLOW_TOOLS=1 \
      EPAM_DANGEROUS_SKIP_APPROVAL=1 \
      EPAM_ALLOWED_WRITE_PATHS="${_target_rel}" \
      EPAM_MAX_ITERATIONS="${EPAM_MAX_ITERATIONS:-${REPRO_TEST_WRITER_MAX_ITERATIONS:-30}}" \
      EPAM_MAX_OUTPUT_TOKENS="${EPAM_MAX_OUTPUT_TOKENS:-${REPRO_TEST_WRITER_MAX_OUTPUT_TOKENS:-32768}}" \
      AI_MODEL="$_model" \
      bash "$AI_RUNNER_CMD" --provider "$_provider" --model "$_model" > "$_writer_log" 2>&1 || true

    # A file existing is NOT success. The agent can (and live, on 2026-07-24, DID)
    # write a test with a syntax error; committing it both proves nothing and
    # poisons every later gate. Validate that it actually PARSES AND RUNS first.
    _fclass_override=""
    if [ -f "$PROJECT_ROOT/$_target_rel" ]; then
        _validate_written_test "$_target_rel"
        case "$?" in
            0) _test_validated=1
               log "test produced and validated on attempt ${_attempt} (model ${_model})"
               break ;;
            3) _test_validated=1
               log "test produced on attempt ${_attempt} (model ${_model}) — no usable test runner, cannot validate (not treated as failure)"
               break ;;
            *) log "attempt ${_attempt}: test was written but does NOT parse/run — discarding it (class=invalid_test)"
               # Remove it so a later attempt starts clean and no stale broken file
               # can ever reach the commit step.
               rm -f "$PROJECT_ROOT/$_target_rel" 2>/dev/null || true
               _fclass_override="invalid_test" ;;
        esac
    fi
    [ "$_attempt" -ge "$_max_attempts" ] && { log "no valid test after ${_max_attempts} attempts — repro-gate will BLOCK"; break; }

    # Classify the failure and self-heal for the next attempt.
    _fclass="no_file"
    grep -qiE "reached maximum iterations" "$_writer_log" 2>/dev/null && _fclass="max_iterations"
    grep -qiE "ai-run failed|no error output" "$_writer_log" 2>/dev/null && _fclass="provider"
    [ -n "$_fclass_override" ] && _fclass="$_fclass_override"
    log "attempt ${_attempt} failed (class=${_fclass}) — invoking self-heal analyst"
    # B30: capture the analyst's exit instead of swallowing it. rc=2 means the
    # analyst itself failed, so the next attempt runs with NO corrective — that
    # must be visible, not inferred later from a confusing retry log.
    # The analyst returns NOTHING now: it records an episode and synthesises a
    # constraint. Its exit code still matters (B30) — rc=2 means self-heal itself
    # failed and the retry proceeds with no enforcement.
    AGENT_ANALYST_STORY_ID="$STORY_ID" STORY_ROLE="${STORY_ROLE:-repro-test-writer}" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" \
        bash "$SCRIPT_DIR/agent-attempt-analyst.sh" "$_fclass" "$_writer_log" "$_ctx_file" 2>>"$_writer_log"
    _analyst_rc=$?
    if [ "$_analyst_rc" -eq 2 ]; then
        warning "  self-heal analyst FAILED (class=${_fclass}) — attempt $((_attempt + 1)) retries WITHOUT corrective guidance"
        _emit_tw "error" "self-heal analyst failed for ${STORY_ID} (${_fclass}) — retry has no corrective guidance"
    else
        log "  self-heal analyst ran for attempt $((_attempt + 1)) — enforcement applied from the KB"
    fi
done
rm -f "$_ctx_file" 2>/dev/null || true

# ── Commit the test if one was written ──────────────────────────────────────
# Only a VALIDATED test may be committed — an unparseable one proves nothing and
# breaks the regression guard on every subsequent cycle (live deadlock 2026-07-24).
if [ -f "$PROJECT_ROOT/$_target_rel" ] && [ "${_test_validated:-0}" = "1" ]; then
    git -C "$PROJECT_ROOT" add "$_target_rel" 2>/dev/null || true
    if ! git -C "$PROJECT_ROOT" diff --cached --quiet 2>/dev/null; then
        git -C "$PROJECT_ROOT" commit -m "test: add bug-reproducing test for ${STORY_ID}" --quiet 2>/dev/null \
            && log "committed reproducing test: $_target_rel" \
            || log "commit failed (non-fatal) — repro-gate will report"
    fi
    _emit_tw "spec_update" "repro-test-writer committed reproducing test: ${_target_rel}"
else
    log "no test file produced at $_target_rel — the repro-gate will BLOCK (as designed)"
    _emit_tw "error" "repro-test-writer produced NO test for ${STORY_ID} — repro-gate will BLOCK"
fi
exit 0
