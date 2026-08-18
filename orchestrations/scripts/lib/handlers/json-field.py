#!/usr/bin/env python3
"""
ONE TOP-LEVEL FIELD OUT OF A JSON DOCUMENT ON STDIN.

Lifted out of preflight-check.sh on 2026-08-16, where it was a one-line `python3 -c` reading
'generatedAt'. The field name is an argument, so this serves every such read rather than one.

    argv[1]  the field name
    stdin    the JSON document
    stdout   the field's value, or nothing when it is absent
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[json-field] usage: <field-name>  (JSON on stdin)\n")
    sys.exit(2)

try:
    _v = json.load(sys.stdin).get(sys.argv[1], '')
    # A LIST IS PRINTED SPACE-SEPARATED. Python's repr of a list is "['a', 'b']", which a shell
    # for-loop reads as ONE token carrying brackets and quotes — the values arrive unusable and the
    # loop silently does nothing.
    if isinstance(_v, list):
        print(' '.join(str(x) for x in _v))
    else:
        print(_v)
except ValueError as e:
    sys.stderr.write(f"[json-field] unparseable JSON on stdin: {e}\n")
    sys.exit(1)
