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

    # THE CONTRACT ALREADY IN FORCE ON A SHARED FILE. regintel 20260919T224649Z: REGI-005b's
    # writer, reading only its own story, fixed classify_event as synchronous while REGI-004b's
    # criteria already held it async; the two contracts then fought for 20 attempts. Every
    # other story's testCriteria that names one of this story's source files is briefed here,
    # with the interfaces this story (or its impl dependency) declared it consumes. A machine
    # fact for the writer to honour; the prompt says how.
    def _norm(f):
        return (f or '').lstrip('./')
    def _same(a, b):
        a, b = _norm(a), _norm(b)
        return a == b or a.endswith('/' + b) or b.endswith('/' + a)
    shared = []
    for src_file in impl_src:
        for other_id, other in by_id.items():
            if other_id == sid or other.get('status') == 'deprecated':
                continue
            otc = other.get('testCriteria') or {}
            facts = otc.get('facts') or []
            if not facts:
                continue
            names = list(otc.get('sourceFiles') or []) + list(_files_for(other))
            if any(_same(n, src_file) for n in names):
                shared.append({'storyId': other_id, 'file': src_file, 'facts': facts})
    consumes = list(s.get('consumesInterfaces') or [])
    for dep_id in story_deps:
        for c in (by_id.get(dep_id, {}).get('consumesInterfaces') or []):
            if c not in consumes:
                consumes.append(c)

    lines.append({
        'storyId': sid,
        'testFile': test_files[0] if test_files else None,
        'implSourceFiles': impl_src,
        'acceptanceCriteria': s.get('acceptanceCriteria', []),
        'verificationCriteria': s.get('verificationCriteria', []),
        'existingCriteriaOnSharedFiles': shared,
        'consumesInterfaces': consumes,
    })

print(json.dumps(lines, indent=2) if lines else '')
