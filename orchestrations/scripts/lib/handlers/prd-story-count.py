#!/usr/bin/env python3
"""
HOW MANY STORIES A PRD HOLDS.

Lifted out of preflight-check.sh on 2026-08-16, where it was a one-line `python3 -c "..."` with the
PRD path interpolated into its own source.

    argv[1]  the PRD
    stdout   the count
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[prd-story-count] usage: <prd.json>\n")
    sys.exit(2)

try:
    with open(sys.argv[1]) as fh:
        print(len(json.load(fh)['stories']))
except (OSError, ValueError, KeyError) as e:
    sys.stderr.write(f"[prd-story-count] cannot read {sys.argv[1]}: {e}\n")
    sys.exit(2)
