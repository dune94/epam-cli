#!/usr/bin/env python3
"""
PARSE THE RETRY-EXTENSION COORDINATOR'S DECISION.

Falls back to a decline rather than failing: an unparseable answer must not extend retries, and
the reason travels with it so the log says why it did not.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   the coordinator's raw response
    stdout  {extend, extraRetries, reason}
"""
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(json.dumps(obj))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'\{[^{}]*"extend"[^{}]*\}', text, re.DOTALL)
if m:
    try:
        print(json.dumps(json.loads(m.group(0))))
        sys.exit(0)
    except Exception:
        pass
print(json.dumps({"extend": False, "extraRetries": 0, "reason": "unparseable"}))

