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
_primary_fix="${FIX_FILES[0]}"
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
_ctx_file="$(mktemp 2>/dev/null || echo /tmp/rtw-ctx-$$)"; printf '%s' "$_prompt" > "$_ctx_file"
_max_attempts="${REPRO_TEST_WRITER_MAX_ATTEMPTS:-3}"
_corrective=""

for _attempt in $(seq 1 "$_max_attempts"); do
    _model="$_base_model"; _provider="$_base_provider"
    if [ "$_attempt" -gt 1 ]; then
        _next="$(_ladder_next_model "$_base_model")"
        if [ -n "$_next" ]; then
            _model="$_next"; _provider="$(_provider_for_model "$_model")"; [ -z "$_provider" ] && _provider="$_base_provider"
            log "ladder escalation (attempt ${_attempt}/${_max_attempts}) — ${_base_model} → ${_model}"
        fi
    fi
    # Prepend the self-heal corrective directive (empty on attempt 1). printf '%s' on the prompt
    # so the diff's backslashes/backticks are never re-interpreted.
    { [ -n "$_corrective" ] && printf 'CORRECTIVE GUIDANCE FROM SELF-HEAL (address this FIRST): %s\n\n' "$_corrective"; printf '%s' "$_prompt"; } | \
      AI_GATE_ALLOW_TOOLS=1 \
      EPAM_DANGEROUS_SKIP_APPROVAL=1 \
      EPAM_ALLOWED_WRITE_PATHS="${_target_rel}" \
      EPAM_MAX_ITERATIONS="${REPRO_TEST_WRITER_MAX_ITERATIONS:-15}" \
      EPAM_MAX_OUTPUT_TOKENS="${REPRO_TEST_WRITER_MAX_OUTPUT_TOKENS:-8192}" \
      AI_MODEL="$_model" \
      bash "$AI_RUNNER_CMD" --provider "$_provider" --model "$_model" > "$_writer_log" 2>&1 || true

    [ -f "$PROJECT_ROOT/$_target_rel" ] && { log "test produced on attempt ${_attempt} (model ${_model})"; break; }
    [ "$_attempt" -ge "$_max_attempts" ] && { log "no test after ${_max_attempts} attempts — repro-gate will BLOCK"; break; }

    # Classify the failure and self-heal for the next attempt.
    _fclass="no_file"
    grep -qiE "reached maximum iterations" "$_writer_log" 2>/dev/null && _fclass="max_iterations"
    grep -qiE "ai-run failed|no error output" "$_writer_log" 2>/dev/null && _fclass="provider"
    log "attempt ${_attempt} produced no file (class=${_fclass}) — invoking self-heal analyst"
    _corrective="$(AGENT_ANALYST_STORY_ID="$STORY_ID" AI_RUNNER_CMD="$AI_RUNNER_CMD" bash "$SCRIPT_DIR/agent-attempt-analyst.sh" "$_fclass" "$_writer_log" "$_ctx_file" 2>/dev/null || echo "")"
done
rm -f "$_ctx_file" 2>/dev/null || true

# ── Commit the test if one was written ──────────────────────────────────────
if [ -f "$PROJECT_ROOT/$_target_rel" ]; then
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
