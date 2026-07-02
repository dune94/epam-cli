#!/usr/bin/env python3
"""PRD remediation logic. Called by prd-remediate.sh."""
import json
import re
import sys

REQUIRED_PHASES = ['scaffold', 'core', 'ui_and_review']
RUNTIME_FIELDS  = ['startedAt', 'completedAt', 'error', 'agentLog']
# actualCost is intentionally preserved — it is the historical record of what each
# story actually cost and is required for estimates-vs-actuals reporting.
MAX_ACS = 24

PRD_FILE = sys.argv[1]

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
reset_count = 0
for s in stories:
    if s['id'] not in active_ids:
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
