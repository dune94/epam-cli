#!/usr/bin/env python3
"""tc-story-is-pure-test.py — is this story a PURE test story that still has no criteria?

THE CONVENTION IS SHARED; THE POLICY IS NOT.

lib/tc-writer-gate.sh asked `($f | map(endswith(".test.ts")) | all)` inline. The `.test.ts` half
is a fact about the codeline and was wrong everywhere else: on .spec.ts, test_*.py, __tests__/ or
_test.go the predicate is false for every story, so the gate returned 0 and reported that all test
stories already had criteria, having examined none. That is the same defect already fixed in three
other places.

The `all` half is NOT a defect and must survive. This gate runs BEFORE execution, and requiring
every file to be a test file is what keeps a combo story (implementation + tests in one story)
from being force-gated — the SKY-004 finding. tc-stories-needing-criteria.py deliberately uses
`any(...) or has_vcs` because it answers a different question, after execution, for the batch gate.
Swapping one for the other silently changes the contract; keeping the convention in _testfile.py
and the policy here keeps one definition of each.

    argv[1]  PRD file
    argv[2]  story id

Exit 0  the story is a pure test story with no testCriteria.facts yet — it needs the TC writer.
Exit 1  it does not (ordinary source files, mixed files, deprecated, or criteria already present).
Exit 2  the question could not be answered — never to be read as either verdict.
"""
import json
import sys

from _testfile import is_test_file as _is_test_file


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('[tc-pure-test] usage: <prd> <story-id>\n')
        return 2
    prd_path, story_id = sys.argv[1], sys.argv[2]

    try:
        with open(prd_path, encoding='utf-8') as fh:
            prd = json.load(fh)
    except (OSError, ValueError) as e:
        # UNREADABLE IS NOT "NO". A gate that cannot read the PRD must not answer "nothing to do".
        sys.stderr.write('[tc-pure-test] cannot read %s: %s\n' % (prd_path, e))
        return 2

    story = next((s for s in (prd.get('stories') or []) if s.get('id') == story_id), None)
    if story is None:
        return 1

    if story.get('status') == 'deprecated':
        return 1

    files = (story.get('technicalNotes') or {}).get('files') or []
    if not files:
        return 1

    # ALL, not any — see the module docstring. A combo story is not gated here.
    if not all(_is_test_file(f) for f in files):
        return 1

    if (story.get('testCriteria') or {}).get('facts'):
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
