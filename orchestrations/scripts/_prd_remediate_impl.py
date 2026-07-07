#!/usr/bin/env python3
"""PRD remediation logic. Called by prd-remediate.sh."""
import json
import re
import sys

# ui_and_review removed (2026-07-07): the pipeline is scaffold -> core only.
# 'documentation' is NOT added here despite being requested — investigation
# (2026-07-07) confirmed it has never been wired into phase execution at all:
# the doc-* agent profiles (doc-coordinator, guide-author, etc.) exist in
# profiles.json but no phase-loop code in run-agent-orchestration.sh/
# tier3-travel-app-run.sh ever invokes them. Adding it to REQUIRED_PHASES now
# would fail every run against a PRD that (correctly, today) has no
# documentation phase. See project memory for the scoped list of what
# building it for real would require.
REQUIRED_PHASES = ['scaffold', 'core']
RUNTIME_FIELDS  = ['startedAt', 'completedAt', 'error', 'agentLog']
# actualCost is intentionally preserved — it is the historical record of what each
# story actually cost and is required for estimates-vs-actuals reporting.
MAX_ACS = 24

PRD_FILE   = sys.argv[1]
# Optional: restrict the destructive status-reset (step 6) to a single phase's
# stories. Without this, remediation running before phase N would reset stories
# already completed (and merged) in phase N-1 back to pending — this script runs
# before EVERY phase transition within a single pipeline run, not just at the
# start of a fresh run, so a global reset silently destroys prior-phase progress.
TARGET_PHASE = sys.argv[2] if len(sys.argv) > 2 else None

with open(PRD_FILE) as f:
    prd = json.load(f)

stories    = prd.get('stories', [])
impl_order = prd.get('implementationOrder', {})
by_id      = {s['id']: s for s in stories}
changes    = []

# ── 0. Remove all BUG-* stories (stale bug-fix artifacts from prior runs) ────
# BUG-* stories are generated during failed runs. They must never persist into
# the next run — their originals are still in stories[] and will be re-run.
bug_ids = {s['id'] for s in stories if s['id'].startswith('BUG-')}
if bug_ids:
    for phase in impl_order:
        impl_order[phase] = [s for s in impl_order[phase] if s not in bug_ids]
    prd['stories'] = [s for s in stories if s['id'] not in bug_ids]
    stories = prd['stories']
    by_id   = {s['id']: s for s in stories}
    changes.append(f"removed {len(bug_ids)} stale BUG-* stories from prior run")

# ── 1. Remove stale bug-fix runtime splits ────────────────────────────────────
# Two patterns:
# (a) <base>-(impl|test|table)-N where <base> is also an active story.
# (b) SPEC-N or SPEC-N-N: ephemeral sub-stories created by the spec-mode runner
#     when it re-splits an already-active story mid-run. These should never
#     survive into the next run — their parent is already scheduled.
active_before = set(sid for phase in impl_order.values() for sid in phase)
split_re    = re.compile(r'^(.+)-(impl|test|table)-\d+$')
spec_sub_re = re.compile(r'^SPEC-\d+(-\d+)*$')
stale_splits = set()
for sid in active_before:
    m = split_re.match(sid)
    if m and m.group(1) in active_before:
        stale_splits.add(sid)
    # Ephemeral spec sub-story: generic SPEC-N id AND parent is still active
    if spec_sub_re.match(sid):
        s = by_id.get(sid, {})
        parent = s.get('specification', {}).get('createdFrom', '')
        if parent and parent in active_before:
            stale_splits.add(sid)
if stale_splits:
    for phase in impl_order:
        impl_order[phase] = [s for s in impl_order[phase] if s not in stale_splits]
    prd['stories'] = [s for s in stories if s['id'] not in stale_splits]
    stories = prd['stories']
    by_id   = {s['id']: s for s in stories}
    changes.append(f"removed {len(stale_splits)} stale splits: {sorted(stale_splits)}")

# ── 2. Remove no-files stories from implementationOrder ──────────────────────
no_files_removed = []
for phase in list(impl_order.keys()):
    kept = []
    for sid in impl_order[phase]:
        s = by_id.get(sid, {})
        if s.get('technicalNotes', {}).get('files'):
            kept.append(sid)
        else:
            no_files_removed.append(sid)
    impl_order[phase] = kept
if no_files_removed:
    changes.append(f"removed {len(no_files_removed)} no-files stories from impl order: {no_files_removed}")

# ── 3. Remove extra/stale phases ──────────────────────────────────────────────
extra_phases = [p for p in list(impl_order.keys()) if p not in REQUIRED_PHASES]
for p in extra_phases:
    del impl_order[p]
if extra_phases:
    changes.append(f"removed extra phases: {extra_phases}")

# ── 4. Trim oversized ACs ─────────────────────────────────────────────────────
active_ids = set(sid for phase in impl_order.values() for sid in phase)
trimmed = []
for s in stories:
    if s['id'] not in active_ids:
        continue
    acs = s.get('acceptanceCriteria', [])
    if len(acs) > MAX_ACS:
        s['acceptanceCriteria'] = acs[:MAX_ACS]
        trimmed.append(f"{s['id']}:{len(acs)}->{MAX_ACS}")
if trimmed:
    changes.append(f"trimmed ACs: {trimmed}")

# ── 5. Deduplicate file paths within each individual story (not across stories) ─
# Only removes exact duplicate paths within the same story's own files array.
# Cross-story file sharing (impl + test story pairing) is intentional and must
# NOT be removed — that is not a conflict.
deduped_count = 0
for sid in active_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    if not files:
        continue
    deduped = list(dict.fromkeys(files))  # preserve order, remove exact duplicates
    if len(deduped) != len(files):
        s['technicalNotes']['files'] = deduped
        deduped_count += len(files) - len(deduped)
if deduped_count:
    changes.append(f"removed {deduped_count} exact-duplicate file path(s) within stories")

# ── 6. Reset active story status to pending + strip runtime fields ────────────
# Scoped to TARGET_PHASE when given — must never reset a story that belongs to a
# different (e.g. already-completed, already-merged) phase.
reset_scope_ids = active_ids
if TARGET_PHASE is not None:
    reset_scope_ids = set(impl_order.get(TARGET_PHASE, []))

reset_count = 0
for s in stories:
    if s['id'] not in reset_scope_ids:
        continue
    changed = False
    if s.get('status') not in ('pending', 'deprecated') or s.get('completed'):
        s['status']    = 'pending'
        s['completed'] = False
        changed = True
    for k in RUNTIME_FIELDS:
        if k in s:
            del s[k]
            changed = True
    if changed:
        reset_count += 1
if reset_count:
    changes.append(f"reset {reset_count} active stories to pending")

# ── Write back ────────────────────────────────────────────────────────────────
with open(PRD_FILE, 'w') as f:
    json.dump(prd, f, indent=2)

if changes:
    for c in changes:
        print(f"  fixed: {c}")
else:
    print("  (no changes needed — PRD already clean)")
