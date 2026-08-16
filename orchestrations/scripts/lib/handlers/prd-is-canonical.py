#!/usr/bin/env python3
"""
HAS THIS PRD BEEN THROUGH A SPEC PASS YET?

A canonical PRD is the pre-elaboration one: no story carries specification.createdFrom, because
nothing has split anything yet. The strict phase and field checks only mean something after
elaboration, so preflight uses this to decide which checks apply.

Lifted out of preflight-check.sh on 2026-08-16, where it was a `python3 -c "..."` string with the
PRD path interpolated into its own source.

Generic: the PRD path is an argument, and the rule holds for any project and any stack.

    argv[1]  the PRD
    stdout   "true" when canonical, "false" when elaborated

An unreadable PRD exits non-zero. The inline copy fell back to "false", which turns ON the strict
checks — the safe direction, but it reported a missing PRD as an elaborated one.
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[prd-is-canonical] usage: <prd.json>\n")
    sys.exit(2)

try:
    with open(sys.argv[1]) as fh:
        prd = json.load(fh)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[prd-is-canonical] cannot read {sys.argv[1]}: {e}\n")
    sys.exit(2)

has_splits = any(s.get('specification', {}).get('createdFrom') for s in prd.get('stories', []))
print('false' if has_splits else 'true')
