#!/usr/bin/env python3
"""
EXTRACT THE PLAN REVIEW OBJECT FROM A REVIEWER RESPONSE.

A reviewer answers in prose with a JSON object somewhere inside it. This finds the first object
and returns it ONLY if it carries a verdict — a JSON blob quoted as an example is not a review.

Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
holds for any project and any stack.

    stdin   the reviewer's raw response
    stdout  the review object, or empty when the response carried no verdict
"""
import sys, json
text = sys.stdin.read()
start = text.find('{')
result = None
if start != -1:
    decoder = json.JSONDecoder()
    try:
        result, _ = decoder.raw_decode(text, start)
    except (ValueError, json.JSONDecodeError):
        result = None
print(json.dumps(result) if isinstance(result, dict) and 'verdict' in result else '')

