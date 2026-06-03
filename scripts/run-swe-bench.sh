#!/usr/bin/env bash
# run-swe-bench.sh — EPAM CLI SWE-bench-style evaluation harness
#
# Runs bundled TypeScript benchmark tasks through EPAM CLI and produces
# a scored results file compatible with the swe-bench.html dashboard.
#
# Usage:
#   bash scripts/run-swe-bench.sh                        # Run all tasks
#   bash scripts/run-swe-bench.sh --task epam-ts-001     # Single task
#   bash scripts/run-swe-bench.sh --sandbox              # Use container isolation
#   bash scripts/run-swe-bench.sh --dry-run              # Preview tasks, no execution
#
# Output:
#   benchmarks/results/YYYY-MM-DD-HHMMSS.json           # Scored run results
#
# Scoring:
#   resolved  = all fail_to_pass tests now pass
#   partial   = some fail_to_pass tests pass
#   failed    = no fail_to_pass tests pass (or agent error)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TASKS_DIR="$REPO_ROOT/benchmarks/tasks"
RESULTS_DIR="$REPO_ROOT/benchmarks/results"
CLAUDE_SH="$REPO_ROOT/orchestrations/scripts/claude.sh"
NODE20="/home/bradleyjerome/.local/share/fnm/node-versions/v20.20.2/installation/bin/node"

# Fallback to system node if v20 not found
if [ ! -f "$NODE20" ]; then
    NODE20="$(which node)"
fi

VITEST_FLAGS="--reporter=json --outputFile"
SANDBOX=false
DRY_RUN=false
FILTER_TASK=""
RUN_ID="$(date +%Y-%m-%d-%H%M%S)"
RESULTS_FILE="$RESULTS_DIR/${RUN_ID}.json"

# ── Colour helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'; AMBER='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()     { echo -e "${CYAN}[bench]${NC} $*"; }
success() { echo -e "${GREEN}[PASS]${NC}  $*"; }
warn()    { echo -e "${AMBER}[PARTIAL]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC}  $*"; }

# ── Arg parsing ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --task)    FILTER_TASK="$2"; shift 2 ;;
        --sandbox) SANDBOX=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --help|-h)
            echo "Usage: $0 [--task ID] [--sandbox] [--dry-run]"
            echo "  --task ID    Run only this task (e.g. epam-ts-001)"
            echo "  --sandbox    Wrap agent invocations in Docker container"
            echo "  --dry-run    List tasks without running them"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "$RESULTS_DIR"

# ── Shared project template ────────────────────────────────────────────────
write_project_template() {
    local dir="$1"
    cat > "$dir/package.json" <<'EOF'
{
  "name": "epam-bench-task",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0"
  }
}
EOF
    cat > "$dir/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "outDir": "dist",
    "esModuleInterop": true
  },
  "include": ["src"]
}
EOF
    cat > "$dir/vitest.config.ts" <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
EOF
}

# ── Run vitest and return path to JSON output ─────────────────────────────
run_tests() {
    local workspace="$1"
    local json_out="$workspace/test-results.json"
    rm -f "$json_out"
    set +e
    (cd "$workspace" && "$NODE20" ./node_modules/.bin/vitest run \
        --reporter=json --outputFile="$json_out" >/dev/null 2>/dev/null)
    set -e
    echo "$json_out"
}

# ── Check which test names pass from a results JSON ───────────────────────
tests_passing() {
    local results_json="$1"
    if [ ! -f "$results_json" ]; then echo ""; return; fi
    "$NODE20" -e "
const r = JSON.parse(require('fs').readFileSync('$results_json','utf8'));
const passing = [];
for (const suite of (r.testResults || [])) {
  for (const t of (suite.assertionResults || [])) {
    if (t.status === 'passed') passing.push(t.title);
  }
}
console.log(passing.join('\n'));
" 2>/dev/null || echo ""
}

# ── Score a task against fail_to_pass list ─────────────────────────────────
score_task() {
    local task_id="$1"
    local results_json="$2"
    local fail_to_pass_json="$3"  # JSON array string

    local passing
    passing=$(tests_passing "$results_json")
    local total_required
    total_required=$("$NODE20" -e "console.log(JSON.parse('$fail_to_pass_json').length)")
    local passed_required=0

    while IFS= read -r test_name; do
        if echo "$passing" | grep -qF "$test_name"; then
            passed_required=$((passed_required + 1))
        fi
    done < <("$NODE20" -e "JSON.parse('$fail_to_pass_json').forEach(t => console.log(t))")

    if [ "$passed_required" -eq "$total_required" ]; then
        echo "resolved"
    elif [ "$passed_required" -gt 0 ]; then
        echo "partial"
    else
        echo "failed"
    fi
}

# ── Process one task ───────────────────────────────────────────────────────
run_task() {
    local task_dir="$1"
    local task_id
    task_id=$(basename "$task_dir")

    if [ -n "$FILTER_TASK" ] && [ "$task_id" != "$FILTER_TASK" ]; then
        return 0
    fi

    local task_json="$task_dir/task.json"
    if [ ! -f "$task_json" ]; then return 0; fi

    local title problem_statement fail_to_pass
    title=$(jq -r '.title' "$task_json")
    problem_statement=$(jq -r '.problem_statement' "$task_json")
    fail_to_pass=$(jq -c '.fail_to_pass' "$task_json")

    log "Task: $task_id — $title"

    if [ "$DRY_RUN" = "true" ]; then
        echo "  problem: $problem_statement"
        echo "  fail_to_pass: $fail_to_pass"
        return 0
    fi

    # Setup isolated workspace
    local workspace
    workspace=$(mktemp -d "/tmp/epam-bench-${task_id}-XXXXXX")
    mkdir -p "$workspace/src"
    write_project_template "$workspace"
    cp "$task_dir/src/"* "$workspace/src/"

    # Install deps — run npm from the workspace directory
    log "  Installing dependencies..."
    (cd "$workspace" && npm install --silent 2>/dev/null) || \
    (cd "$workspace" && /home/bradleyjerome/.local/share/fnm/node-versions/v20.20.2/installation/bin/npm install --silent 2>/dev/null) || true

    # Baseline: verify failing tests actually fail
    log "  Verifying baseline (failing tests should fail)..."
    local baseline_json
    baseline_json=$(run_tests "$workspace")
    local baseline_score
    baseline_score=$(score_task "$task_id" "$baseline_json" "$fail_to_pass")

    if [ "$baseline_score" = "resolved" ]; then
        warn "$task_id: fail_to_pass tests already pass in buggy code — task may be malformed"
    fi

    # Generate a single-story PRD using jq for safe JSON escaping
    local prd_file="$workspace/bench-prd.json"
    local full_description="${problem_statement} The source file(s) are in ${workspace}/src/. Do not modify any test files (*.test.ts)."
    jq -n \
        --arg bench_id "bench-${task_id}" \
        --arg task_id  "$task_id" \
        --arg title    "$title" \
        --arg desc     "$full_description" \
        --arg workdir  "$workspace" \
        '{
            id: $bench_id,
            project: { name: $task_id, outputDir: $workdir },
            stories: [{
                id: $task_id,
                title: $title,
                agentRole: "typescript-engineer",
                agentGroup: "main",
                status: "pending",
                completed: false,
                effort: "low",
                description: $desc,
                acceptanceCriteria: [
                    ("All fail_to_pass tests now pass when vitest run executes in " + $workdir),
                    ("Test files in " + $workdir + "/src/*.test.ts must not be modified"),
                    "tsc --noEmit exits 0 with no type errors"
                ],
                technicalNotes: {
                    workingDir: $workdir,
                    files: [($workdir + "/src/")]
                }
            }]
        }' > "$prd_file"

    # Run agent
    log "  Running agent on $task_id..."
    local started_at agent_exit=0
    started_at=$(date +%s)

    local sandbox_flag=""
    [ "$SANDBOX" = "true" ] && export EPAM_SANDBOX=true

    set +e
    PRD_FILE="$prd_file" \
    PROJECT_ROOT="$workspace" \
    EPAM_DANGEROUS_SKIP_APPROVAL=1 \
    bash "$CLAUDE_SH" "$task_id" 2>/dev/null
    agent_exit=$?
    set -e

    local ended_at elapsed
    ended_at=$(date +%s)
    elapsed=$(( ended_at - started_at ))

    # Score result
    local result_json
    result_json=$(run_tests "$workspace")
    local outcome
    outcome=$(score_task "$task_id" "$result_json" "$fail_to_pass")

    # Extract cost from phase-cost.jsonl if available
    local cost=0
    local cost_file="$REPO_ROOT/orchestrations/logs/phase-cost.jsonl"
    if [ -f "$cost_file" ]; then
        cost=$(grep "\"story_id\":\"${task_id}\"" "$cost_file" 2>/dev/null | \
               tail -1 | jq -r '.task_cost_usd // 0' 2>/dev/null || echo "0")
    fi

    case "$outcome" in
        resolved) success "$task_id: RESOLVED (${elapsed}s, \$${cost})" ;;
        partial)  warn    "$task_id: PARTIAL  (${elapsed}s, \$${cost})" ;;
        failed)   fail    "$task_id: FAILED   (${elapsed}s, \$${cost})" ;;
    esac

    # Emit result record (compact — one JSON object per line for NDJSON)
    jq -cn \
        --arg id "$task_id" \
        --arg title "$title" \
        --arg outcome "$outcome" \
        --arg run_id "$RUN_ID" \
        --argjson elapsed "$elapsed" \
        --argjson cost "${cost:-0}" \
        --argjson agent_exit "$agent_exit" \
        '{
            task_id: $id,
            title: $title,
            outcome: $outcome,
            run_id: $run_id,
            elapsed_seconds: $elapsed,
            cost_usd: $cost,
            agent_exit_code: $agent_exit,
            timestamp: (now | todate)
        }' >> "$RESULTS_FILE.ndjson"

    # Cleanup workspace
    rm -rf "$workspace"
}

# ── Main ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  EPAM CLI — SWE-bench Evaluation Harness"
echo "  Run ID: $RUN_ID"
echo "  Tasks:  $TASKS_DIR"
[ "$DRY_RUN" = "true" ] && echo "  Mode:   DRY RUN"
[ "$SANDBOX" = "true" ] && echo "  Mode:   SANDBOXED"
echo "═══════════════════════════════════════════════════════"
echo ""

# Process all tasks
for task_dir in "$TASKS_DIR"/*/; do
    run_task "$task_dir"
done

if [ "$DRY_RUN" = "true" ]; then
    log "Dry run complete — no tasks executed."
    exit 0
fi

# Consolidate NDJSON → JSON results file
if [ -f "$RESULTS_FILE.ndjson" ]; then
    "$NODE20" -e "
const lines = require('fs').readFileSync('${RESULTS_FILE}.ndjson','utf8').trim().split('\n').filter(Boolean);
const records = lines.map(l => JSON.parse(l));
const resolved = records.filter(r => r.outcome === 'resolved').length;
const partial  = records.filter(r => r.outcome === 'partial').length;
const failed   = records.filter(r => r.outcome === 'failed').length;
const total    = records.length;
const resolvedPct = total > 0 ? ((resolved / total) * 100).toFixed(1) : '0.0';
const totalCost = records.reduce((s, r) => s + (r.cost_usd || 0), 0);
const avgTime   = total > 0 ? records.reduce((s,r) => s + (r.elapsed_seconds||0), 0) / total : 0;
const output = {
    run_id: '${RUN_ID}',
    timestamp: new Date().toISOString(),
    summary: { total, resolved, partial, failed, resolved_pct: parseFloat(resolvedPct), total_cost_usd: totalCost, avg_time_seconds: avgTime },
    tasks: records
};
require('fs').writeFileSync('${RESULTS_FILE}', JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.summary));
" 2>/dev/null
    rm -f "$RESULTS_FILE.ndjson"

    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  Scorecard"
    echo "═══════════════════════════════════════════════════════"
    jq -r '"  Resolved: " + (.summary.resolved|tostring) + "/" + (.summary.total|tostring) + "  (" + (.summary.resolved_pct|tostring) + "%)"' "$RESULTS_FILE" 2>/dev/null | cat
    jq -r '"  Partial:  " + (.summary.partial|tostring)' "$RESULTS_FILE" 2>/dev/null | cat
    jq -r '"  Failed:   " + (.summary.failed|tostring)' "$RESULTS_FILE" 2>/dev/null | cat
    jq -r '"  Cost:     $" + (.summary.total_cost_usd|tostring)'  "$RESULTS_FILE" 2>/dev/null | cat || true
    echo "  Results:  $RESULTS_FILE"
    echo "═══════════════════════════════════════════════════════"
else
    log "No tasks were run."
fi
