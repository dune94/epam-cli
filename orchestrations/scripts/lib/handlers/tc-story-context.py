import sys
import json
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



with open(sys.argv[2]) as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get(sys.argv[3], [])
by_id = {s['id']: s for s in d['stories']}
output_dir = sys.argv[1]
story_filter = sys.argv[4]

# Same fix as the TC_NEEDED query above — the target story must be considered
# even if implementationOrder[phase] transiently lacks it. Peer-file discovery
# below still iterates the ORIGINAL implementationOrder-derived list, which is
# correct and must not change.
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids + [story_filter]

lines = []
for sid in phase_ids:
    if story_filter and sid != story_filter:
        continue
    s = by_id.get(sid, {})
    files = _files_for(s)

    # WHAT GETS A BRIEF IS WHAT NEEDS ONE — the same rule as its sibling,
    # tc-stories-needing-criteria.py, which decides what qualifies.
    #
    # This used to require `any(_is_test_file(f) for f in files)`: a story got a brief only if its
    # own file list held a test file — the greenfield shape, where the spec pass splits work into an
    # implementation story and a paired test story. When the sibling was fixed and a brownfield
    # story started to QUALIFY, this one still skipped it, so the pipeline decided the story needed
    # test criteria and then handed the writer nothing. Live 2026-08-20, three invocations, and the
    # agent said so each time: "the 'Stories to process' section is empty — no story IDs, source
    # files, or verification criteria were provided." The gate reported PASSED regardless.
    #
    # The two handlers must agree, and a test asserts that every story which needs criteria can be
    # given a brief.
    is_test_story = any(_is_test_file(f) for f in files)
    has_vcs = bool(s.get('verificationCriteria'))
    if not (is_test_story or has_vcs):
        continue
    if (s.get('testCriteria') or {}).get('facts'):
        continue

    impl_files = [f for f in files if not _is_test_file(f)]
    test_files = [f for f in files if _is_test_file(f)]

    # Impl source files can live in the SAME story (impl+test not split into
    # separate children) or in a PEER story (split topology, e.g. SKY-004-A/
    # SKY-004-B). Seed with the story's own impl files first — the peer search
    # below only covers the split case and previously left impl_src empty
    # whenever impl+test lived together, causing the TC writer to see zero
    # IMPL_SOURCE_FILES and wrongly conclude "source files don't exist".
    impl_src = list(impl_files)
    # Peer impl files come from the story's declared dependencies — stack-agnostic,
    # encoded in the PRD. The previous filename-matching approach (_pair_key) only
    # handled JS/TS infix markers and produced an empty result for Python test_ prefix.
    story_deps = set(s.get('dependencies') or [])
    for peer_id in phase_ids:
        if peer_id == sid:
            continue
        if peer_id not in story_deps:
            continue
        ps = by_id.get(peer_id, {})
        peer_files = _files_for(ps)
        peer_impl_files = [f for f in (peer_files or []) if not _is_test_file(f)]
        impl_src.extend(peer_impl_files)

    impl_src = list(dict.fromkeys(impl_src))  # dedupe, preserve order

    lines.append({
        'storyId': sid,
        'testFile': test_files[0] if test_files else None,
        'implSourceFiles': impl_src,
        'acceptanceCriteria': s.get('acceptanceCriteria', []),
        'verificationCriteria': s.get('verificationCriteria', []),
    })

print(json.dumps(lines, indent=2) if lines else '')
