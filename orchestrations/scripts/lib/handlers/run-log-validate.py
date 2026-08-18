#!/usr/bin/env python3
"""
IS THIS RUN LOG COMPLETE ENOUGH TO NARRATE?

Checked before the narrative is built, so a truncated or still-being-written log produces a
refusal rather than a narrative with silent holes in it.

Lifted out of its calling script on 2026-08-16, where it was a quoted heredoc. The program is
byte-for-byte unchanged — it already took its inputs as arguments; it just had no name and no
home of its own. Generic: nothing here is project- or stack-specific.

    argv[1]  the run log
    stdout   the validation result the caller reads
"""
import sys, re

path = sys.argv[1]
text = open(path).read()
clean = re.sub(r'\x1b\[[0-9;]*m', '', text)

phase_gos    = len(re.findall(r'Phase gate:\s*GO', clean))
pipe_fails   = len(re.findall(r'aborting pipeline|failed \(exit [^0)]', clean))
last_20      = "\n".join(clean.splitlines()[-20:])
ends_failed  = bool(re.search(r'aborting pipeline|failed \(exit [^0)]', last_20))

if phase_gos == 0:
    print("FAIL:no_phase_gate")
    sys.exit(0)
if ends_failed:
    print("FAIL:pipeline_aborted")
    sys.exit(0)
if pipe_fails > 0:
    print(f"FAIL:has_{pipe_fails}_failures")
    sys.exit(0)
print(f"OK:{phase_gos}")
