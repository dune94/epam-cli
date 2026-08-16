#!/usr/bin/env python3
"""
THE STORY IDS IN IMPLEMENTATION ORDER, EACH ONCE.

A PRD's implementationOrder groups story ids by phase. A story that appears in more than one phase
is emitted at its FIRST position, so the caller iterating this list visits each story once, in the
order the plan intends.

Lifted out of tier3-metrolinx-run.sh on 2026-08-16, where it was a `python3 -c "..."` string with
the PRD path interpolated into its own source.

Generic: the PRD path is an argument, and the rule holds for any project and any stack.

    argv[1]  the PRD
    stdout   one story id per line, in order, deduplicated

An unreadable PRD is fatal. The inline copy ran under `2>/dev/null` feeding a `while read` loop, so
a malformed PRD produced an empty list and the loop reported that every story had been checked.
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[story-implementation-order] usage: <prd.json>\n")
    sys.exit(1)

try:
    with open(sys.argv[1]) as fh:
        prd = json.load(fh)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[story-implementation-order] cannot read {sys.argv[1]}: {e}\n")
    sys.exit(1)

seen = set()
for ids in prd.get('implementationOrder', {}).values():
    for story_id in ids:
        if story_id not in seen:
            print(story_id)
            seen.add(story_id)
