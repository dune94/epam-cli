#!/usr/bin/env python3
"""
COUNT THE HEALING EVENTS RECORDED FOR ONE STORY.

The ladder uses this to decide whether self-healing is confirmed broken: at least one healing
event for the story, yet the story is still failing. That is the signal for forcing a HIGH-tier
escalation for model diversity, so the count has to be right.

Lifted out of claude.sh on 2026-08-16, where the SAME program appeared twice — once for Rung 2 and
once for Rung 3 — each as a `python3 -c "..."` string interpolating the log directory and the story
id into its own source. Two copies of one rule is one copy too many: a fix to either was a fix to
half the ladder. Both call sites now run this file.

Generic: both inputs are arguments, and the rule holds for any project and any stack.

    argv[1]  path to healing-events.jsonl
    argv[2]  the story id to count events for
    stdout   the count, as a bare integer

A missing log means zero events, not an error — the file does not exist until something heals. A
malformed LINE is skipped: the log is appended to by concurrent stages and one torn write must not
be read as "nothing ever healed", which is the reading that suppresses the escalation.
"""
import json
import sys

if len(sys.argv) < 3:
    sys.stderr.write("[healing-event-count] usage: <healing-events.jsonl> <story-id>\n")
    sys.exit(1)

log_path, story_id = sys.argv[1], sys.argv[2]

count = 0
try:
    fh = open(log_path)
except OSError:
    print(0)
    sys.exit(0)

with fh:
    for line in fh:
        try:
            if json.loads(line).get('story_id') == story_id:
                count += 1
        except Exception:
            pass

print(count)
