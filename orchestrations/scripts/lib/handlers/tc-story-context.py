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
    for peer_id in phase_ids:
        if peer_id == sid:
            continue
        ps = by_id.get(peer_id, {})
        peer_files = _files_for(ps)
        # A peer is an impl story sharing a non-test filename base
        test_bases = {_test_base(f) for f in test_files}
        peer_bases = {_pair_key(f.split('/')[-1]) for f in peer_files if not _is_test_file(f)}
        if test_bases & peer_bases:
            impl_src.extend(peer_files)

    impl_src = list(dict.fromkeys(impl_src))  # dedupe, preserve order

    lines.append(f'STORY_ID: {sid}')
    lines.append(f'TEST_FILE: {", ".join(f.split("/")[-1] for f in test_files)}')
    lines.append(f'IMPL_SOURCE_FILES: {", ".join(f for f in impl_src)}')
    lines.append(f'EXISTING_ACS:')
    for ac in s.get('acceptanceCriteria', []):
        lines.append(f'  - {ac}')
    # Verification Criteria (VC) — the observable, mechanism-free checks the change
    # must satisfy. TEST CRITERIA should assert these directly; they are the
    # primary source of test facts (the ACs are the ticket intent).
    vc = s.get('verificationCriteria', [])
    if vc:
        lines.append(f'VERIFICATION_CRITERIA (derive the test facts primarily from these — each should become an assertion):')
        for v in vc:
            lines.append(f'  - {v}')
    lines.append('')

print('\n'.join(lines))
