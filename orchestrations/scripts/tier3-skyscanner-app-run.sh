#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 3: Travel App (Skyscanner) — MiniMax + GLM + Kimi multi-model pipeline.
#
# Runs two implementation phases in sequence:
#   scaffold → core
#
# Model assignment:
#   Story agents : MiniMax-M3 (direct) and moonshotai/kimi-k2 (OpenRouter)
#   Gates/analyst: MiniMax-M3
#   Retry ladder : MiniMax-M3 → z-ai/glm-5.2 (Rungs 2/3, reasoning, 1M ctx)
#   Reasoning    : low (attempt 1) → medium (R1) → medium+model↑ (R2) → high (R3)
#
# Prerequisites:
#   - MINIMAX_API_KEY set (MiniMax-M3 story agents + gate model)
#   - OPENROUTER_API_KEY set (Kimi K2, GLM-4-plus, GLM-Z1 via OpenRouter)
#   - RAPIDAPI_KEY set (Skyscanner API key for runtime verification)
#
# Estimated cost: $0.05–0.20 (MiniMax + OpenRouter pricing)
#
# Usage:
#   MINIMAX_API_KEY=<key> OPENROUTER_API_KEY=<key> bash orchestrations/scripts/tier3-travel-app-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Run this whole script — and everything it forks (run-agent-orchestration.sh,
# ai-run.sh, the `bash foo | tee` pipelines inside the run_phase function, phase-retry
# re-invocations) — as the leader of its own process group, so a single
# command can reliably kill the ENTIRE tree. Root cause of a live incident
# (2026-07-07): killing only the top-level launched PID left several
# orchestration-loop and ai-run.sh processes running (and billing the gate
# model) independently, because pipeline components and re-invoked children
# are not necessarily direct children of the PID that was signaled. `setsid`
# makes the re-exec'd process the leader of a new session/process group; that
# group's ID equals its own PID, and `kill -- -<pid>` (negative = process
# group) reaches every member regardless of how deep descendants nest.
# Idempotent: TIER3_SETSID_DONE guards against re-triggering on the re-exec.
if [ -z "${TIER3_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export TIER3_SETSID_DONE=1
  exec setsid bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
LOG_FILE="/tmp/tier3-skyscanner-app-run-$(date +%Y%m%dT%H%M%S).log"

# Record our own PID (== the process-group ID after the setsid re-exec above)
# so orchestrations/scripts/kill-tier3-run.sh can reliably find and kill the
# whole tree in one command, without having to hunt down orphaned children by
# hand the way the 2026-07-07 incident required.
# Named after THIS runner. It said tier3-travel-app-run.pid (copy-paste), so a
# skyscanner launch overwrote the travel-app pid and the kill hit the wrong group.
TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-skyscanner-app-run.pid}"
echo "$$" > "$TIER3_PID_FILE"
trap 'rm -f "$TIER3_PID_FILE"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-travel]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-travel] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3-travel] ✗${NC} $*"; exit 1; }

# Load .env if any required key is missing
if [ -z "${MINIMAX_API_KEY:-}" ] || [ -z "${OPENROUTER_API_KEY:-}" ]; then
  load_env_file_safe "$REPO_ROOT/.env"
fi

[ -z "${MINIMAX_API_KEY:-}" ]    && fail "MINIMAX_API_KEY is not set. Export it or add it to .env"
[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"

# Auto-confirm when: --yes/-y flag, CI env var set, or no TTY (non-interactive shell)
AUTO_YES=false
for arg in "$@"; do [[ "$arg" == "--yes" || "$arg" == "-y" ]] && AUTO_YES=true; done
[[ "${CI:-}" == "true" || "${AUTO_YES_TIER3:-}" == "1" ]] && AUTO_YES=true
[[ ! -t 0 ]] && AUTO_YES=true

# PER-PROJECT — see the note in tier3-metrolinx-run.sh; these three runners used
# to share one PRD path and silently overwrite each other.
PRD_FILE="${EPAM_PROJECT_CONFIG_DIR:-$REPO_ROOT/orchestrations/projects/skyscanner}/prd.json"
OUTPUT_DIR="${OUTPUT_DIR:-/home/bradleyjerome/projects/skyscanner-app}"

info "Tier 3 travel app run — MiniMax + GLM + Kimi multi-model pipeline (USES CREDITS)"
info "  PRD: $PRD_FILE"
info "  Output: $OUTPUT_DIR"
info "  Estimated cost: \$0.05–0.15"
info "  Log: $LOG_FILE"
echo ""

if [ "$AUTO_YES" = true ]; then
  info "Auto-confirmed (--yes flag)"
else
  read -rp "$(echo -e "${YELLOW}Confirm: spend MiniMax + OpenRouter credits? [yes/N]${NC} ")" confirm
  [ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }
fi

cd "$REPO_ROOT"

# Capture spend baseline
_usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
info "OpenRouter usage before: \$$_usage_before"
# Also into $LOG_FILE: the line above goes to stdout, which is the launch log
# that pre-run-reset deletes. The run report is generated from $LOG_FILE, so a
# balance recorded only on stdout leaves every report saying "Billed by
# provider $?" — the one number that is ground truth rather than our own tally.
printf 'OpenRouter usage before: $%s\n' "$_usage_before" >> "$LOG_FILE" 2>/dev/null || true
echo ""

# Tear down the entire output directory before every run.
# DELETE EVERYTHING — not a git clean, not a status reset, full rm -rf.
# Stale package.json, tsconfig, test files, and accumulated artifacts from
# prior runs all poison the next run. The only safe state is no state.
#
# chmod before rm -rf (found live, 2026-07-11/12, tier3-travel-app relaunches):
# some node_modules subdirectories/files end up non-writable (0444/0555) after
# npm install — deletion requires WRITE permission on each containing
# directory, not just file ownership, so a prior run's node_modules can make
# `rm -rf` fail outright (silently leaving the teardown incomplete, since the
# script has no `set -e` gate on this specific line) instead of tearing down
# cleanly. Force full ownership/write access first so teardown can never be
# blocked by leftover restrictive permissions from an earlier install.
[ -d "$OUTPUT_DIR" ] && chmod -R u+w "$OUTPUT_DIR" 2>/dev/null || true
info "Tearing down output directory: $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
# Also remove sibling worktree dirs left by previous parallel-phase runs
for _wt_dir in "${OUTPUT_DIR}-wt-"*; do
  [ -e "$_wt_dir" ] || continue
  chmod -R u+w "$_wt_dir" 2>/dev/null || true
  rm -rf "$_wt_dir" && info "Removed leftover worktree: $_wt_dir"
done
mkdir -p "$OUTPUT_DIR"
git -C "$OUTPUT_DIR" init --quiet
git -C "$OUTPUT_DIR" commit --allow-empty -m "init: skyscanner-app" --quiet
info "Output directory clean (deleted and reinitialised)"

# Dependency-check manifest — this project's stack is npm/TypeScript, so this
# tier script (not the generic run-agent-orchestration.sh / claude.sh) is the
# right place to declare it. claude.sh's run_dependency_check() itself knows
# nothing about npm — it just reads whatever manifest is here. A Python or
# Rust orchestration would supply its own manifest with the same shape.
mkdir -p "$OUTPUT_DIR/.epam"
cat > "$OUTPUT_DIR/.epam/dependency-check.json" << 'DEPCHECK_EOF'
{
  "manifestFile": "package.json",
  "manifestKeys": ["dependencies", "devDependencies"],
  "scanFileExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  "importPattern": "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
  "installCommand": "npm install --save-dev {package}",
  "ignorePackages": ["assert","buffer","child_process","cluster","crypto","dgram","dns","domain","events","fs","http","http2","https","net","os","path","perf_hooks","process","punycode","querystring","readline","repl","stream","string_decoder","timers","tls","tty","url","util","v8","vm","worker_threads","zlib","node:assert","node:buffer","node:child_process","node:crypto","node:events","node:fs","node:http","node:https","node:net","node:os","node:path","node:process","node:stream","node:url","node:util","node:vm","node:zlib"],
  "requiredDevDependencies": ["typescript", "@types/node", "vitest", "tsx"],
  "vendorDirs": ["node_modules"]
}
DEPCHECK_EOF

# Contract-generation manifest — same "engine knows nothing about the stack,
# manifest supplies all the syntax/regex knowledge" pattern as dependency-check.json
# above. claude.sh's generate_story_contract() parses this project's source with
# whatever regex/templates are declared here; a Python or Go orchestration would
# supply its own manifest with the same shape (different regexes, different mock
# templates) and the engine function would not need to change at all.
cat > "$OUTPUT_DIR/.epam/contract-generation.json" << 'CONTRACTGEN_EOF'
{
  "language": "typescript",
  "sourceExtensions": [".ts"],
  "excludePattern": "\\.(test|spec)\\.ts$",
  "interfacePattern": "export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}",
  "classPattern": "export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{",
  "ctorPattern": "constructor\\s*\\(([^)]*)\\)",
  "methodPattern": "^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{",
  "interfaceRenderTemplate": "export interface {{name}} {{{body}}}",
  "classDeclarationTemplate": "export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}",
  "methodSignatureTemplate": "  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};",
  "asyncPrefixKeyword": "async ",
  "returnAnnotationPrefix": ": ",
  "mockFactoryTemplate": "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
  "mockMethodTemplateSync": "    {{methodName}}: vi.fn(),",
  "mockMethodTemplateAsync": "    {{methodName}}: vi.fn().mockResolvedValue(undefined),",
  "testFileExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  "testFilePattern": "\\.(test|spec)\\.[a-zA-Z0-9]+$",
  "mockFactoryStartPattern": "vi\\.mock\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\{",
  "mockClassPattern": "(\\w+)\\s*:\\s*vi\\.fn\\(\\)\\.mockImplementation\\(\\(\\)\\s*=>\\s*\\(\\{",
  "mockedMethodPattern": "^\\s*(\\w+)\\s*:",
  "testFileAgentRole": "test-engineer"
}
CONTRACTGEN_EOF

# Known-fixes registry — deterministic second-line safety net for self-heal
# (see apply_known_fix() in claude.sh). Each entry maps a recurring failure
# SYMPTOM (regex against the FailureAnalyst's diagnosis text) to a mechanical,
# one-line patch on an already-scaffolded file. Only engages after the same
# diagnosis has recurred 2+ times with no LLM-routed fix able to touch it.
cat > "$OUTPUT_DIR/.epam/known-fixes.json" << 'KNOWNFIXES_EOF'
[
  {
    "id": "vitest-pass-with-no-tests",
    "symptomPattern": "(?:vitest|test).*(?:no test files|zero test files).*exit|exit.*1.*(?:no|zero) test files|passWithNoTests",
    "targetFile": "vitest.config.ts",
    "checkPattern": "passWithNoTests",
    "insertAfterPattern": "test:\\s*\\{",
    "insertText": "\n    passWithNoTests: true,"
  }
]
KNOWNFIXES_EOF

# Export all required env vars directly so subprocesses inherit them without
# an `env` wrapper array (which caused silent exit due to empty-var expansion).
export OUTPUT_DIR
export PROJECT_ROOT="$OUTPUT_DIR"
# MiniMax (direct API — story agents + gate model)
export MINIMAX_API_KEY
export EPAM_API_KEY_MINIMAX="$MINIMAX_API_KEY"
# OpenRouter (Kimi K2, GLM-4-plus, GLM-Z1 via unified API)
export OPENROUTER_API_KEY
export EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY"
# Gate/coordinator model: set to glm-5.2 (2026-07-17) — glm-5.2 has 1M context
# vs glm-5.1's 202K; 4 of 7 coordinator calls in the last clean run exceeded
# glm-5.1's limit (worst: spec-validator at 503K tokens, 148% over). glm-5.2
# is also slightly cheaper ($0.91 vs $0.97/M input). ESCALATION_MODEL_HIGH stays
# as glm-5.1 — spec-mode and the HIGH ladder ceiling are unaffected.
# History: was bumped to glm-5.1 (HIGH-tier) on 2026-07-07 after finding
# failure-analyst ran on MiniMax-M3 and misdiagnosed SKY-002-test-1's casing bug.
export ORCH_GATE_PROVIDER="qwen"
export EPAM_ORCHESTRATION_PROVIDER="qwen"
export ORCH_GATE_MODEL="z-ai/glm-5.2"
# Escalation model: GLM 5.2 for Rung 2/3 (reasoning model, 1M ctx; routes via OpenRouter/qwen provider)
export ESCALATION_MODEL="${ESCALATION_MODEL:-z-ai/glm-5.2}"
# HIGH tier: stronger/pricier model than the medium-tier ESCALATION_MODEL.
# claude.sh's classify_ladder_tier() dynamically decides medium vs high per
# story from its own recorded failure history (story-failures.jsonl) — never
# hardcoded per story ID.
export ESCALATION_MODEL_HIGH="${ESCALATION_MODEL_HIGH:-z-ai/glm-5.1}"
# Temperature pin, ALL models (2026-07-10, reversing the 2026-07-07 GLM-only
# scoping per explicit user directive). Root cause this fixes: claude.sh's
# FailureDiversity mechanism (claude.sh:~5076-5085) detects a story retrying
# with a DIFFERENT diagnosis each attempt — the signature of token-selection
# variance, not a capability gap — and pins EPAM_TEMPERATURE=0 for the rest of
# that story so it stops sampling alternative wrong answers. With
# EPAM_TEMPERATURE_MODEL_PATTERN scoped to GLM models only, that self-
# correction was SILENTLY DISCARDED by resolveTemperature() for every other
# model in the ladder (MiniMax-M3, kimi-k2, gpt-5-codex, etc.) — exactly the
# models actually doing implementation work — confirmed live 2026-07-09/10:
# SKY-002-impl (model=MiniMax-M3) cycled through 6 different tsc/module-
# resolution diagnoses across its retries and never converged, because its
# temperature pin never took effect. No pattern var is set below —
# resolveTemperature()'s own documented default ("unset = applies to all
# models") now covers every model with zero glob-matching risk of missing one.
export EPAM_TEMPERATURE="0"
# Spec-mode models: openspec/speckit make MANDATORY, non-negotiable decisions
# (AC elaboration, story splitting) with NO escalation ladder of their own —
# unlike implementation stories, a bad spec-pass decision can't be retried at
# a stronger model automatically. Root cause of a live defect (2026-07-06):
# openspec on the base model (moonshotai/kimi-k2) repeatedly ignored its own
# "MANDATORY split required" prompt instruction for stories exceeding the
# split thresholds (see checkSplitMandateViolation() in spec-mode-runner.js),
# burning the ENTIRE downstream implementation retry/escalation ladder on an
# overloaded, un-split story instead. Fix: always use the strongest configured
# model (the HIGH ladder tier) for spec-mode's own decisions, since there's no
# later opportunity to escalate a bad split/elaboration call the way there is
# for implementation.
export SPEC_MODE_PROVIDER="qwen"
export SPEC_MODE_OPENSPEC_MODEL="${SPEC_MODE_OPENSPEC_MODEL:-${ESCALATION_MODEL_HIGH}}"
export SPEC_MODE_OPENSPEC_MODEL_HIGH="${SPEC_MODE_OPENSPEC_MODEL_HIGH:-${ESCALATION_MODEL_HIGH}}"
export SPEC_MODE_SPECKIT_MODEL="${SPEC_MODE_SPECKIT_MODEL:-${ESCALATION_MODEL_HIGH}}"
export SPEC_MODE_SPECKIT_MODEL_HIGH="${SPEC_MODE_SPECKIT_MODEL_HIGH:-${ESCALATION_MODEL_HIGH}}"
export SPEC_MODE_MODEL="${SPEC_MODE_MODEL:-${ESCALATION_MODEL_HIGH}}"
# Block execution if openspec fails for a story that mandates a split — splitting
# is critical for correctness (oversized stories hit token limits and produce
# partial implementations). The HIGH ladder retries (SPEC_AGENT_MAX_RETRIES=3)
# already give openspec 4 attempts; a hard block here prevents running a known-bad
# PRD through expensive implementation passes.
export SPEC_PASS_BLOCK_ON_TIMEOUT="${SPEC_PASS_BLOCK_ON_TIMEOUT:-true}"
export RUNCLAUDE_TIMEOUT_MS="${RUNCLAUDE_TIMEOUT_MS:-360000}"
export SPEC_MODE_MAX_OUTPUT_TOKENS="${SPEC_MODE_MAX_OUTPUT_TOKENS:-16384}"
# Model escalation ladder: pipe-separated "from=to" pairs consumed by get_model_ladder_step().
# R2: MiniMax-M3 → deepseek-r1 (reasoning escalation). Legacy GLM entries kept for story-level retryModel compat.
# Override individual entries by re-exporting EPAM_MODEL_LADDER before invoking this script.
#
# BUG (found live via SKY-003 sandbox test, 2026-07-05): SKY-002/003/004 are all
# assigned moonshotai/kimi-k2 as their base model (per prd.json aiProvider/model),
# but neither tier had an entry keyed on it — get_model_ladder_step() returned
# empty ("no ladder step — keeping model"), so a story on kimi-k2 could reach
# Rung 3 (max rung, "effort → high (maximum)") without the model EVER actually
# changing. Confirmed: SKY-003 repeated the identical trivial mistake (added a
# .js extension to a relative import) across every rung and exhausted all 8
# attempts still on kimi-k2, then aborted — a mechanical, easily-fixed mistake
# that likely would have resolved in 1-2 attempts on a stronger model.
export EPAM_MODEL_LADDER_MEDIUM="${EPAM_MODEL_LADDER_MEDIUM:-MiniMax-M2.5=MiniMax-M3|MiniMax-M3=${ESCALATION_MODEL}|zhipuai/glm-z1-32b=${ESCALATION_MODEL}|zhipuai/glm-z1-9b=${ESCALATION_MODEL}|${ESCALATION_MODEL}=${ESCALATION_MODEL_HIGH}}"
export EPAM_MODEL_LADDER_HIGH="${EPAM_MODEL_LADDER_HIGH:-MiniMax-M2.5=MiniMax-M3|MiniMax-M3=${ESCALATION_MODEL_HIGH}|zhipuai/glm-z1-32b=${ESCALATION_MODEL_HIGH}|zhipuai/glm-z1-9b=${ESCALATION_MODEL_HIGH}|${ESCALATION_MODEL}=${ESCALATION_MODEL_HIGH}|${ESCALATION_MODEL_HIGH}=moonshotai/kimi-k3}"
# kimi-k3 rung (2026-07-17): new HIGH-tier ceiling above glm-5.1. Only reached
# when a story exhausts all glm-5.1 retries (Rung3 max-effort). 1M ctx, highest
# reasoning — $3/M input / $15/M output, so 2 retries max before HEALING_BROKEN.
# Back-compat: EPAM_MODEL_LADDER (no suffix) still works as an override that
# forces BOTH tiers to the same ladder — set it explicitly to opt out of the
# medium/high split.
export EPAM_MODEL_LADDER="${EPAM_MODEL_LADDER:-}"
# Final fallback: used at R3 when the story model was never escalated at R2
export EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-moonshotai/kimi-k3}"
export EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-qwen}"
# Dynamic retry-extension coordinator (2026-07-12): ships DISABLED by
# default, same rollout discipline as the DeepEval groundedness check --
# prove it via fixture tests and observe it advisory-only before letting it
# affect real run behavior. EPAM_RETRY_EXTENSION_MAX bounds how many extra
# retries a single extension can ever grant, regardless of what the
# coordinator agent requests.
export EPAM_RETRY_EXTENSION_ENABLED="${EPAM_RETRY_EXTENSION_ENABLED:-0}"
export EPAM_RETRY_EXTENSION_MAX="${EPAM_RETRY_EXTENSION_MAX:-2}"
# Model-to-provider routing for post-escalation model steps (consumed by
# claude.sh's resolve_model_provider() — zero vendor names hardcoded in the
# engine itself, see that function's comment). This project routes every
# OpenRouter-hosted vendor through the "qwen" provider umbrella; MiniMax
# direct-API models route through "minimax". A project using different model
# vendors/providers would supply a different map here.
export EPAM_MODEL_PROVIDER_MAP="${EPAM_MODEL_PROVIDER_MAP:-zhipuai/*=qwen|moonshotai/*=qwen|z-ai/*=qwen|glm-*=qwen|kimi-*=qwen|deepseek/*=qwen|MiniMax-*=minimax}"
# MiniMax runtime settings
export MINIMAX_TOOL_TIMEOUT_MS="${MINIMAX_TOOL_TIMEOUT_MS:-15000}"
export ORCH_MINI_MODEL="${ORCH_MINI_MODEL:-MiniMax-M2.5}"
export ORCH_UPGRADE_MODEL="${ORCH_UPGRADE_MODEL:-MiniMax-M3}"
export PRD_FILE
export SKIP_REGRESSION_GUARD=true
export EPAM_RALPH_WIGGUM_ENABLED=0
export EPAM_STORY_TIMEOUT_SECS=600
export EPAM_MAX_RETRIES=7
export SKIP_BROWSER_E2E_ROUTING=true
[ -n "${RAPIDAPI_KEY:-}" ] && export RAPIDAPI_KEY

PIPELINE_EXIT=0

# ── Canonical restore: prd.json + profiles.json ──────────────────────────────
# Every run starts from the canonical originals so accumulated agent mutations
# (split stories, extra profiles, stale statuses) never carry forward.
# profiles.json.original is the authoritative set of agent profiles.
# prd.json canonical is kept in git — restore it and strip orphan stories
# (stories not in implementationOrder) so the file stays tight.
# profiles.json.original is the canonical floor: all core agents + any non-core
# agents added for this project's scaffolding. Update it whenever a new permanent
# agent is introduced. The test in profiles-canonical.test.ts asserts that all
# core pipeline agents are present. Restore from it before each run so
# agent-accumulated mutations (extra profiles written by profile-augmentor) never
# carry forward across runs.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$REPO_ROOT/orchestrations/agents/profiles.json"
  info "profiles.json restored from canonical original ($(python3 -c "import json; print(len(json.load(open('$PROFILES_ORIG'))))" 2>/dev/null || echo '?') profiles)"
else
  info "profiles.json.original not found — skipping profiles restore"
fi

# Restore prd.json from the CANONICAL file — never from git HEAD.
# git HEAD accumulates runtime split children across runs; the canonical file
# contains only the 12 curated base stories and is never mutated at runtime.
PRD_CANONICAL="$REPO_ROOT/orchestrations/travel-app-prd.canonical.json"
if [ ! -f "$PRD_CANONICAL" ]; then
  fail "travel-app-prd.canonical.json not found — cannot restore clean PRD. Aborting."
fi
# Restore from canonical (4 base user stories). The spec pass (Step 0) elaborates these
# into implementation stories each run. SKY-005 and SKY-006 are generated dynamically.
cp "$PRD_CANONICAL" "$PRD_FILE"
_canonical_count=$(jq '.stories | length' "$PRD_FILE" 2>/dev/null || echo '?')
info "prd.json restored from canonical file ($_canonical_count base user stories)"
echo ""

# ── Pre-run PRD remediation (before preflight, so stale artifacts don't block) ─
# Removes BUG-* stories, stale splits, extra phases, completed-state flags, and
# oversized ACs left by any previous failed run. The preflight then sees a clean PRD.
info "Pre-run PRD remediation..."
if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE"; then
  fail "Pre-run PRD remediation failed — aborting. Fix prd.json manually."
fi
echo ""

# ── PRD integrity guard — abort if canonical restore produced a corrupt PRD ──
# Checks: no accumulated split children (stories whose parent is also in the PRD),
# all stories pending. If either fails, the canonical file itself is corrupt and
# must be manually repaired before running.
python3 - "$PRD_FILE" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
# After restoring from canonical, the PRD has only the 4 base user stories.
# Any mid-execution splits from a prior run must not be present.
mid_exec = [s['id'] for s in d['stories']
            if s.get('specification', {}).get('splitOrigin') == 'mid-execution']
dirty = [s['id'] for s in d['stories']
         if s.get('status') not in ('pending', 'deprecated') and s.get('deprecated') is not True]
errors = []
if mid_exec:
    errors.append(f"ABORT: PRD has {len(mid_exec)} mid-execution splits from a prior run — canonical restore failed: {mid_exec}")
if dirty:
    errors.append(f"ABORT: PRD has {len(dirty)} stories with non-pending status: {dirty}")
if errors:
    for e in errors: print(e, file=sys.stderr)
    sys.exit(1)
print(f"  PRD integrity OK: {len(d['stories'])} stories, all pending, zero mid-execution splits")
PYEOF
if [ $? -ne 0 ]; then
  fail "PRD integrity check failed — canonical file is corrupt. Repair travel-app-prd.canonical.json before running."
  exit 1
fi
echo ""

# ── Secondary codeline worktree teardown (multi-codeline canonical PRDs) ───────
# When project.outputDirs declares more than one codeline, the tier3 launcher must
# also tear down and re-initialise every secondary worktree so each run starts
# from a clean state — not just the primary OUTPUT_DIR (already done above).
# For single-codeline PRDs this section is a no-op.
_sec_wts=$("${NODE_BIN:-node}" -e "
  const p = JSON.parse(require('fs').readFileSync('$PRD_FILE','utf8'));
  const dirs = p.project && p.project.outputDirs ? p.project.outputDirs : [];
  dirs.filter(d => d.path !== '$OUTPUT_DIR').forEach(d => process.stdout.write(d.path+'\n'));
" 2>/dev/null || true)

if [ -n "$_sec_wts" ]; then
  info "Multi-codeline canonical PRD — tearing down secondary worktrees..."
  while IFS= read -r _sec_wt; do
    [ -z "$_sec_wt" ] && continue
    [ -d "$_sec_wt" ] && chmod -R u+w "$_sec_wt" 2>/dev/null || true
    rm -rf "$_sec_wt"
    mkdir -p "$_sec_wt"
    git -C "$_sec_wt" init --quiet
    git -C "$_sec_wt" commit --allow-empty -m "init: secondary-codeline-worktree" --quiet
    info "  Secondary worktree torn down and re-initialised: $_sec_wt"
  done <<< "$_sec_wts"
fi
unset _sec_wts _sec_wt
echo ""

# ── Pre-flight validation ─────────────────────────────────────────────────────
# shellcheck source=lib/preflight.sh
. "$SCRIPT_DIR/lib/preflight.sh"
# HARD-FAIL IF THIS DOES NOT LOAD. Sourcing a missing file is non-fatal without
# set -e, and phase_exit_is_retryable would then be "command not found" -> exit 127
# -> falsy -> the legitimate gate-remediation retry silently never happens. A
# capability that disappears without a word is the failure mode this whole change
# exists to remove.
. "$SCRIPT_DIR/lib/phase-exit.sh" || { echo "[preflight] lib/phase-exit.sh failed to load — refusing to run" >&2; exit 1; }
# Route through fail(), never a bare exit: fail() archives the run artefacts first.
# A bare `exit 1` here made a pre-flight abort the ONE outcome that recorded nothing —
# no run folder, no outcome.txt, no log — which is the outcome most worth keeping.
require_preflight || fail "Pre-flight assessment failed"
echo ""

# ── Wire the dashboard to this run's live PRD + logs ─────────────────────────
# pre-run-reset.sh is called WITHOUT --log-dir so docker mounts orchestrations/logs
# at /logs-dir. That is where run-agent-orchestration.sh writes ALL orchestration
# logs (agent-activity.jsonl, agent-status.json, phase-cost.jsonl, etc.) — nginx
# can then serve them. OUTPUT_DIR is the project code directory; writing logs there
# would misdirect the dashboard since nginx only knows about /logs-dir.
#
# .active-output-dir is written separately (below) so snapshot.js's
# resolveProjectOutputDir() can find OUTPUT_DIR for healing-events.jsonl,
# storyFailures, and guardedStepRetries — which claude.sh DOES write to OUTPUT_DIR.
# These are read by Eleventy (server-side), not nginx, so they don't need /logs-dir.
info "Wiring dashboard to serve this run's live PRD + logs..."
# Contamination ABORTS the launch; everything else stays non-fatal. One gate,
# lib/pre-run-reset-gate.sh, for all launchers — this used to be five copies of
# "|| info", all of which swallowed a contaminated-state exit as a Docker problem.
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"
# Point snapshot.js at OUTPUT_DIR so it finds healing-events and story artefacts.
# pre-run-reset.sh writes .active-output-dir = its LOG_DIR (orchestrations/logs),
# which is wrong for these OUTPUT_DIR-written files — overwrite it here.
echo -n "$OUTPUT_DIR" > "orchestrations/dashboards/.active-output-dir"
echo ""

run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  # Auto-remediate PRD before every phase: removes stale splits, trims ACs,
  # resets story state, and verifies integrity. Prevents run failures from
  # prior-run mutations without requiring manual intervention.
  info "  Pre-phase PRD remediation..."
  if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" --phase "$phase" 2>&1 | tee -a "$LOG_FILE"; then
    fail "PRD remediation failed for phase '$phase' — aborting. Fix prd.json manually."
  fi
  echo ""

  local phase_exit=0
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  # exit 2 = gate remediation was applied — reset stories and retry once
  if phase_exit_is_retryable "$phase_exit"; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" --phase "$phase" --mid-phase-retry 2>&1 | tee -a "$LOG_FILE"; then
      fail "PRD remediation failed during self-healing retry for phase '$phase'"
    fi
    echo ""
    phase_exit=0
    SKIP_GATE_REMEDIATION=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
      --phase "$phase" \
      --reset \
      2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
    echo ""
    if [ "$phase_exit" -ne 0 ]; then
      fail "Phase '$phase' failed after self-healing retry (exit $phase_exit) — aborting pipeline"
    fi
    success "Self-healing retry succeeded for phase '$phase'"
    return 0
  fi

  if [ "$phase_exit" -ne 0 ]; then
    fail "Phase '$phase' failed (exit $phase_exit) — aborting pipeline"
  fi
}

# ── Scope-guard snapshot ─────────────────────────────────────────────────────
# Take a snapshot of all .ts source files before any agent runs. This baseline
# is used by run_external_verification() in claude.sh to restore files outside
# a story's declared scope before running npm test — so Bash-based file writes
# cannot contaminate test results for stories that don't own those files.
SCOPE_GUARD_BACKUP_DIR="/tmp/sg-backup-$$"
export SCOPE_GUARD_BACKUP_DIR
if [ -d "$PROJECT_ROOT/src" ]; then
  mkdir -p "$SCOPE_GUARD_BACKUP_DIR"
  (cd "$PROJECT_ROOT" && find src -name "*.ts" | while IFS= read -r f; do
    mkdir -p "$SCOPE_GUARD_BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$SCOPE_GUARD_BACKUP_DIR/$f"
  done)
  info "[scope-guard] Source snapshot created at $SCOPE_GUARD_BACKUP_DIR ($(find "$SCOPE_GUARD_BACKUP_DIR" -name '*.ts' | wc -l) files)"
fi

run_phase "scaffold"
run_phase "core"

# Report spend
_usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "OpenRouter usage after: \$$_usage_after"
# Also into $LOG_FILE: the line above goes to stdout, which is the launch log
# that pre-run-reset deletes. The run report is generated from $LOG_FILE, so a
# balance recorded only on stdout leaves every report saying "Billed by
# provider $?" — the one number that is ground truth rather than our own tally.
printf 'OpenRouter usage after: $%s\n' "$_usage_after" >> "$LOG_FILE" 2>/dev/null || true
info "Total spent this run: \$$_spent"
echo ""

# Validate all stories from implementationOrder — read dynamically, never hardcoded
info "Validating story completion..."
PASS=0; FAIL_LIST=""
while IFS= read -r story; do
  [ -z "$story" ] && continue
  status=$(python3 -c "
import json
with open('$PRD_FILE') as f:
  d = json.load(f)
for s in d['stories']:
  if s['id'] == '$story':
    print(s.get('status','unknown'))
    break
else:
  print('not_found')
" 2>/dev/null)
  if [ "$status" = "completed" ]; then
    success "$story: completed"
    PASS=$((PASS+1))
  else
    echo -e "${RED}[tier3-travel] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done < <(python3 -c "
import json
with open('$PRD_FILE') as f:
  d = json.load(f)
seen = set()
for ids in d.get('implementationOrder', {}).values():
  for i in ids:
    if i not in seen:
      print(i)
      seen.add(i)
" 2>/dev/null)

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 travel app FAILED — stories not completed:$FAIL_LIST"
fi

success "Tier 3 travel app PASSED — all $PASS stories complete"
echo ""
echo "  App built at: $OUTPUT_DIR"
echo "  Log: $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
