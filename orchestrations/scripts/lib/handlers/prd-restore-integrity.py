#!/usr/bin/env python3
"""
IS A FRESHLY RESTORED PRD ACTUALLY CLEAN?

A run restores its PRD from the canonical file. This checks the restore worked: no story carries a
status from a previous run, and no mid-execution split survives. Either means the restore did not
take, and a run started from a dirty PRD reports a prior run's outcomes as this one's.

Lifted out of tier3-skyscanner-app-run.sh and tier3-travel-app-run.sh on 2026-08-16, where BOTH
carried a byte-identical copy as a quoted heredoc. The program is unchanged — it already took its
input as an argument; it just had two homes and no name.

Generic: the PRD path is an argument. Nothing here is project- or stack-specific — the canonical
story set can be any size.

    argv[1]  the restored PRD
    exit 0   clean, with a one-line confirmation on stdout
    exit 1   dirty, with each reason on stderr
"""
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
# After restoring from canonical the PRD holds only its base user stories, every one pending.
# Any mid-execution split from a prior run means the restore did not take.
mid_exec = [s['id'] for s in d['stories']
            if s.get('specification', {}).get('splitOrigin') == 'mid-execution']
dirty = [s['id'] for s in d['stories']
         if s.get('status') not in ('pending', 'deprecated') and s.get('deprecated') is not True]
errors = []
if mid_exec:
    errors.append(f"ABORT: PRD has {len(mid_exec)} mid-execution splits from a prior run — canonical restore failed: {mid_exec}")
if dirty:
    errors.append(f"ABORT: PRD has {len(dirty)} stories with non-pending status: {dirty}")
if errors:
    for e in errors: print(e, file=sys.stderr)
    sys.exit(1)
print(f"  PRD integrity OK: {len(d['stories'])} stories, all pending, zero mid-execution splits")
