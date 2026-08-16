#!/usr/bin/env python3
"""
THE REVIEWER'S VERDICT ON A CPA ITERATION ESTIMATE.

UNREVIEWED IS NOT APPROVED. A missing verdict reads as 'fail', which reverts the story to its
pre-CPA values — the estimate it already had. code-review-cycle.sh settled this on 2026-07-23:
"SAFE default = BLOCK, never silently approve an unreviewed change".

Lifted out of contextualize-stories.sh on 2026-08-16, where it was an inline `-c` program. Being a
file, it may use a regex written normally — the inline copy had to escape its own quotes past the
shell.

    stdin   the reviewer's raw response
    stdout  pass or fail
"""
import json
import re
import sys

text = sys.stdin.read()

try:
    print(json.loads(text.strip()).get('verdict', 'fail'))
    sys.exit(0)
except Exception:
    pass

m = re.search(r'"verdict"\s*:\s*"(pass|fail)"', text)
print(m.group(1) if m else 'fail')
