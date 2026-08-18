#!/usr/bin/env python3
"""
TOTAL THE COST RECORDED FOR A PHASE.

Reads the phase-cost JSONL a run appends to and prints the total and the entry count.

Lifted out of run-agent-orchestration.sh on 2026-08-16, where it was a `python3 -c "..."` string
that interpolated the log directory into a path INSIDE its own source — so the program's text
changed with the value, and a directory containing a quote was a syntax error.

It also had to escape its own dollar sign (`\\${total:.4f}`) to stop the shell expanding the
format spec, which is a hazard that simply does not exist once the program is a file.

Generic: the log path is an argument, and the rule holds for any project.

    argv[1]  path to phase-cost.jsonl
    stdout   "Total cost: $N.NNNN" and "Entries: N"

A malformed line is skipped rather than fatal — a cost log is appended to by many stages and one
truncated write should not hide the total. A MISSING file is different, and says so.
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[phase-cost-total] usage: <phase-cost.jsonl>\n")
    sys.exit(1)

path = sys.argv[1]
try:
    fh = open(path)
except OSError as e:
    # Loud. The inline version ran under `2>/dev/null || echo "(cost data unavailable)"`, so a
    # missing file and an empty one produced the same message.
    sys.stderr.write(f"[phase-cost-total] cannot read {path}: {e}\n")
    sys.exit(1)

total = 0.0
entries = []
with fh:
    for line in fh:
        try:
            e = json.loads(line)
            total += float(e.get('actual_cost_usd', 0) or 0)
            entries.append(e)
        except Exception:
            pass

print(f'Total cost: ${total:.4f}')
print(f'Entries: {len(entries)}')
