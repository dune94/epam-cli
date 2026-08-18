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
    argv[2]  a phase to scope the question to, or absent for the whole PRD
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

# THE PHASE SCOPE is optional. prd-remediate asks the question about ONE phase — whether the
# stories that phase is about to run have been elaborated — while preflight asks it about the
# whole PRD. Two scripts had written two copies of this rule with two different answers; the
# scope is an argument now, and the rule is one.
phase = sys.argv[2] if len(sys.argv) > 2 else ''
stories = prd.get('stories', [])
if phase:
    scoped = set(prd.get('implementationOrder', {}).get(phase, []))
    stories = [s for s in stories if s.get('id') in scoped]

has_splits = any(s.get('specification', {}).get('createdFrom') for s in stories)
print('false' if has_splits else 'true')
