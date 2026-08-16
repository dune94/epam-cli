#!/usr/bin/env python3
"""
THE RECORDED STATUS OF ONE STORY IN A PRD.

Lifted out of five launchers on 2026-08-16 — tier1-mock-run.sh, tier1-ollama-run.sh,
tier2-free-run.sh, tier3-paid-run.sh and tier3-metrolinx-run.sh each carried its own copy of this
program as a `python3 -c "..."` string with the PRD path and the story id interpolated into its own
source. Five copies of one rule is four too many: every launcher decides pass or fail from this
answer, so a fix to one copy left the other four deciding by the old rule.

Generic: both inputs are arguments, and the rule holds for any project and any stack.

    argv[1]  the PRD
    argv[2]  the story id
    stdout   the story's status, or "not_found"

An UNREADABLE PRD is fatal and says so. The inline copies ran under `2>/dev/null`, so a missing or
malformed PRD printed nothing and every story read as failed — a pipeline-wide failure reported as
a story-by-story one.
"""
import json
import sys

if len(sys.argv) < 3:
    sys.stderr.write("[story-status] usage: <prd.json> <story-id>\n")
    sys.exit(1)

prd_path, story_id = sys.argv[1], sys.argv[2]

try:
    with open(prd_path) as fh:
        prd = json.load(fh)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[story-status] cannot read {prd_path}: {e}\n")
    sys.exit(1)

for story in prd.get('stories', []):
    if story.get('id') == story_id:
        print(story.get('status', 'unknown'))
        sys.exit(0)

print('not_found')
