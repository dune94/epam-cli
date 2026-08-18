#!/usr/bin/env python3
"""
EXTRACT THE FAILURE ANALYST'S DIAGNOSIS OBJECT.

Tries the whole response as JSON first, then scans for the first BALANCED brace pair — analysts
put braces in their prose, so a first-brace-to-last-brace slice does not survive real output.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   the analyst's raw response
    stdout  the diagnosis object, or nothing when none parsed
"""
import sys, json
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(json.dumps(obj))
    sys.exit(0)
except Exception:
    pass
depth = 0; start = -1
for i, c in enumerate(text):
    if c == '{':
        if depth == 0: start = i
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0 and start >= 0:
            try:
                obj = json.loads(text[start:i+1])
                print(json.dumps(obj))
                sys.exit(0)
            except Exception:
                pass

