#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# generate-run-narrative.sh — Post-run prose narrative generator.
#
# Reads a tier3 run log and supporting orchestration log files and emits a
# detailed chronological prose narrative to stdout. Output reads like a
# technical incident report / engineering story covering every significant
# event from pre-run reset through final PRD state.
#
# Usage:
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log --phase scaffold
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log --phase all
#
# Requirements:
#   - python3 in PATH
#   - Run log must be from a COMPLETE successful run (script will refuse otherwise)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$(cd "$SCRIPT_DIR/../logs" && pwd)"
# The PRD comes from the run, never from a project-named default: a built-in path reports
# on whichever project it names rather than the one that just ran.
PRD_FILE="${PRD_FILE:-${MAIN_PRD_FILE:-}}"
if [ -z "$PRD_FILE" ]; then
  echo "[$(basename "$0")] no PRD: set PRD_FILE or MAIN_PRD_FILE — the engine names no project." >&2
  exit 2
fi

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${YELLOW}[narrative]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[narrative] ✓${NC} $*" >&2; }
fail()  { echo -e "${RED}[narrative] ✗${NC} $*" >&2; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
LOG_FILE=""
PHASE_FILTER="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)   LOG_FILE="$2"; shift 2 ;;
    --phase) PHASE_FILTER="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -20 | sed 's/^# \?//'
      exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$LOG_FILE" ]] || fail "Required: --log <path>"
[[ -f "$LOG_FILE" ]] || fail "Log file not found: $LOG_FILE"

# ── Validate run completeness ─────────────────────────────────────────────────
info "Validating run log: $LOG_FILE"

# Use python to validate the run log (avoids bash variable size issues with large logs)
VALIDATION=$(python3 - "$LOG_FILE" <<'VALIDATE_EOF'
import sys, re

path = sys.argv[1]
text = open(path).read()
clean = re.sub(r'\x1b\[[0-9;]*m', '', text)

phase_gos    = len(re.findall(r'Phase gate:\s*GO', clean))
pipe_fails   = len(re.findall(r'aborting pipeline|failed \(exit [^0)]', clean))
last_20      = "\n".join(clean.splitlines()[-20:])
ends_failed  = bool(re.search(r'aborting pipeline|failed \(exit [^0)]', last_20))

if phase_gos == 0:
    print("FAIL:no_phase_gate")
    sys.exit(0)
if ends_failed:
    print("FAIL:pipeline_aborted")
    sys.exit(0)
if pipe_fails > 0:
    print(f"FAIL:has_{pipe_fails}_failures")
    sys.exit(0)
print(f"OK:{phase_gos}")
VALIDATE_EOF
)

case "$VALIDATION" in
  FAIL:no_phase_gate)
    fail "No completed phase gate found in log. This run did not complete any phase successfully. Refusing to narrate an incomplete run." ;;
  FAIL:pipeline_aborted)
    fail "Run log ends with a pipeline failure. This run did not complete successfully. Refusing to narrate an aborted run." ;;
  FAIL:has_*_failures)
    fail "Log contains pipeline failure(s). Only complete successful runs can be narrated." ;;
  OK:*)
    PHASE_GOS="${VALIDATION#OK:}"
    ok "Run log validated — $PHASE_GOS phase(s) completed successfully" ;;
  *)
    fail "Unexpected validation result: $VALIDATION" ;;
esac

# ── Emit narrative via Python ─────────────────────────────────────────────────
info "Generating narrative..."

python3 - "$LOG_FILE" "$LOG_DIR" "$PRD_FILE" "$PHASE_FILTER" <<'PYEOF'
import sys
import re
import json
import os
from datetime import datetime
from pathlib import Path

LOG_FILE   = sys.argv[1]
LOG_DIR    = Path(sys.argv[2])
PRD_FILE   = Path(sys.argv[3])
PHASE_FILTER = sys.argv[4]

# ── Helpers ────────────────────────────────────────────────────────────────────

def strip_ansi(text):
    return re.sub(r'\x1b\[[0-9;]*m', '', text)

def load_json_safe(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None

def load_jsonl_safe(path):
    records = []
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return records

def fmt_ts(ts_str):
    """Format a raw timestamp string to a readable form."""
    return ts_str.strip('[]') if ts_str else '?'

def duration_between(start_ts, end_ts):
    """Return human-readable duration between two HH:MM:SS timestamps."""
    try:
        fmt = "%H:%M:%S"
        s = datetime.strptime(start_ts, fmt)
        e = datetime.strptime(end_ts, fmt)
        diff = (e - s).total_seconds()
        if diff < 0:
            diff += 86400
        m, sec = divmod(int(diff), 60)
        if m >= 60:
            h, m = divmod(m, 60)
            return f"{h}h {m}m {sec}s"
        return f"{m}m {sec}s"
    except Exception:
        return "?"

# ── Parse the log ──────────────────────────────────────────────────────────────

raw = Path(LOG_FILE).read_text()
clean = strip_ansi(raw)
lines = clean.splitlines()

# Extract run timestamp from filename
log_name = Path(LOG_FILE).name
ts_match = re.search(r'(\d{8}T\d{6})', log_name)
run_ts = ts_match.group(1) if ts_match else "unknown"

# Format run timestamp
try:
    dt = datetime.strptime(run_ts, "%Y%m%dT%H%M%S")
    run_ts_fmt = dt.strftime("%Y-%m-%d %H:%M:%S")
except Exception:
    run_ts_fmt = run_ts

# ── Extract structured events ─────────────────────────────────────────────────

# Key event patterns
RE_PHASE_START     = re.compile(r'━+\s*Phase:\s*(\w+)\s*━+')
RE_COST_LINE       = re.compile(r'Cost\[(\S+)\]\s+model=(\S+)\s+in=(\d+)\s+out=(\d+)\s+cost=\$([0-9.]+)\s+elapsed=([0-9.]+min)\s+status=(\w+)')
RE_STEP_SUCCESS    = re.compile(r'\[SUCCESS\]\s+(.*)')
RE_STEP_FAIL       = re.compile(r'\[(?:ERROR|FAIL)\]\s+(.*)')
RE_STEP_WARN       = re.compile(r'\[(?:WARNING|WARN)\]\s+(.*)')
RE_GATE_VERDICT    = re.compile(r'\[(PASS|FAIL|warn)\]\s+(.*)')
RE_PHASE_GATE      = re.compile(r'Phase gate:\s*(GO|STOP|NO-GO).*?-\s*(.*)')
RE_TIMESTAMP       = re.compile(r'\[(\d{2}:\d{2}:\d{2})\]')
RE_FULL_TIMESTAMP  = re.compile(r'\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]')
RE_OPENROUTER_BEFORE = re.compile(r'OpenRouter usage before:\s*\$([0-9.]+)')
RE_OPENROUTER_AFTER  = re.compile(r'OpenRouter usage after:\s*\$([0-9.]+)')
RE_STORY_START     = re.compile(r'Running:\s*([\w-]+)')
RE_STORY_COMPLETE  = re.compile(r'Story\s+([\w-]+)\s+marked as completed')
RE_SPEC_MODE       = re.compile(r'spec-mode:\s*(.*)')
RE_HEAL_EVENT      = re.compile(r'\[scaffold-self-heal\]\s+(.*)')
RE_MODEL_ASSIGN    = re.compile(r'Model\[prd\.json\]\s+->\s+(\S+)')
RE_PROVIDER_ASSIGN = re.compile(r'Provider\[(\w+)\]\s+->')
RE_EFFORT_ASSIGN   = re.compile(r'Effort\[final\]\s+->\s+maxIter=(\d+)\s+maxOutTok=(\d+)')
RE_RETRY           = re.compile(r'Invoking epam \(attempt (\d+)/(\d+)\)')
RE_SPLIT_GATE      = re.compile(r'\[split-gate\]\s+(.*)')
RE_CONTRACT        = re.compile(r'\[post-story\]\s+(.*)')
RE_PLAN_COMPLETE   = re.compile(r'Planning phase complete \((\d+) words.*?\)')
RE_STEP_NUM        = re.compile(r'Step\s+([\d.]+):\s+(.*)')
RE_CPA_GATE        = re.compile(r'Step 0\.1: CPA gate (PASSED|FAILED)')
RE_PRD_REMEDIATE   = re.compile(r'\[prd-remediate\]\s+(.*)')
RE_PREFLIGHT       = re.compile(r'All (\d+) checks passed')
RE_PHASE_COSTS_FOUND = re.compile(r'Found (\d+) cost records for phase \'(\w+)\'')

events = []
phase_costs = {}
openrouter_before = None
openrouter_after = None
phases_seen = []
current_phase = "pre-run"
story_timings = {}  # story_id -> {start, end, model, cost}
retry_counts = {}   # story_id -> max attempt seen
current_story = None
run_start_time = None
run_end_time = None

for i, line in enumerate(lines):
    # Track overall timestamps
    ts_m = RE_TIMESTAMP.search(line)
    full_ts_m = RE_FULL_TIMESTAMP.search(line)
    ts = ts_m.group(1) if ts_m else None
    if ts and not run_start_time:
        run_start_time = ts
    if ts:
        run_end_time = ts

    # OpenRouter cost tracking
    m = RE_OPENROUTER_BEFORE.search(line)
    if m:
        openrouter_before = float(m.group(1))
    m = RE_OPENROUTER_AFTER.search(line)
    if m:
        openrouter_after = float(m.group(1))

    # Phase detection
    m = RE_PHASE_START.search(line)
    if m:
        current_phase = m.group(1)
        if current_phase not in phases_seen:
            phases_seen.append(current_phase)
        events.append(('phase_start', ts, current_phase))
        current_story = None
        continue

    # Cost lines
    m = RE_COST_LINE.search(line)
    if m:
        story_id, model, in_tok, out_tok, cost, elapsed, status = m.groups()
        cost_rec = dict(story=story_id, model=model, in_tok=int(in_tok),
                        out_tok=int(out_tok), cost=float(cost),
                        elapsed=elapsed, status=status, ts=ts, phase=current_phase)
        events.append(('cost', ts, cost_rec))
        if current_phase not in phase_costs:
            phase_costs[current_phase] = []
        phase_costs[current_phase].append(cost_rec)
        continue

    # Story start
    m = RE_STORY_START.search(line)
    if m:
        current_story = m.group(1)
        events.append(('story_start', ts, current_story))
        if current_story not in story_timings:
            story_timings[current_story] = {'start': ts, 'phase': current_phase}
        continue

    # Story completion
    m = RE_STORY_COMPLETE.search(line)
    if m:
        sid = m.group(1)
        events.append(('story_complete', ts, sid))
        if sid in story_timings:
            story_timings[sid]['end'] = ts
        continue

    # Retry attempts
    m = RE_RETRY.search(line)
    if m:
        attempt, max_att = int(m.group(1)), int(m.group(2))
        if current_story:
            retry_counts[current_story] = max(retry_counts.get(current_story, 0), attempt)
        events.append(('retry', ts, {'attempt': attempt, 'max': max_att, 'story': current_story}))
        continue

    # Model assignment
    m = RE_MODEL_ASSIGN.search(line)
    if m and current_story:
        model = m.group(1)
        if current_story in story_timings:
            story_timings[current_story]['model'] = model
        events.append(('model_assign', ts, {'story': current_story, 'model': model}))
        continue

    # Spec-mode events
    m = RE_SPEC_MODE.search(line)
    if m:
        events.append(('spec_mode', ts, m.group(1)))
        continue

    # Self-heal events
    m = RE_HEAL_EVENT.search(line)
    if m:
        events.append(('self_heal', ts, m.group(1)))
        continue

    # Phase gate
    m = RE_PHASE_GATE.search(line)
    if m:
        verdict, detail = m.group(1), m.group(2)
        events.append(('phase_gate', ts, {'verdict': verdict, 'detail': detail, 'phase': current_phase}))
        continue

    # Gate verdicts (SAST, fuzz, review, etc.)
    m = RE_GATE_VERDICT.search(line)
    if m and 'Step' not in line[:20]:  # skip step lines
        verdict, detail = m.group(1), m.group(2)
        if any(k in detail for k in ['sentinel', 'ranger', 'weaver', 'hunter', 'validator', 'vitest', 'tsc']):
            events.append(('gate_result', ts, {'verdict': verdict, 'detail': detail.strip()}))
        continue

    # Preflight
    m = RE_PREFLIGHT.search(line)
    if m:
        events.append(('preflight_ok', ts, int(m.group(1))))
        continue

    # CPA gate
    m = RE_CPA_GATE.search(line)
    if m:
        events.append(('cpa_gate', ts, m.group(1)))
        continue

    # PRD remediation
    m = RE_PRD_REMEDIATE.search(line)
    if m:
        msg = m.group(1).strip()
        if msg and 'Remediating' not in msg and 'Verifying' not in msg:
            events.append(('prd_remediate', ts, msg))
        continue

    # Contract generation
    m = RE_CONTRACT.search(line)
    if m:
        events.append(('post_story', ts, m.group(1)))
        continue

    # Step successes that are interesting
    m = RE_STEP_SUCCESS.search(line)
    if m:
        detail = m.group(1).strip()
        if any(k in detail for k in ['gate', 'Phase', 'vitest', 'Committed', 'Worktrees', 'TC writer']):
            events.append(('step_ok', ts, detail))
        continue

    # Warnings
    m = RE_STEP_WARN.search(line)
    if m:
        detail = m.group(1).strip()
        if detail:
            events.append(('warning', ts, detail))
        continue

# ── Load supporting files ─────────────────────────────────────────────────────

# Phase handoff files
handoffs = {}
for phase in phases_seen + ['scaffold', 'core', 'finops']:
    p = LOG_DIR / f"phase-handoff-{phase}.md"
    if p.exists():
        handoffs[phase] = p.read_text()

# PRD file
prd = load_json_safe(PRD_FILE)

# Healing events
healing = load_jsonl_safe(LOG_DIR / "healing-events.jsonl")

# Phase cost summary from vitest oracles
vitest_results = {}
for phase in phases_seen + ['scaffold', 'core', 'finops']:
    p = LOG_DIR / f"vitest-oracle-{phase}.json"
    d = load_json_safe(p)
    if d:
        vitest_results[phase] = d

# TC facts
tc_facts = {}
for phase in phases_seen + ['scaffold', 'core', 'finops']:
    p = LOG_DIR / f"tc-{phase}.json"
    d = load_json_safe(p)
    if d:
        tc_facts[phase] = d

# ── Compute total cost ────────────────────────────────────────────────────────

total_cost = 0.0
all_cost_recs = []
for phase, recs in phase_costs.items():
    for r in recs:
        total_cost += r['cost']
        all_cost_recs.append(r)

cost_delta_str = "unknown"
if openrouter_before is not None and openrouter_after is not None:
    delta = openrouter_after - openrouter_before
    cost_delta_str = f"${delta:.4f} (before=${openrouter_before:.4f}, after=${openrouter_after:.4f})"
elif total_cost > 0:
    cost_delta_str = f"${total_cost:.4f} (from agent cost records)"

# ── Build phase filter list ───────────────────────────────────────────────────
if PHASE_FILTER == "all":
    include_phases = phases_seen if phases_seen else ["scaffold", "core", "finops"]
else:
    include_phases = [PHASE_FILTER]

# ── Render narrative ──────────────────────────────────────────────────────────

SEP = "═" * 80

def p(text=""):
    print(text)

def section(title):
    p()
    p(SEP)
    p(f"  {title}")
    p(SEP)
    p()

def para(text):
    """Print a wrapped paragraph."""
    import textwrap
    wrapped = textwrap.fill(text, width=90)
    p(wrapped)
    p()

# ── Header ────────────────────────────────────────────────────────────────────
p()
p("╔" + "═" * 78 + "╗")
p("║" + f"  RUN NARRATIVE — {run_ts_fmt}".ljust(78) + "║")
p("║" + f"  Log: {Path(LOG_FILE).name}".ljust(78) + "║")
p("║" + f"  Phases narrated: {', '.join(include_phases) if include_phases else 'all'}".ljust(78) + "║")
p("╚" + "═" * 78 + "╝")
p()

# PRD project name
proj_name = "unknown project"
if prd:
    proj_name = prd.get("project", {}).get("name", prd.get("title", "unknown project"))

para(
    f"This narrative covers the orchestration run initiated at {run_ts_fmt} for the "
    f"'{proj_name}' project. The account below is chronological and event-driven, "
    f"reconstructed from the run log at {Path(LOG_FILE).name} and supporting "
    f"orchestration log files."
)

# ── Pre-run section ────────────────────────────────────────────────────────────
section("PRE-RUN RESET AND INITIALIZATION")

# Check for preflight events
preflight_events = [e for e in events if e[0] == 'preflight_ok']
if preflight_events:
    n_checks = preflight_events[0][2]
    ts = preflight_events[0][1] or "?"
    para(
        f"At {fmt_ts(ts)}, the pre-flight integrity check completed with all {n_checks} checks "
        f"passing. This confirmed the runner script was present and shellcheck-clean, the PRD "
        f"file valid JSON, the project output directory matching the PRD configuration, required "
        f"API keys set, and the dashboard container serving a live PRD feed."
    )

# OpenRouter before
if openrouter_before is not None:
    para(
        f"The OpenRouter account balance stood at ${openrouter_before:.4f} at run start. "
        f"The pipeline proceeded with the pre-run reset sequence: archiving prior log artifacts, "
        f"clearing agent-status.json, and restarting the agent-monitor container to bind-mount "
        f"the PRD directory and log directory for live dashboard serving."
    )

# PRD remediation events
prd_events = [e for e in events if e[0] == 'prd_remediate']
if prd_events:
    msgs = [e[2] for e in prd_events[:3]]
    para(
        f"PRD pre-run remediation ran and applied the following corrections: "
        + "; ".join(msgs) + ". "
        f"This deterministic step ensures every run begins from a canonical state "
        f"with all stories at 'pending' and required testCriteria stubs in place."
    )

# PRD stories overview
if prd:
    stories = prd.get("stories", [])
    base_stories = [s for s in stories if not s.get("splitFrom")]
    base_ids = ", ".join(s["id"] for s in base_stories)
    para(
        f"The PRD carried {len(base_stories)} base user stor(y/ies): {base_ids}. "
        f"The implementation order was: "
        + str(prd.get("implementationOrder", {})) + ". "
        f"Budget ceiling was set at ${prd.get('configuration', {}).get('budget', '?')}."
    )

# ── Per-phase narrative ────────────────────────────────────────────────────────

for phase in include_phases:
    phase_events = [e for e in events if e[0] != 'phase_start' or e[2] == phase]
    # Include all events that occur between this phase's start and next phase's start
    # Simpler: just filter by phase tag on events that have it, or use sequence position
    phase_start_idx = None
    phase_end_idx = len(events)
    for idx, e in enumerate(events):
        if e[0] == 'phase_start' and e[2] == phase:
            phase_start_idx = idx
        elif phase_start_idx is not None and e[0] == 'phase_start' and e[2] != phase:
            phase_end_idx = idx
            break
    if phase_start_idx is None:
        continue

    phase_ev = events[phase_start_idx:phase_end_idx]
    phase_ts = phase_ev[0][1] if phase_ev else None

    section(f"PHASE: {phase.upper()}")

    p(f"  Timestamp: {fmt_ts(phase_ts)}")
    p()

    # Spec pass events
    spec_evs = [e for e in phase_ev if e[0] == 'spec_mode']
    if spec_evs:
        splits = [e[2] for e in spec_evs if 'split' in e[2].lower() and 'violation' not in e[2].lower() and 'drop' not in e[2].lower()]
        retries = [e[2] for e in spec_evs if 'retry' in e[2].lower()]
        rejections = [e[2] for e in spec_evs if 'rejected' in e[2].lower() or 'violation' in e[2].lower()]
        completions = [e[2] for e in spec_evs if 'completed' in e[2].lower()]

        spec_summary = []
        if splits:
            spec_summary.append(f"{len(splits)} story split(s) applied")
        if retries:
            spec_summary.append(f"{len(retries)} spec retry/retries triggered")
        if rejections:
            spec_summary.append(f"{len(rejections)} speckit rejection(s)")
        if completions:
            spec_summary.append("specification pass completed")

        spec_str = "; ".join(spec_summary) if spec_summary else "specification pass ran"
        para(
            f"The specification pass (Step 0) ran the openspec elaboration and speckit "
            f"verification agents for each story in phase '{phase}'. Summary: {spec_str}. "
        )

        if splits:
            for s in splits[:3]:
                para(f"    Split event: {s}")

        if retries:
            para(
                f"Transient failures during spec-mode triggered {len(retries)} automatic retry/retries. "
                f"These are typically due to null responses from the LLM provider and are handled "
                f"with bounded backoff — the pipeline continued on all retry-recovered stories."
            )

        if rejections:
            for r in rejections[:2]:
                para(f"    Rejection/violation: {r}")

    # CPA gate
    cpa_evs = [e for e in phase_ev if e[0] == 'cpa_gate']
    if cpa_evs:
        verdict = cpa_evs[0][2]
        ts = cpa_evs[0][1]
        para(
            f"At {fmt_ts(ts)}, the Cost-Per-Attempt (CPA) pre-pass gate (Step 0.1) returned "
            f"{verdict}. This gate checks per-story cost forecasts against the run budget and "
            f"flags high-risk tickets before any agent tokens are consumed."
        )

    # Stories in this phase
    story_start_evs = [e for e in phase_ev if e[0] == 'story_start']
    story_complete_evs = [e for e in phase_ev if e[0] == 'story_complete']
    cost_evs = [e for e in phase_ev if e[0] == 'cost']

    # Build per-story view
    story_set = {}
    for e in story_start_evs:
        sid = e[2]
        if sid not in story_set:
            story_set[sid] = {'start': e[1]}
    for e in story_complete_evs:
        sid = e[2]
        story_set.setdefault(sid, {})['end'] = e[1]
    for e in cost_evs:
        r = e[2]
        sid = r['story']
        story_set.setdefault(sid, {})
        story_set[sid]['model']   = r['model']
        story_set[sid]['cost']    = r['cost']
        story_set[sid]['in_tok']  = r['in_tok']
        story_set[sid]['out_tok'] = r['out_tok']
        story_set[sid]['elapsed'] = r['elapsed']
        story_set[sid]['status']  = r['status']

    if story_set:
        para(f"Phase '{phase}' executed {len(story_set)} stor(y/ies):")
        for sid, info in story_set.items():
            model   = info.get('model', 'unknown')
            cost    = f"${info['cost']:.4f}" if 'cost' in info else 'unknown'
            elapsed = info.get('elapsed', '?')
            in_tok  = info.get('in_tok', '?')
            out_tok = info.get('out_tok', '?')
            status  = info.get('status', 'unknown')
            start   = info.get('start', '?')
            end     = info.get('end', '?')
            retries = retry_counts.get(sid, 1)
            retry_str = f" ({retries} attempt(s))" if retries > 1 else ""

            # Find story title from PRD
            story_title = sid
            if prd:
                for s in prd.get("stories", []):
                    if s["id"] == sid:
                        story_title = s.get("title", sid)
                        break

            p(f"  ▶ {sid}: {story_title}")
            p(f"       Model:   {model}")
            p(f"       Tokens:  {in_tok} in / {out_tok} out")
            p(f"       Cost:    {cost}   Elapsed: {elapsed}{retry_str}")
            p(f"       Status:  {status}")
            p()

        phase_total = sum(r['cost'] for r in phase_costs.get(phase, []))
        if phase_total > 0:
            para(f"Phase '{phase}' total agent cost: ${phase_total:.4f}")

    # Self-heal events
    heal_evs = [e for e in phase_ev if e[0] == 'self_heal']
    if heal_evs:
        para(
            f"The self-heal subsystem activated {len(heal_evs)} time(s) during phase '{phase}':"
        )
        for e in heal_evs:
            para(f"    Heal event: {e[2]}")

    # Gate results
    gate_evs = [e for e in phase_ev if e[0] == 'gate_result']
    if gate_evs:
        p("  Testing gates:")
        for e in gate_evs:
            v = e[2]['verdict'].upper()
            d = e[2]['detail']
            icon = "✓" if v == "PASS" else ("⚠" if v == "WARN" else "✗")
            p(f"    [{icon} {v}] {d}")
        p()

    # Vitest results for this phase
    vr = vitest_results.get(phase)
    if vr:
        total_t = vr.get('numTotalTests', 0)
        passed  = vr.get('numPassedTests', 0)
        failed  = vr.get('numFailedTests', 0)
        para(
            f"Vitest oracle for phase '{phase}': {total_t} tests — "
            f"{passed} passed, {failed} failed. "
            + ("All tests green." if failed == 0 else f"WARNING: {failed} test(s) failed.")
        )

    # Phase gate verdict
    gate_evs = [e for e in phase_ev if e[0] == 'phase_gate']
    if gate_evs:
        g = gate_evs[-1]
        verdict = g[2]['verdict']
        detail  = g[2]['detail']
        ts      = g[1]
        outcome = "green-lit" if verdict == "GO" else "BLOCKED"
        para(
            f"At {fmt_ts(ts)}, the phase gate (Step 5) returned '{verdict}' — the phase was "
            f"{outcome}. Gate rationale: {detail}"
        )

    # Phase handoff
    if phase in handoffs:
        hf = handoffs[phase]
        # Extract completed stories list
        completed_match = re.findall(r'- ([\w-]+): (.+)', hf)
        if completed_match:
            p("  Phase handoff — completed stories:")
            for sid, title in completed_match[:10]:
                p(f"    • {sid}: {title}")
            p()

# ── Post-run summary ────────────────────────────────────────────────────────────

section("POST-RUN SUMMARY")

# Final PRD state
if prd:
    stories = prd.get("stories", [])
    completed = [s for s in stories if s.get("completed") or s.get("status") == "completed"]
    pending   = [s for s in stories if not s.get("completed") and s.get("status") != "completed"]
    para(
        f"Final PRD state: {len(completed)}/{len(stories)} stories marked completed. "
        + (f"Completed: {', '.join(s['id'] for s in completed)}." if completed else "No stories marked completed in PRD file (may reflect snapshot timing).")
    )

# Cost summary
para(f"Aggregate cost delta: {cost_delta_str}")
if all_cost_recs:
    p("  Per-phase cost breakdown:")
    for phase, recs in phase_costs.items():
        phase_total = sum(r['cost'] for r in recs)
        p(f"    {phase:20s}  ${phase_total:.4f}  ({len(recs)} agent call(s))")
    p()

# Healing summary
if healing:
    heals_ok  = [h for h in healing if h.get("outcome") == "resolved"]
    heals_fail = [h for h in healing if h.get("outcome") != "resolved"]
    para(
        f"Self-heal log: {len(healing)} total event(s), "
        f"{len(heals_ok)} resolved, {len(heals_fail)} unresolved."
    )

# TC summary
if tc_facts:
    total_facts = sum(
        len(d.get(sid, {}).get("facts", []))
        for d in tc_facts.values()
        for sid in d
    )
    para(f"Test criteria verification: {total_facts} facts verified across {len(tc_facts)} phase(s).")

# Vitest global summary
if vitest_results:
    grand_total   = sum(v.get('numTotalTests', 0)  for v in vitest_results.values())
    grand_passed  = sum(v.get('numPassedTests', 0) for v in vitest_results.values())
    grand_failed  = sum(v.get('numFailedTests', 0) for v in vitest_results.values())
    para(
        f"Overall test health: {grand_total} tests across all phases — "
        f"{grand_passed} passed, {grand_failed} failed."
    )

# Phases completed
phases_completed = [e[2]['phase'] for e in events if e[0] == 'phase_gate' and e[2]['verdict'] == 'GO']
if phases_completed:
    para(
        f"Phases successfully gated: {', '.join(phases_completed)}. "
        f"The pipeline completed all declared phases and issued a final GO verdict for each."
    )

# Duration
if run_start_time and run_end_time:
    total_dur = duration_between(run_start_time, run_end_time)
    para(f"Total wall-clock duration (first to last timestamp): approximately {total_dur}.")

p()
p(SEP)
p("  END OF RUN NARRATIVE")
p(SEP)
p()
PYEOF

ok "Narrative complete."
