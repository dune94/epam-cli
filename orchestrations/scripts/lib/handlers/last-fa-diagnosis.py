#!/usr/bin/env python3
"""
THE MOST RECENT ACTIONABLE FAILURE-ANALYST DIAGNOSIS FOR A STORY.

Ignores entries whose target is 'none' or empty: a diagnosis that names nothing to change cannot
be handed to a writer as direction.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    argv[1]  the healing log
    argv[2]  the story id
    stdout   the diagnosis, or empty when none is actionable
"""
import json, sys
story = sys.argv[2]
last = ''
try:
    for line in open(sys.argv[1]):
        try:
            e = json.loads(line)
            if e.get('story_id') == story and e.get('diagnosis') and e.get('target') not in ('none', ''):
                last = e['diagnosis']
        except Exception:
            pass
except Exception:
    pass
print(last)

