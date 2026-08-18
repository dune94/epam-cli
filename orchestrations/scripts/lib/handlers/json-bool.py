#!/usr/bin/env python3
"""
IS THIS JSON FIELD TRUTHY? — as an exit status, for a shell `if`.

    printf '%s' "$json" | json-bool.py stable

Exit 0 when the named field is truthy, 1 when it is falsy, MISSING, or the input is not JSON.

Replaces `python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('stable') else 1)"`
inlined in run-agent-orchestration.sh. That form was invisible to every Python tool in the repo,
could not be tested on its own, and had to be re-read character by character to check the sense of
the comparison — in a branch that decides whether a red suite becomes a tolerated baseline.

Falsy-on-error is deliberate and matches the inline version it replaces: an unreadable result must
not be mistaken for "stable", because the caller writes a baseline and turns a FAILING guard into a
passing one on the strength of it.
"""
import json
import sys

field = sys.argv[1] if len(sys.argv) > 1 else ''
if not field:
    sys.stderr.write('[json-bool] usage: <field-name>, JSON on stdin\n')
    sys.exit(2)

try:
    sys.exit(0 if json.load(sys.stdin).get(field) else 1)
except Exception:
    sys.exit(1)
