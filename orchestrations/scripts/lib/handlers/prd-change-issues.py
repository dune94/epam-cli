#!/usr/bin/env python3
"""
READ THE ISSUE LIST OUT OF A PRD-CHANGE REVIEW.

The other half of the pair with prd-change-verdict.py. Issues are joined with '; ' because the
caller carries them in a single shell variable.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   the reviewer's raw response
    stdout  the issues, semicolon-separated, or nothing
"""
import sys, json
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    issues = obj.get('issues', [])
    if issues: print('; '.join(str(i) for i in issues))
except Exception:
    pass

