#!/usr/bin/env python3
"""
CHECK A PIECE OF STORY TEXT AGAINST THE DECLARED RULES.

The rules are a file, not a literal — which is what lets a project add one without touching the
guard that applies them.

Lifted out of its calling script on 2026-08-16, where it was a quoted heredoc. The program is
byte-for-byte unchanged — it already took its inputs as arguments; it just had no name and no
home of its own. Generic: nothing here is project- or stack-specific.

    argv[1]  the rules file
    argv[2]  the text to check
    stdout   one line per rule the text breaks
"""
import json, re, sys
rules_file, text = sys.argv[1], sys.argv[2]
try:
    with open(rules_file, encoding='utf-8') as f:
        rules = json.load(f)
except Exception:
    sys.exit(0)
for rule in rules:
    pattern = rule.get('textMatchPattern')
    if not pattern:
        continue
    try:
        if re.search(pattern, text):
            print(rule.get('message', rule.get('id', 'anti-pattern match')))
            sys.exit(1)
    except re.error:
        continue
sys.exit(0)
