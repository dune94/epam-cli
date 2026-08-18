#!/usr/bin/env python3
"""
KEEP ONLY THE MOST RECENT SECTIONS OF THE COORDINATOR PROMPT AMENDMENT.

The amendment grows every retry. This drops the oldest sections once it outgrows its budget,
cutting at '## ' headings so a section is never split — half a piece of guidance reads as whole.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    env EPAM_PROMPT_TRIM_KEEP   how many trailing sections survive (config, never a literal)
    stdin   the amendment
    stdout  the trimmed amendment
"""
import os, sys
text = sys.stdin.read()
lines = text.split(chr(10))
# How many recent guidance sections survive: config, not a literal. See lib/prompt-budget.sh.
KEEP = int(os.environ['EPAM_PROMPT_TRIM_KEEP'])
heading_idxs = [i for i, l in enumerate(lines) if l.startswith('## ')]
keep_from = heading_idxs[-KEEP] if len(heading_idxs) >= KEEP else (heading_idxs[0] if heading_idxs else 0)
print(chr(10).join(lines[keep_from:]) if heading_idxs else text)

