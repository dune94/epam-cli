#!/usr/bin/env python3
"""tc-extract-output.py — the ENGINE writes the TC writer's answer, not the agent.

THE AGENT WAS TOLD TO WRITE A FILE AND GIVEN NO TOOL THAT CAN WRITE.

The prompt said "Use WriteFile to write the complete JSON object to that path"; the seam's grant is
`read-only`, twelve tools, none of which write. Live 2026-08-20 the agent said so itself:

    "I cannot write this to .../logs/tc-core.json because no file-writing tool i[s available]"

and the pipeline then reported:

    [tc-writer] Applied TCs to 0 stories: []
    [tc-writer] Gate PASSED — all test stories have verified TCs

It applied nothing and called it success — because the file it read was tc-core.json dated 31 JULY,
holding MOCK-HW-1-test from an unrelated mock run. A stale artefact stood in for this run's output.

GRANTING A WRITE TOOL WOULD BE THE WRONG FIX. The engine already has the better pattern and states
the reason in the skill-assessment prompt: "You do NOT write any file ... hand-rolling scripts to
edit a 136,000-character JSON file is what made every previous attempt run out of iterations." The
agent returns its answer; the engine writes it. The agent stays read-only, and no write path into
orchestrations/logs/ exists at all.

    stdin    the agent's captured output
    argv[1]  where the engine will write the extracted object

EXIT STATUS IS THE CONTRACT. Zero means a valid object was written. Non-zero means nothing was
written and the destination was REMOVED — so a previous run's file can never be read as this run's
answer. Absence must never arrive as success.
"""
import json
import os
import sys


def _extract(text):
    """The first complete JSON object in the answer, or None.

    Deliberately tolerant of what models actually emit — prose before, a fenced block around, a
    sign-off after — and intolerant of anything that is not a parseable object. raw_decode stops at
    the end of the first value, so trailing text is fine.
    """
    decoder = json.JSONDecoder()
    start = 0
    while True:
        i = text.find('{', start)
        if i == -1:
            return None
        try:
            obj, _ = decoder.raw_decode(text, i)
        except ValueError:
            start = i + 1
            continue
        if isinstance(obj, dict):
            return obj
        start = i + 1


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('[tc-extract] usage: <destination> < agent-output\n')
        return 2
    dest = sys.argv[1]
    text = sys.stdin.read()

    obj = _extract(text)
    if obj is None:
        # NOTHING IS WRITTEN AND THE STALE FILE GOES. Leaving it is how July's MOCK-HW-1-test came
        # to be applied as an August run's answer.
        try:
            os.remove(dest)
        except OSError:
            pass
        sys.stderr.write(
            '[tc-extract] the agent returned no JSON object — nothing written, and any previous '
            'file at that path removed so it cannot be read as this run\'s answer\n')
        return 1

    try:
        with open(dest, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, indent=2)
    except OSError as e:
        sys.stderr.write('[tc-extract] could not write %s: %s\n' % (dest, e))
        return 2

    sys.stderr.write('[tc-extract] wrote %d story key(s) to %s\n' % (len(obj), dest))
    return 0


if __name__ == '__main__':
    sys.exit(main())
