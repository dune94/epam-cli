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

# _run_project_verification <project_root>
# Runs the project's declared check (.epam/verification.json) via the verification plugin.
# The engine names no tool, extension, directory or runtime path. Undeclared -> non-zero with a
# reason, never a silent pass.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _auto="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}"
    local _plugin="${_auto}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then echo "verification plugin missing at $_plugin"; return 2; fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}


STORY_ID="${1:-}"
PROJECT_ROOT="${PROJECT_ROOT:-}"
PRD_FILE="${PRD_FILE:-}"
BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Immediately after SCRIPT_DIR, because the source line NEEDS it: placed earlier (as it
# briefly was) the script dies with "SCRIPT_DIR: unbound variable" before doing anything.
source "$SCRIPT_DIR/lib/jq-vals.sh"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# EVERY ENTRY POINT READS THE LADDER DECLARATION ITSELF.
#
# lib/model-ladders.sh exists so that "what a tier contains" is declared once and read the same
# way everywhere. Only claude.sh, run-agent-orchestration.sh and detective-rerun.sh ever called
# it, so this script resolved its model ONLY from environment its parent happened to export. Run
# standalone — a replay, a retest, a test harness — nothing set EPAM_MODEL_LADDER_<TIER>,
# seam_ladder_export set no EPAM_MODEL, and this seam skipped its work while exiting 0.
#
# export_model_ladders leaves an already-set value alone, so calling it here changes nothing when
# the orchestrator has already exported the chain, and supplies it when nobody has.
_ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
if [ -f "$_ml_lib" ]; then
    # shellcheck source=lib/model-ladders.sh
    . "$_ml_lib" || true
    command -v export_model_ladders >/dev/null 2>&1 \
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json}" || true
fi
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# WHICH SEAM THIS SCRIPT IS — stated ONCE, and used for both the ladder export and the rung state.
# Two copies of a name is one defect waiting: the export and the escalation would drift apart and
# the agent would climb a ladder recorded against a different identity than the one it declared.
_SEAM_NAME="repro-test-writer"
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
# WHICH AGENT THIS IS — declared ONCE, and exported so ai-run.sh keys this agent's ladder rung
# state to it. Without it every agent shared one counter ("agent__<story>"): one agent escalating
# advanced the ladder for all of them, and team-lead-review's cross-process resume read a key
# nothing ever wrote.
export EPAM_AGENT_NAME="$_SEAM_NAME"
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "$_SEAM_NAME"
# The SHARED ladder handler — the same one the writer, reviewer and analyst use.
# shellcheck source=lib/agent-ladder.sh
. "$SCRIPT_DIR/lib/agent-ladder.sh" 2>/dev/null || true

AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
NODE_BIN="${NODE_BIN:-node}"
# Resolved, never pinned: package.json declares the requirement (engines.node) and
# lib/node-bin.sh finds an interpreter that meets it. The path that was here was
# valid on one machine, for one nvm install, until that version was upgraded.
. "$(dirname "${BASH_SOURCE[0]}")/lib/node-bin.sh" 2>/dev/null || . "$(dirname "${BASH_SOURCE[0]}")/../lib/node-bin.sh"
NODE_BIN="$(resolve_node_bin)"

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

# WHICH FILE CARRIES THE FEATURE — ASKED, NOT GUESSED BY POSITION.
#
# What stood here took fixSiteAnalysis[0] — first in the list, an accident of ordering. On
# AMSD-2041 that was the SETUP site (the SDK config), so the test asserted configuration flags
# while the file carrying the behaviour was never a candidate, and vc-coverage then judged all
# four criteria against it and reported three uncovered.
#
# The plan names several sites and says what each one DOES; picking by index discards that. The
# agent already receives the plan and the verification criteria as declared inputs, so it is asked
# which site a test would have to exercise to prove the criteria — one path, nothing else.
#
# ITS ANSWER IS VALIDATED, NOT TRUSTED. The chosen path becomes EPAM_ALLOWED_WRITE_PATHS, the only
# place this agent may write, so an unchecked answer would widen the write perimeter on the
# agent's own say-so. It must be a testable source file that this change actually touched.
_primary_fix=""
_choose_target() {
    [ -x "$AI_RUNNER_CMD" ] || return 1
    local _sites _vcs _cands _ask _ans
    _sites=$(jq -r --arg id "$STORY_ID" \
        '(.stories[]? | select(.id == $id) | .fixSiteAnalysis // [])[] | "  - \(.file): \(.finding // .reason // .change // "")"' \
        "$PRD_FILE" 2>/dev/null | head -20)
    _vcs=$(jq -r --arg id "$STORY_ID" \
        '(.stories[]? | select(.id == $id) | .verificationCriteria // [])[] | "  - \(if type=="object" then (.criterion // .text // tostring) else tostring end)"' \
        "$PRD_FILE" 2>/dev/null | head -20)
    _cands=$(printf '  - %s\n' "${FIX_FILES[@]}")
    _ask=$(printf 'A change was made and must now be covered by ONE test.\n\nFiles this change touched:\n%s\n\nThe plan'"'"'s sites and what each does:\n%s\n\nWhat the test must prove:\n%s\n\nWhich ONE of the touched files carries the behaviour a test would exercise to prove those criteria? Not the file that merely configures or wires it — the one whose logic would be wrong if the criteria failed.\n\nReply with the file path only, exactly as listed above. No prose.\n' \
        "$_cands" "${_sites:-  (none recorded)}" "${_vcs:-  (none recorded)}")
    _ans=$(printf '%s' "$_ask" | EPAM_MAX_ITERATIONS=3 EPAM_MAX_OUTPUT_TOKENS=256 \
        "$AI_RUNNER_CMD" 2>/dev/null | tr -d '\r' | grep -oE '[A-Za-z0-9_./-]+\.[A-Za-z]+' | head -1)
    [ -n "$_ans" ] || return 1
    _is_testable_source "$_ans" || { warning "target choice '"'"'$_ans'"'"' is not testable source — ignoring"; return 1; }
    local _f
    for _f in "${FIX_FILES[@]}"; do
        if [ "$_f" = "$_ans" ]; then printf '%s' "$_ans"; return 0; fi
    done
    warning "target choice '"'"'$_ans'"'"' is not among the files this change touched — ignoring"
    return 1
}
if [ -n "$PRD_FILE" ] && [ -f "$PRD_FILE" ] && [ "${EPAM_TEST_TARGET_ASK:-1}" = "1" ]; then
    _primary_fix="$(_choose_target || echo "")"
    [ -n "$_primary_fix" ] && log "target chosen by the agent from the plan and the criteria: $_primary_fix"
fi
# 2. THE DETECTIVE'S FIX SITE — deterministic, and it outranks diff order.
#
# This step existed and was lost when the agent ASK above was added: the chain became
# "ask the model, else take whatever the diff happens to list first". When the ask
# returns nothing usable — an unparseable reply, a file outside the change, any run
# where the model declines — selection silently fell back to diff ORDER, discarding the
# one input that actually identified the causal site. B15 covers exactly this: the
# detective named src/zzz.ts, the diff listed src/aaa.ts first, and the test was written
# against aaa.
#
# The ask stays; it can read the criteria and the plan together. But a model that
# answers nothing must fall back to the PLAN, not to alphabetical accident.
if [ -z "$_primary_fix" ] && [ -n "$PRD_FILE" ] && [ -f "$PRD_FILE" ]; then
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
    [ -n "$_primary_fix" ] && log "target from the plan's fix site: $_primary_fix"
fi
# 3. first genuinely testable changed source file
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
# NOT truncated. This diff is the ONLY description of what the fix did, and the test is
# derived from it: a cap meant the writer saw a partial fix and wrote a test for the
# visible part, with nothing saying the rest existed. team-lead-review.sh solved the same
# problem honestly — it bounds the diff AND marks the truncation in the prompt ("do not
# assume the omitted tail is defect-free"). Silent cutting is the defect, not length.
_fix_diff=$(git -C "$PROJECT_ROOT" diff "$BASELINE_SHA" HEAD -- "${FIX_FILES[@]}" 2>/dev/null)
_vcs=$("$NODE_BIN" -e '
  const fs=require("fs");
  try { const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const s=(p.stories||[]).find(x=>x.id===process.argv[2])||{};
    process.stdout.write((s.verificationCriteria||[]).map(v=>"- "+v).join("\n"));
  } catch(e){}' "$PRD_FILE" "$STORY_ID" 2>/dev/null)

# ── What kind of proof does this story need? ────────────────────────────────
# A DEFECT is proved by reproduction: the test must fail on the pre-fix baseline
# and pass with the fix (the repro-gate then verifies exactly that). A NOVEL story
# has no prior bug and no failing baseline behaviour, so "write a test that
# reproduces the bug" is an instruction it cannot satisfy — the same impossible
# demand fe5d6cb removed from the gate one step later. Its proof is the
# verification criteria: assert the observable outcome the change now produces.
#
# storyKind is set by the spec pass and anchored to Jira ground truth (issueType
# "Bug" forces defect). Absent/unknown classification defaults to the defect
# wording, matching the gate's own safe-side default.
_story_kind=$(jq -r --arg id "$STORY_ID" \
    '.stories[]? | select(.id == $id) | .storyKind // ""' "$PRD_FILE" 2>/dev/null || echo "")
if [ "$_story_kind" = "novel" ]; then
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/repro-role-vals-XXXXXX.json")
    jq -n \
          '{}' > "$_cp_vals"
    # EVERY PIECE OF PROSE FROM THE SAME FILE. The role sentence was rendered from the template
    # while the sentence that actually decides whether the test is acceptable sat here as a shell
    # literal — unreviewable, and impossible to diff against the role it pairs with.
    _prompt_role="$(render_engine_prompt repro-role "$_cp_vals" proves_committed_change)"
    _diff_heading="$(render_engine_prompt repro-role "$_cp_vals" heading_proves_committed_change)"
    _req_proof="$(render_engine_prompt repro-role "$_cp_vals" proof_proves_committed_change)"
    rm -f "$_cp_vals"
    _log_noun="test"
    _commit_noun="test"
else
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/repro-role-vals-XXXXXX.json")
    jq -n \
          '{}' > "$_cp_vals"
    _prompt_role="$(render_engine_prompt repro-role "$_cp_vals" reproduces_fixed_bug)"
    _diff_heading="$(render_engine_prompt repro-role "$_cp_vals" heading_reproduces_fixed_bug)"
    _req_proof="$(render_engine_prompt repro-role "$_cp_vals" proof_reproduces_fixed_bug)"
    rm -f "$_cp_vals"
    _log_noun="reproducing test"
    _commit_noun="bug-reproducing test"
fi

log "writing ${_log_noun} for $STORY_ID (kind: ${_story_kind:-unclassified}) → $_target_rel (convention: .$_ext, example: ${_example_rel:-none})"

# Activity emit — the test-writer is a first-class agent and MUST be visible in
# agent-activity.html like every other agent (found 2026-07-24: it emitted nothing).
_emit_tw() { bash "$SCRIPT_DIR/update-monitor.sh" event "$1" "$2" "$STORY_ID" "main" "repro-test-writer" 2>/dev/null || true; }
_emit_tw "spec_update" "repro-test-writer started for ${STORY_ID} → ${_target_rel}"

# ── Build the dedicated test-writer prompt ──────────────────────────────────
# THE PROMPT IS A DOCUMENT, NOT A SHELL STRING.
#
# It lived here as a heredoc — one of the 34 prompts embedded in scripts. Prompt prose in a shell
# string is live code: a quote ends the string, a backtick executes. It also could not be reviewed
# or corrected without editing the engine. The template is never run; the project-authority copy is.
# THE PROJECT'S OWN TYPECHECK COMMAND, not an engine function.
#
# The prompt used to tell the agent to run `_run_project_verification` — defined in claude.sh, and
# therefore absent from the agent's bash subprocess. It failed to stderr, the grep matched nothing,
# and the agent concluded its file typechecked. Verified in the trace of 2026-08-20: "no output
# means no typecheck errors for our file".
#
# Absent is absent: a codeline that declares no typecheck is TOLD so, and the prompt then asks for
# no verification it cannot perform, rather than naming a command that silently succeeds.
_typecheck_cmd=$("${NODE_BIN:-node}" -e '
  try {
    const p = require(process.argv[1]);
    const v = p.detectVerification(process.argv[2]) || {};
    process.stdout.write(((v.typecheck || {}).command) || "");
  } catch { process.stdout.write(""); }
' "$AUTOMATION_DIR/plugins/verification-plugin.js" "$PROJECT_ROOT" 2>/dev/null || echo "")
if [ -z "$_typecheck_cmd" ]; then
    _typecheck_cmd="echo '(this codeline declares no typecheck command — skip this check and say so in your summary)'"
fi

_prompt_values=$(mktemp)
"${NODE_BIN:-node}" -e '
  const fs = require("fs");
  const [out, ...pairs] = process.argv.slice(1);
  const v = {};
  for (let i = 0; i < pairs.length; i += 2) v[pairs[i]] = pairs[i + 1] ?? "";
  fs.writeFileSync(out, JSON.stringify(v));
' "$_prompt_values" \
  __PROJECT_ROOT__ "$PROJECT_ROOT" \
  __SCRIPT_DIR__ "$SCRIPT_DIR" \
  __DIFF_HEADING__ "$_diff_heading" \
  __EXAMPLE_BLOCK__ "$_example_block" \
  __EXT__ "$_ext" \
  __FIX_DIFF__ "$_fix_diff" \
  __PROMPT_ROLE__ "$_prompt_role" \
  __REQ_PROOF__ "$_req_proof" \
  __TARGET_REL__ "$_target_rel" \
  __TYPECHECK_COMMAND__ "$_typecheck_cmd" \
  __VCS__ "${_vcs:-- The behavior described in the ticket is now correct, and related behavior did not regress.}"
_prompt=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
    render repro-test-writer "${EPAM_PROJECT_CONFIG_DIR:-}" "$_prompt_values") || {
    rm -f "$_prompt_values"
    log "FATAL: the repro-test-writer prompt did not render — refusing to invoke a test writer with no instructions"
    exit 1
}
rm -f "$_prompt_values"

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

# _ladder_next_model was removed 2026-08-14: it walked a chain pinned to the HIGH tier while this
# seam declares its own, and it became unreachable when the escalation moved to the shared handler.
# A dead private chain is worse than none — the next reader assumes it is what runs.
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
# THE SEAM DECIDES, NOT THIS FILE. seam_ladder_export (line ~61) sets EPAM_MODEL to the first rung
# of the chain this seam's archetype declares. The literal that stood here overrode that silently:
# the seam asked for its ladder, and the answer was thrown away one variable later, so changing the
# declared tier changed nothing at all. A missing EPAM_MODEL is a misconfiguration to report, never
# a model to guess.
_base_model="${EPAM_MODEL:-}"
if [ -z "$_base_model" ]; then
    warning "no model resolved for this seam — its archetype declares no ladder, or the tier's chain is unset. Skipping test authorship rather than guessing a model."
    exit 0
fi
# The identity the shared ladder records rungs against — the same seam name declared above, never
# a second copy of it.
_LADDER_AGENT="$_SEAM_NAME"
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
    # The PROJECT's declared check. The old form required a specific binary AND a specific
    # manifest filename, so any other stack returned 0 — a silent pass, not a check.
    local _out
    _out=$(_run_project_verification "$PROJECT_ROOT" 2>&1) || true
    if printf '%s\n' "$_out" | grep -qF "${rel}("; then
        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/repro-feedback-vals-XXXXXX.json")
        jq_vals \
              --arg compiler_errors "$(printf '%s\n' "$_out" | grep -F "${rel}(" | head -8)" \
              '{"__COMPILER_ERRORS__":$compiler_errors}' > "$_cp_vals"
        _typecheck_feedback="$(render_engine_prompt repro-feedback "$_cp_vals" typecheck)"
        rm -f "$_cp_vals"
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
        # FAILED ASSERTIONS ARE NOT VALID HERE. The old rule said "a reproducing test
        # is SUPPOSED to fail before the fix" — but this writer runs AFTER the fix is
        # committed (story execution -> writer -> repro-gate). The fix is already in
        # the tree, so a failing assertion means the test CONTRADICTS it, and the
        # repro-gate says exactly that one step later, where nothing can retry.
        #
        # The gate's contract splits cleanly: it owns "fails on the pre-fix
        # baseline" (only it can check the baseline out); the writer owns "passes
        # with the fix", which is checkable right here while retries and the ladder
        # are still available.
        local _failed
        _failed=$("$NODE_BIN" -e '
            let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              try{ const j=JSON.parse(s.slice(s.indexOf("{")));
                   process.stdout.write(String(j.numFailedTests ?? 0)); }
              catch { process.stdout.write("0"); }
            });' <<< "$json" 2>/dev/null || echo 0)

        if [ "$total" = "-1" ]; then
            out="$json"          # no usable JSON — fall through to the text heuristic
        elif [ "${total:-0}" -gt 0 ] && [ "${_failed:-0}" -gt 0 ]; then
            log "written test FAILS against the committed fix (${_failed}/${total}) — rejecting so the writer can retry"
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/repro-feedback-vals-XXXXXX.json")
            jq_vals \
                  --arg failure_json "$(printf '%s' "$json" | head -c 1200)" \
                  --arg failed "${_failed}" \
                  --arg total "${total}" \
                  '{"__FAILURE_JSON__":$failure_json,"__FAILED__":$failed,"__TOTAL__":$total}' > "$_cp_vals"
            _assertion_feedback="$(render_engine_prompt repro-feedback "$_cp_vals" assertions)"
            rm -f "$_cp_vals"
            return 1
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
_assertion_feedback=""
_ctx_file="$(mktemp 2>/dev/null || echo /tmp/rtw-ctx-$$)"; printf '%s' "$_prompt" > "$_ctx_file"
_max_attempts="${REPRO_TEST_WRITER_MAX_ATTEMPTS:-3}"
# Self-heal enforcement seam: constraints compiled onto this shell's knobs.
_kb_apply_lib="$SCRIPT_DIR/lib/kb-apply.sh"
# shellcheck disable=SC1090
[ -f "$_kb_apply_lib" ] && . "$_kb_apply_lib"


# THE SHARED HANDLER, NOT A PRIVATE ONE. lib/agent-ladder.sh steps one rung per RECORDED failure
# along the chain this seam's ARCHETYPE declares, so the tier in invocation-profiles.json is what
# selects the model — here and in every other consumer, by the same code.
#
# The escalation this replaces stepped from _base_model on every attempt, so attempt 3 re-derived
# the same hop attempt 2 had already taken: both logged an identical escalation and the rung never
# advanced. Live 2026-08-14 the test-writer burned all three attempts without ever climbing.
_model="$_base_model"
for _attempt in $(seq 1 "$_max_attempts"); do
    _provider="$_base_provider"
    if [ "$_attempt" -gt 1 ]; then
        _prev_model="$_model"
        agent_ladder_record_failure "$_LADDER_AGENT" "$STORY_ID"
        _next="$(agent_ladder_model "$_LADDER_AGENT" "$STORY_ID" "$_model")"
        if [ -n "$_next" ] && [ "$_next" != "$_model" ]; then
            _model="$_next"; _provider="$(_provider_for_model "$_model")"; [ -z "$_provider" ] && _provider="$_base_provider"
            log "ladder escalation (attempt ${_attempt}/${_max_attempts}) — ${_prev_model} → ${_model}"
        elif agent_ladder_exhausted "$_LADDER_AGENT" "$STORY_ID" "$_model"; then
            warning "NO ladder escalation on attempt ${_attempt}/${_max_attempts} — at the top of the declared chain (${_model})"
        else
            warning "NO ladder escalation on attempt ${_attempt}/${_max_attempts} — no chain declared for this seam's tier"
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
    { printf '%s' "$_prompt"; [ -n "$_typecheck_feedback" ] && printf '%s' "$_typecheck_feedback"; [ -n "$_assertion_feedback" ] && printf '%s' "$_assertion_feedback"; } | \
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
        # Ticket-ID-first message (found live 2026-08-02, AMSD-2041 Writer
        # Retest: gotransit AND upexpress both permanently HALTed at the
        # repro-gate — the test file this writer produced was validated and
        # staged correctly, but this commit silently failed every time
        # because both codelines' commitlint (commitlint-plugin-jira-rules)
        # requires the ticket ID as the FIRST token, and "test: ..." isn't
        # one. Same root cause, same fix shape as commit_completed_story()'s
        # 2026-08-02 fix (lib/git-ops.sh) — ticket-ID-first is the standard
        # shape most commit-message linters expect, not Jira-specific
        # knowledge baked in here. This call site was missed when that fix
        # was applied because it's a separate, independent `git commit`, not
        # a shared helper.
        # Capture real stderr instead of discarding it (found live 2026-08-02,
        # same investigation as the message-format fix above): a swallowed
        # "(non-fatal)" log line gave zero signal about WHY a commit failed —
        # a client repo's commit-msg hook can reject for ANY reason (a
        # different commitlint rule, a totally unrelated lint-staged/husky
        # check, etc.), and guessing at every possible hook's exact rule set
        # in advance is not something this pipeline can or should hardcode
        # per project. Surfacing the hook's own output is the generic fix:
        # whatever the real reason is, it's now visible in the log instead of
        # requiring live-run archaeology to rediscover. Same pattern as
        # commit_completed_story()'s 2026-08-01 fix (lib/git-ops.sh).
        _commit_output=$(git -C "$PROJECT_ROOT" commit -m "${STORY_ID}: add ${_commit_noun}" --quiet 2>&1)
        _commit_rc=$?
        if [ "$_commit_rc" -eq 0 ]; then
            log "committed reproducing test: $_target_rel"
            # Reindex CodeGraph so this commit's writes are visible to the
            # reviewer's codegraph_query tool (see codegraph-reindex.sh).
            [ -f "$SCRIPT_DIR/codegraph-reindex.sh" ] && bash "$SCRIPT_DIR/codegraph-reindex.sh" "$PROJECT_ROOT" "post-commit repro-test ${STORY_ID}" || true
        else
            warning "commit failed — repro-gate will report. Output:"
            warning "$_commit_output"
        fi
    fi
    _emit_tw "spec_update" "repro-test-writer committed reproducing test: ${_target_rel}"

    # Record this test as writer output. The manifest is what the phase gates
    # judge, and this producer finishes AFTER the story loop has already written
    # its entry — so without this the test is invisible to them. Live metrolinx
    # 2026-07-26: mutant-hunter reads its tests from the manifest, found none,
    # every mutant survived, it scored 0 and failed the gate on a run whose test
    # the repro gate had just proven fails-on-baseline/passes-with-fix.
    _so_lib="${SCRIPT_DIR}/lib/story-outputs.sh"
    if [ -f "$_so_lib" ]; then
        # shellcheck disable=SC1090
        . "$_so_lib"
        story_outputs_record "$PROJECT_ROOT" "${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}" || true
    fi
    _tw_exit=0
else
    log "no test file produced at $_target_rel — the repro-gate will BLOCK (as designed)"
    _emit_tw "error" "repro-test-writer produced NO test for ${STORY_ID} — repro-gate will BLOCK"
    _tw_exit=1
fi

# EXIT STATUS IS THE CONTRACT. This was an unconditional `exit 0`, so producing no test at all
# reported success — and the caller piped into `tee`, which discards the status anyway. The
# failure was invisible twice over, and Step 3.55 then blocked the story for shipping no
# reproducing test, sending the investigation at the story instead of at the writer that never
# produced one.
exit "$_tw_exit"
