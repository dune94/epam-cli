#!/usr/bin/env python3
"""
EXTRACT THE CODE REVIEWER'S VERDICT OBJECT.

The caller's fallback on an unparseable answer is changes_requested with a blocker — a review that
cannot be read is never an approval.

Lifted out of its calling script on 2026-08-16, where it was an inline `-c` program. Generic:
every input is an argument or stdin, and the rule holds for any project and any stack.

    stdin   the reviewer's raw response
    stdout  the review object
"""
import re, sys, json
text = sys.stdin.read()
start = text.find('{')
result = None
if start != -1:
    decoder = json.JSONDecoder()
    try:
        result, _ = decoder.raw_decode(text, start)
    except (ValueError, json.JSONDecodeError):
        # Same fix as team-lead-review.sh (live AMSD-2041, 2026-07-31): strip
        # a stray quote directly after a number before a delimiter — a token
        # shape that can never appear in valid JSON — then retry once.
        repaired = re.sub(r'(?<=\d)"(?=\s*[,}])', '', text)
        try:
            result, _ = decoder.raw_decode(repaired, start)
        except (ValueError, json.JSONDecodeError):
            result = None
if not isinstance(result, dict) or 'verdict' not in result:
    # SAFE default = BLOCK, never silently approve an unreviewed change (2026-07-23).
    result = {'verdict': 'changes_requested', 'issues': [{'severity': 'blocker', 'description': 'review output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.'}], 'summary': 'review output unparseable'}
print(json.dumps(result))

