#!/usr/bin/env python3
"""
KEEP ONLY THE MOST RECENT SECTIONS OF THE COORDINATOR PROMPT AMENDMENT.

The amendment grows every retry. This drops the oldest sections once it outgrows its budget,
cutting at '## ' headings so a section is never split — half a piece of guidance reads as whole.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

AND IT SAYS SO. Dropping guidance the writer was previously given, without a word, is the same
fault as every ceiling found on 2026-09-22/23: evidence removed silently, so nobody — including
the agent that needed it — can act on the loss. The trimmed amendment now carries a line naming
how many earlier sections were dropped and where the full prompt was written, so the agent can
read what it lost instead of behaving as though it never existed.

    env EPAM_PROMPT_TRIM_KEEP       how many trailing sections survive (config, never a literal)
    env EPAM_PROMPT_SCRATCHPAD_FILE where the caller wrote the full prompt, named in the note
    stdin   the amendment
    stdout  the trimmed amendment
"""
import os, sys
text = sys.stdin.read()
lines = text.split(chr(10))
# How many recent guidance sections survive: config, not a literal. See lib/prompt-budget.sh.
KEEP = int(os.environ['EPAM_PROMPT_TRIM_KEEP'])
heading_idxs = [i for i, l in enumerate(lines) if l.startswith('## ')]
if not heading_idxs:
    print(text)
    sys.exit(0)
keep_from = heading_idxs[-KEEP] if len(heading_idxs) >= KEEP else heading_idxs[0]
dropped = len([i for i in heading_idxs if i < keep_from])
kept = chr(10).join(lines[keep_from:])
if dropped:
    where = os.environ.get('EPAM_PROMPT_SCRATCHPAD_FILE', '').strip()
    note = ('## Earlier guidance was trimmed from this prompt' + chr(10)
            + str(dropped) + ' earlier guidance section(s) from previous attempts were dropped to keep this '
            'prompt within its budget. They were NOT withdrawn — they still apply, and the full prompt '
            'with every section is written to '
            + (where if where else 'the run\'s kb-scratchpad directory')
            + '. Read it if the guidance below refers to something you cannot see.' + chr(10))
    kept = note + chr(10) + kept
print(kept)

