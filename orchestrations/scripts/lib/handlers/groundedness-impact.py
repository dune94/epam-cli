#!/usr/bin/env python3
"""
THE SPREAD OF GROUNDEDNESS SCORES IN A RUN.

Reports min, max and mean, so a run whose diagnoses were mostly ungrounded is visible as a
distribution rather than as one average.

Lifted out of its calling script on 2026-08-16, where it was an inline `-c` program. Generic:
every input is an argument or stdin, and the rule holds for any project and any stack.

    stdin   one score per line
    stdout  min, max and avg
"""
import sys
scores = [float(l) for l in sys.stdin if l.strip()]
if scores:
    print(f'  min={min(scores):.2f} max={max(scores):.2f} avg={sum(scores)/len(scores):.2f}')

