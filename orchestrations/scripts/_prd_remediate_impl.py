#!/usr/bin/env python3
"""PRD remediation logic. Called by prd-remediate.sh."""
import json
import os
import re
import sys

# ui_and_review removed (2026-07-07): the pipeline is scaffold -> core only.
# 'documentation' is NOT added here despite being requested — investigation
# (2026-07-07) confirmed it has never been wired into phase execution at all:
# the guide-author agent profile exists in
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

# A RESUME KEEPS WHAT THE RUN HAS DONE (found live, 2026-09-20, regintel
# 20260919T224649Z resume 6): the resume was launched to retry ONE failed core
# story; the lifecycle ran the orchestrator without --reset and the orchestrator
# re-queued only that story — but this step ran first and "reset 15 active
# stories to pending", so every completed core story was re-implemented,
# re-reviewed and re-gated ($20+ of the run's $43). On a resume the completed
# flags are the run's progress: a completed story keeps its status and its
# record; a story left in-progress or failed is what the resume exists to retry
# and becomes pending. A fresh launch (no EPAM_RESUME_RUN) resets the phase as
# before. Same signal prd-remediate.sh already reads for the stale-spec check.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'handlers'))
from resume_semantics import resume_preserves  # noqa: E402
IS_RESUME = resume_preserves('completed-stories')

# A STORY THE RESUME RE-QUEUES STARTS ITS LADDER AFRESH. The resume keeps story-retry-state/ and
# story-rung/ (a story continuing mid-ladder needs them; the reviewer needs a completed story's
# rung). A story turned from failed back to pending here is not continuing — it is starting over,
# and its ladder starts over with it. regintel 140717Z resume 3 (2026-09-21): REGI-004-A and
# REGI-010-A were re-queued carrying retry_count=8 from the loop that had failed them, and each
# "failed after 8 attempts" in four seconds, having made none.
# The same default the orchestrator and the lifecycle use when LOG_DIR is not in the environment.
LOG_DIR = os.environ.get('LOG_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')
def _ladder_afresh(story_id):
    if not LOG_DIR:
        return False
    removed = False
    state_dir = os.path.join(LOG_DIR, 'story-retry-state')
    if os.path.isdir(state_dir):
        for name in os.listdir(state_dir):
            if name == story_id or name.startswith(story_id + '.'):
                os.remove(os.path.join(state_dir, name)); removed = True
    rung = os.path.join(LOG_DIR, 'story-rung', story_id + '.json')
    if os.path.isfile(rung):
        os.remove(rung); removed = True
    return removed

reset_count = 0
ladder_reset = []
for s in stories:
    if s['id'] not in reset_scope_ids:
        continue
    # AN ESCALATED STORY GOES ROUND AGAIN ON A RESUME. "Escalated" is the review loop saying
    # "human review required": the story completed, review rejected it, and its ladder was spent.
    # A resume IS the human's answer. Left completed-but-escalated, the story is re-reviewed on
    # the same spent ladder and escalates again, every resume — regintel 140717Z resume 4
    # (2026-09-21): REGI-003b, red because a sibling's rewrite changed dedup.py under its tests.
    if IS_RESUME and s.get('completed') and s.get('status') == 'completed' and s.get('reviewStatus') != 'escalated':
        continue
    changed = False
    if s.get('status') not in ('pending', 'deprecated') or s.get('completed'):
        if IS_RESUME and _ladder_afresh(s['id']):
            ladder_reset.append(s['id'])
        s['status']    = 'pending'
        s['completed'] = False
        s.pop('reviewStatus', None)
        changed = True
    for k in RUNTIME_FIELDS:
        if k in s:
            del s[k]
            changed = True
    if changed:
        reset_count += 1
if reset_count:
    changes.append(f"reset {reset_count} active stories to pending")
if ladder_reset:
    changes.append(f"ladder started afresh for re-queued {', '.join(ladder_reset)} (retry state and rung of the failed attempts cleared)")

# ── 7. Deterministic gate: no pending story may be orphaned from every
#      implementationOrder phase ─────────────────────────────────────────────
# Root cause this catches (found live, 2026-07-08/09, tier3-travel-app run):
# Step 0.9's prd-model-coordinator has tool write access and processes ALL
# pending stories PRD-wide (not scoped to the phase currently running); its
# own reviewer gate only diffs the LAST 1000 CHARACTERS of before/after PRD
# content (run-agent-orchestration.sh, "${_mc_prd_before: -1000}") — for any
# real multi-KB PRD, that reviewer is structurally blind to a rewrite
# corrupting a story earlier in stories[]. That corruption silently stripped
# technicalNotes.files from SKY-002/003/004 during the scaffold phase; step 2
# above then (correctly, per its own logic, but disastrously here) dropped
# those now-fileless stories from implementationOrder.core, and the core
# phase silently ran as a no-op ("phase core has no stories; skipping") with
# ZERO error — the failure was completely invisible until manually inspected.
#
# This check is intentionally NOT gated behind the is_canonical fast path in
# prd-remediate.sh (it runs before that decision is even made) — the exact
# scenario above looked "canonical" from core's own perspective (no splits of
# ITS OWN stories yet), even though the orphaning had already happened.
# THE GATE REPAIRS; IT DOES NOT ABORT (2026-09-15). This used to print FATAL and "restore from
# the canonical PRD or manually re-add these IDs" — an instruction to a human the pipeline does
# not have — and that is how the regintel greenfield run 20260915T101555Z ended after $9: a split
# child that was the schema's own placeholder (id "optional") displaced REGI-001, and the gate
# stopped the run at the phase boundary. The remedy was always knowable:
#   - a story whose fields are the schema placeholders is not a story: dropped, and the parent it
#     deprecated is restored to pending and placed;
#   - any other pending story no phase lists is put into the phase being remediated (the phase
#     the coordinator's corrupting write removed it from, in the July 8 case).
# Every seam heals before it aborts; this one aborts only when a story cannot be placed.
def _canonical_story(sid):
    """The authored story of this id from <prd>.canonical.json beside the working PRD, or None."""
    try:
        _c = PRD_FILE[:-len('.json')] + '.canonical.json' if PRD_FILE.endswith('.json') else None
        if not _c or not __import__('os').path.isfile(_c):
            return None
        with open(_c) as fh:
            return next((x for x in json.load(fh).get('stories', []) if x.get('id') == sid), None)
    except (OSError, ValueError):
        return None

def _split_child_example():
    """The one example split child the spec prompt shows (config/spec-split-example.json) — declared once."""
    try:
        _cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'spec-split-example.json')
        with open(_cfg) as fh:
            return json.load(fh).get('child', {})
    except (OSError, ValueError):
        return {}

def _is_placeholder_story(st):
    ex = _split_child_example()
    return any(isinstance(ex.get(k), str) and str(st.get(k, '')).strip() == ex[k]
               for k in ('id', 'title', 'description'))

# A PENDING STORY WHOSE OWN FIELDS ARE THE PLACEHOLDERS is the echo written over an authored story
# (the split "redistributed" REGI-001's content and left '...'); placed or not, its authored
# fields come back from the canonical PRD. Judged by the same declared vocabulary.
_restored_content = []
for s in stories:
    if s.get('status') == 'pending' and not s.get('completed') and _is_placeholder_story(s):
        _c = _canonical_story(sid=s['id'])
        if _c:
            for k, v in _c.items():
                if k not in ('status', 'completed', 'specification'):
                    s[k] = v
            # Its elaboration described the content that was overwritten: cleared, so the resume's
            # spec pass takes this story again (lib/handlers/stories-lacking-spec.js).
            s.pop('specification', None)
            _restored_content.append(s['id'])
if _restored_content:
    print(f"  REPAIRED: authored content restored from the canonical PRD over placeholder fields: {_restored_content}", file=sys.stderr)
    changes.append(f"placeholder content restored from canonical: {_restored_content}")

all_active_ids = set(sid for ids in impl_order.values() for sid in ids)
orphaned_pending = [s['id'] for s in stories
                    if s.get('status') == 'pending' and not s.get('completed') and s['id'] not in all_active_ids]
if orphaned_pending:
    repaired = []
    dropped = []
    target = TARGET_PHASE if TARGET_PHASE in impl_order else (next(iter(impl_order)) if impl_order else None)
    for sid in orphaned_pending:
        st = by_id.get(sid) or next((x for x in stories if x['id'] == sid), None)
        if st is None:
            continue
        if _is_placeholder_story(st):
            parent_id = (st.get('specification') or {}).get('createdFrom')
            prd['stories'] = [x for x in prd['stories'] if x['id'] != sid]
            stories = prd['stories']
            dropped.append(sid)
            parent = next((x for x in stories if x['id'] == parent_id), None) if parent_id else None
            if parent is not None:
                parent['status'] = 'pending'
                parent['completed'] = False
                # THE CONTENT THE SPLIT OVERWROTE COMES BACK FROM THE CANONICAL PRD. "ACs
                # redistributed → delegated" left the parent with title '...' and one AC of '...';
                # placed back like that, the writer would build a story with no title and one
                # placeholder criterion. The authored fields are beside the working PRD.
                _canon = _canonical_story(sid=parent['id'])
                if _canon:
                    # Every field the authored story declares comes back; the spec block described
                    # the split that is being undone, so it goes too — the resume's spec pass takes
                    # the story again (lib/handlers/stories-lacking-spec.js).
                    for k, v in _canon.items():
                        if k not in ('status', 'completed', 'specification'):
                            parent[k] = v
                    parent.pop('specification', None)
                spec = parent.get('specification') or {}
                if isinstance(spec.get('splitIds'), list):
                    spec['splitIds'] = [c for c in spec['splitIds'] if c != sid]
                if parent['id'] not in all_active_ids and target is not None:
                    impl_order[target].append(parent['id'])
                    all_active_ids.add(parent['id'])
                    repaired.append(f"{parent['id']} restored to pending and placed in '{target}' (its placeholder child '{sid}' dropped)")
                else:
                    repaired.append(f"{parent['id']} restored to pending (its placeholder child '{sid}' dropped)")
            continue
        if target is None:
            print(f"  FATAL: pending story {sid} is in no implementationOrder phase and there is no phase to place it in", file=sys.stderr)
            sys.exit(1)
        impl_order[target].append(sid)
        all_active_ids.add(sid)
        repaired.append(f"{sid} placed in '{target}'")
    by_id = {s['id']: s for s in stories}
    print(
        f"  REPAIRED: {len(orphaned_pending)} pending stor(y/ies) were in no implementationOrder phase "
        f"(a phase would have run as a no-op): {'; '.join(repaired)}"
        + (f"; dropped placeholder stor(y/ies) {dropped}" if dropped else ''),
        file=sys.stderr,
    )
    changes.append(f"orphaned stories repaired: {repaired}")

# ── 8. Backfill split-sibling dependencies (backward-compat repair) ──────────
# Root cause this repairs (found live, 2026-07-09, tier3-travel-app run): a
# split child's `dependencies` array comes straight from the LLM's own split
# proposal — nothing deterministically cross-referenced a test-only sibling
# to its impl sibling from the SAME split, so claude.sh's deterministic
# dependency-contract injection (which grounds a story in its dependency's
# REAL exported signatures) never fired for these pairs. This is now fixed at
# split-creation time in spec-mode-runner.js (wireSplitSiblingDependencies),
# but PRDs split BEFORE that fix shipped (e.g. the live SKY-003-test/
# SKY-004-test case) still have empty `dependencies` — this step retroactively
# repairs those using the identical basename-matching algorithm, so a fresh
# spec-pass is not required to pick up the fix. No-ops cleanly (like the JS
# version) if the project has no .epam/contract-generation.json, or if that
# config lacks the (already-standard) testFilePattern/sourceExtensions keys —
# same stack-agnostic, config-driven convention as every other consumer of
# that file.

output_dir = prd.get('project', {}).get('outputDir')
backfilled = []
if output_dir:
    config_path = os.path.join(output_dir, '.epam', 'contract-generation.json')
    cfg = None
    try:
        with open(config_path) as f:
            cfg = json.load(f)
    except OSError:
        cfg = None
    except json.JSONDecodeError:
        cfg = None

    test_file_pattern = (cfg or {}).get('testFilePattern')
    source_extensions = (cfg or {}).get('sourceExtensions')
    if test_file_pattern and isinstance(source_extensions, list) and source_extensions:
        test_re = re.compile(test_file_pattern)
        exts = sorted(source_extensions, key=len, reverse=True)

        def stem_of(file_path, is_test):
            base = file_path.rsplit('/', 1)[-1]
            if is_test:
                return test_re.sub('', base)
            for ext in exts:
                if base.endswith(ext):
                    return base[: -len(ext)]
            return base

        by_parent = {}
        for s in stories:
            parent = s.get('specification', {}).get('createdFrom')
            if parent:
                by_parent.setdefault(parent, []).append(s)

        for parent_id, siblings in by_parent.items():
            if len(siblings) < 2:
                continue
            for test_sibling in siblings:
                files = test_sibling.get('technicalNotes', {}).get('files', [])
                if not files or not all(test_re.search(f) for f in files):
                    continue
                if test_sibling.get('dependencies'):
                    continue  # already wired (by the live fix or a prior backfill)
                test_stems = {stem_of(f, True) for f in files}
                deps = set()
                for impl_sibling in siblings:
                    if impl_sibling is test_sibling:
                        continue
                    impl_files = impl_sibling.get('technicalNotes', {}).get('files', [])
                    if not impl_files or any(test_re.search(f) for f in impl_files):
                        continue
                    impl_stems = {stem_of(f, False) for f in impl_files}
                    if test_stems & impl_stems:
                        deps.add(impl_sibling['id'])
                if deps:
                    test_sibling['dependencies'] = sorted(deps)
                    backfilled.append(f"{test_sibling['id']} -> {sorted(deps)}")
if backfilled:
    changes.append(f"backfilled {len(backfilled)} split-sibling dependency link(s): {backfilled}")

# ── 9. Repair provider/model misalignment on .test.ts stories, using the
#      canonical PRD as source of truth (config-driven, not a hardcoded
#      provider literal — same "canonical decides, engine has no stack
#      opinion" convention as elsewhere in this file) ────────────────────────
#
# Root cause this fixes (found live, 2026-07-13, tier3-travel-app run): stale
# core-phase data (aiProvider=minimax on SKY-002/003/004) survived multiple
# `git checkout` restores of the runtime PRD tonight, because git checkout
# only restores to whatever was last COMMITTED -- which was itself already
# contaminated from an earlier (pre-tonight) run that predates the ".test.ts
# always caught this, but nothing ever repaired it -- the phase just
# hard-aborted with "fix prd.json manually" even though the correct value was
# sitting right there in the canonical PRD the whole time.
#
# Scoped to reset_scope_ids (TARGET_PHASE when given, matching step 6 above)
# so a prior, already-completed phase's stories are never touched here either.
canonical_path = None
if PRD_FILE.endswith('.json'):
    _candidate = PRD_FILE[: -len('.json')] + '.canonical.json'
    if os.path.isfile(_candidate):
        canonical_path = _candidate

canonical_by_id = {}
if canonical_path:
    try:
        with open(canonical_path) as f:
            canonical_by_id = {s['id']: s for s in json.load(f).get('stories', [])}
    except (OSError, json.JSONDecodeError):
        canonical_by_id = {}

provider_repaired = []
if canonical_by_id:
    for sid in reset_scope_ids:
        s = by_id.get(sid)
        if not s or s.get('aiProvider') != 'minimax':
            continue
        files = s.get('technicalNotes', {}).get('files', [])
        if not any(f.endswith('.test.ts') for f in files):
            continue
        canon = canonical_by_id.get(sid)
        if not canon or not canon.get('aiProvider') or canon['aiProvider'] == 'minimax':
            continue  # no safe, different value to repair to -- leave for a human
        old = f"{s.get('aiProvider')}/{s.get('model')}"
        s['aiProvider'] = canon['aiProvider']
        if canon.get('model'):
            s['model'] = canon['model']
        provider_repaired.append(f"{sid}: {old} -> {s['aiProvider']}/{s.get('model')}")
if provider_repaired:
    changes.append(f"repaired provider/model misalignment from canonical: {provider_repaired}")

# ── 10. Stub missing testCriteria on .test.ts stories (schema-presence only —
#       real content is filled in later by the TC writer gate at runtime; see
#       preflight-prd-integrity.sh check #17's own comment for why an empty
#       stub is sufficient here) ─────────────────────────────────────────────
tc_stubbed = []
for sid in reset_scope_ids:
    s = by_id.get(sid)
    if not s or 'testCriteria' in s:
        continue
    files = s.get('technicalNotes', {}).get('files', [])
    if not any(f.endswith('.test.ts') for f in files):
        continue
    s['testCriteria'] = {
        'facts': [],
        'sourceFiles': [],
        'mockStrategy': '',
        'bannedPatterns': [],
        'implStory': None,
    }
    tc_stubbed.append(sid)
if tc_stubbed:
    changes.append(f"added testCriteria stub to {len(tc_stubbed)} stor(y/ies): {tc_stubbed}")

# ── Write back (atomic: write to a temp file then rename, so a kill mid-write
# never leaves the PRD truncated/corrupted — the real cause behind at least
# one live "Bad control character in string literal" PRD corruption incident,
# 2026-07-11) ────────────────────────────────────────────────────────────────
_tmp_prd_file = PRD_FILE + '.tmp'
with open(_tmp_prd_file, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_file, PRD_FILE)

if changes:
    for c in changes:
        print(f"  fixed: {c}")
else:
    print("  (no changes needed — PRD already clean)")
