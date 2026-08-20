import sys
import json, sys
import os as _os
from _testfile import is_test_file as _is_test_file
def _pair_key(f):
    """Path with the test marker AND extension removed, so 'a.service.ts' and
    'a.service.spec.ts' produce the same key."""
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _manifest_files():
    try:
        with open(_os.environ.get('_TCW_MANIFEST', '')) as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return []
def _files_for(story):
    """After implementation the RECORD supersedes the PREDICTION."""
    declared = (story.get('technicalNotes') or {}).get('files') or []
    produced = _manifest_files()
    if not produced:
        return declared
    base = set()
    for _f in declared:
        base.add(_pair_key(_f))
    extra = []
    for _f in produced:
        if _f in declared or _pair_key(_f) in base:
            extra.append(_f)
    return list(dict.fromkeys(declared + extra))



with open(sys.argv[1]) as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get(sys.argv[2], [])
by_id = {s['id']: s for s in d['stories']}
results = []
story_filter = sys.argv[3]

# The TARGET story (--story) must always be considered "needed" if it
# structurally qualifies, regardless of implementationOrder timing — a
# mid-execution split can leave a story transiently absent from
# implementationOrder[phase] even though it's a real, scheduled story.
# Root cause this fixes (found live, 2026-07-09): SKY-003-test's inline gate
# reported "TC writer populated testCriteria" while the story's own
# testCriteria.facts remained empty, because this exact query silently
# excluded it and the caller trusted the exit code alone.
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids + [story_filter]

for sid in phase_ids:
    if story_filter and sid != story_filter:
        continue
    s = by_id.get(sid, {})
    # Defensive check (found live, 2026-07-06, tier3-full-run-15): a story
    # that was split delegates its ENTIRE implementation to child stories —
    # its own technicalNotes.files still lists the original (now-delegated)
    # files, so it can look like a "test story with no TC yet" even though
    # the real work (and TC) belongs to a child. spec-mode-runner marks a
    # delegated parent 'deprecated' at split time (and removes it from
    # implementationOrder), which is the actual, specific signal for this
    # case — checked below.
    #
    # Root cause fixed (found live, 2026-07-14, tier3-travel-app run): this
    # used to ALSO skip any story with completed == True, on the theory that
    # a delegated parent gets marked completed too. But EVERY story this
    # BATCH gate (Step 1.6, called post-Step-3.2) examines is, by
    # construction, already completed by the time it runs — that's the
    # entire reason the gate exists post-execution. The completed-exclusion
    # therefore silently no-op'd this script for every genuinely-finished
    # combo story (impl+test files together, e.g. SKY-004) and every
    # worktree-lane pure-test story once it completed, causing the CALLER
    # (Step 1.6 in run-agent-orchestration.sh, whose own "needs TC" query has
    # no such completed-exclusion) to retry 3 times against a script that
    # always no-ops, then permanently BLOCK a story with real, already-
    # verified (tsc + external tests passed) work over a bookkeeping mismatch.
    if s.get('status') == 'deprecated':
        continue
    files = _files_for(s)
    already_has_tc = bool((s.get('testCriteria') or {}).get('facts'))

    # WHAT NEEDS TEST CRITERIA IS A STORY WITH VERIFICATION CRITERIA AND NONE YET.
    #
    # This used to require `any(_is_test_file(f) for f in files)` — a story qualified only if its
    # OWN file list contained a test file. That is the greenfield shape, where the spec pass splits
    # work into an implementation story and a paired test story. A brownfield ticket arrives as ONE
    # story with implementation files and can never qualify.
    #
    # Live metrolinx AMSD-2041, 2026-08-19, all three runs: the story carried SIX verification
    # criteria — its only real specification, since its single acceptance criterion was the Jira
    # placeholder "See in:" — finished with testCriteria: null, and the seam reported "TC generation
    # complete". Two of those criteria say the page must render published content with no regression
    # when no preview signal is active; run 3 shipped `enable: true` unconditionally, the exact
    # regression they describe, because nothing had turned them into an assertion.
    #
    # Test criteria exist to make verification criteria EXECUTABLE, so that is the qualification.
    # A story with no VCs is still skipped: there is nothing to make executable, and inventing
    # criteria from the implementation is how a test comes to ratify whatever was built.
    has_vcs = bool(s.get('verificationCriteria'))
    is_test_story = any(_is_test_file(f) for f in files)
    if (is_test_story or has_vcs) and not already_has_tc:
        results.append(sid)

print('\n'.join(results))
