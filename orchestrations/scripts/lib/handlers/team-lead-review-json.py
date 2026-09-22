#!/usr/bin/env python3
"""
EXTRACT THE TEAM LEAD'S REVIEW OBJECT.

Same contract as code-review-json.py and the same refusal to guess: the caller falls back to
changes_requested with a blocker rather than auto-approving what it could not parse.

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
        # Live AMSD-2041, 2026-07-31: an otherwise complete, valid 10-blocker
        # review was discarded whole because ONE field had a stray quote
        # directly after a number, before the delimiter ("line":130",
        # instead of "line":130,) — a token shape that can never appear in
        # valid JSON, so stripping exactly that pattern before retrying is a
        # narrow, safe repair, not a general lenient-parse hack.
        repaired = re.sub(r'(?<=\d)"(?=\s*[,}])', '', text)
        try:
            result, _ = decoder.raw_decode(repaired, start)
        except (ValueError, json.JSONDecodeError):
            result = None
# THE BRACE THE THINKING BLOCK ATE. MiniMax-M3 closes </think> after it has begun the answer, so
# stripThinkingBlocks takes the answer's opening `{"` with the block and the review arrives as
#     dict":"approved","issues":[...]}
# — intact either side of a tag the model misplaced (raw SSE, logs/stream-captures/, 2026-09-22;
# four reviews across two runs recorded "no parseable verdict" on work that was approved). Repair
# that exact shape: a fragment whose first key is a verdict, re-headed with the brace it lost.
if not isinstance(result, dict) or 'verdict' not in result:
    # What survives is a SUFFIX of the first key: `{"ver` went with the block, leaving `dict":`.
    m = re.match(r'\s*(\w+)"\s*:', text)
    if m and m.group(1) and 'verdict'.endswith(m.group(1)):
        try:
            candidate, _ = json.JSONDecoder().raw_decode('{"verdict' + text[m.end(1):])
            if isinstance(candidate, dict) and 'verdict' in candidate:
                result = candidate
        except (ValueError, json.JSONDecodeError):
            pass

if not isinstance(result, dict) or 'verdict' not in result:
    # No parseable verdict = the review did NOT happen. Never silently approve —
    # that rubber-stamped an unreviewed change live (2026-07-23). Block instead.
    # reviewIncomplete marks this as REVIEWER failure, not a code finding. The
    # orchestration loop keys on it to re-run the REVIEW instead of
    # re-implementing a story nobody actually looked at (live 2026-07-26: a
    # repro-gate-verified fix was re-implemented on the strength of this very
    # verdict). Content-based, because the sibling paths signal the same thing
    # with a flag FILE whose name must match across two scripts — and did not.
    result = {'verdict': 'changes_requested', 'reviewIncomplete': True, 'issues': [{'severity': 'blocker', 'description': 'review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.'}], 'summary': 'review output unparseable'}
print(json.dumps(result))

