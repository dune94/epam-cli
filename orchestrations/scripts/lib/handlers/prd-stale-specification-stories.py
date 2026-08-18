#!/usr/bin/env python3
"""
WHICH PENDING STORIES CARRY A SPECIFICATION BLOCK THEY SHOULD NOT?

On a canonical PRD, a base story holding a specification block is contamination from a previous
run. It matters because the spec-mode coordinator reads that field to decide whether to elaborate a
story — stale "completed" data makes it skip re-elaboration, and the split-mandate check inside
that loop with it. This has happened (2026-07-06).

A DEPRECATED story is excluded too: it is not going to be elaborated, so a specification block on
it is not contamination waiting to skip anything. One of the two copies of this rule knew that and
the other did not.

Only PENDING stories count. A story already completed in THIS run legitimately carries the
specification data this run's own spec pass produced.

Lifted out of preflight-check.sh on 2026-08-16, where it was a `python3 -c "..."` string with the
PRD path interpolated into its own source.

Generic: the PRD path is an argument, and the rule holds for any project and any stack.

    argv[1]  the PRD
    stdout   the offending story ids, comma-separated; empty when there are none
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[prd-stale-specification-stories] usage: <prd.json>\n")
    sys.exit(2)

try:
    with open(sys.argv[1]) as fh:
        prd = json.load(fh)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[prd-stale-specification-stories] cannot read {sys.argv[1]}: {e}\n")
    sys.exit(2)

print(','.join(
    s['id'] for s in prd.get('stories', [])
    if s.get('specification') and not s.get('completed') and s.get('status') != 'deprecated'
))
