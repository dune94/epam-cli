#!/usr/bin/env python3
"""
READ THE VERDICT OUT OF A PRD-CHANGE REVIEW.

Half of a pair with prd-change-issues.py: the reviewer emits one response and the caller needs two
fields out of it.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   the reviewer's raw response
    stdout  the verdict string
"""
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(obj.get('verdict','fail'))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'"verdict"\s*:\s*"(pass|fail)"', text)
print(m.group(1) if m else 'fail')

