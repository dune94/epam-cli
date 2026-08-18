#!/usr/bin/env python3
"""
AVERAGE THE EVIDENCE SCORES FEEDING THE RETRY-EXTENSION DECISION.

Empty input averages to 0, which is the reading that declines to extend: no evidence is not weak
evidence for extending.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   one score per line
    stdout  the mean
"""
import sys
scores = [float(l) for l in sys.stdin if l.strip()]
print(sum(scores)/len(scores) if scores else 0)

