#!/usr/bin/env python3
"""gate_verdict_schema.py — is a QA gate's answer actually an answer?

A gate's output was accepted on this test alone:

    grep -qE '"(verdict|findings|agent|summary)"' "$log"

Any text containing the word "verdict" passes. Nothing checked that the JSON
parses, that the verdict holds a legal value, or that the required fields are
present — so a truncated report, a fragment of reasoning that happens to quote
the word, or a verdict of "maybe" all read as a completed review.

This validates the parsed object instead, AFTER the call. Deliberately not a
provider-level strict json_schema: these gates need tools to read source, and
strict schema mode suppresses tool calling (SCHEMA-1 in the backlog). Validating
afterwards keeps the tools and still refuses a malformed answer — and the reason
is fed back into the retry, so attempt 2 is told what was wrong rather than
merely being handed a bigger model.

`not_applicable` is a first-class verdict. A gate with nothing meaningful to say
about a change must be able to say so: silence is indistinguishable from
failure, and a fabricated "pass" is worse than both.

Usage:  gate_verdict_schema.py <gate-name> <log-file>
Exit:   0 valid · 1 invalid (reason on stdout) · 2 usage error
"""

import json
import re
import sys

VALID_VERDICTS = {'pass', 'fail', 'warn', 'not_applicable'}

# Gates whose findings must carry a severity to be actionable.
_SEVERITIES = {'blocker', 'major', 'minor', 'info'}


def extract_json(text):
    """Find the verdict object in a possibly chatty response."""
    decoder = json.JSONDecoder()
    best = None
    idx = 0
    while True:
        start = text.find('{', idx)
        if start == -1:
            break
        try:
            obj, end = decoder.raw_decode(text, start)
            if isinstance(obj, dict) and ('verdict' in obj or 'findings' in obj):
                # Prefer the richest object — a gate may emit several.
                if best is None or len(obj) > len(best):
                    best = obj
            idx = end
        except json.JSONDecodeError:
            idx = start + 1
    return best


def validate(gate, text):
    """(ok, reason). reason is written for the model that must fix it."""
    if not text or not text.strip():
        return False, ('produced no output at all. Emit your JSON verdict as plain text in your '
                       'reply — do not write it to a file.')

    if 'has been written' in text and len(text.strip()) < 200:
        return False, ('answered by calling a write tool. The pipeline reads your REPLY, not files. '
                       'Emit the JSON verdict directly in your message.')

    obj = extract_json(text)
    if obj is None:
        return False, ('contained no JSON object with a "verdict" field. Emit exactly: '
                       '{"agent":"%s","verdict":"pass|fail|warn|not_applicable","summary":"...",'
                       '"findings":[]}' % gate)

    verdict = obj.get('verdict')
    if verdict is None:
        return False, 'emitted a JSON object with no "verdict" field.'
    if not isinstance(verdict, str) or verdict.strip().lower() not in VALID_VERDICTS:
        return False, ('used verdict %r, which is not one of: %s.'
                       % (verdict, ', '.join(sorted(VALID_VERDICTS))))

    if not str(obj.get('summary') or '').strip():
        return False, ('gave a verdict with no "summary". State in one sentence what you checked '
                       'and what you concluded.')

    findings = obj.get('findings')
    if findings is not None:
        if not isinstance(findings, list):
            return False, '"findings" must be a list.'
        for i, f in enumerate(findings):
            if not isinstance(f, dict):
                return False, 'finding %d is not an object.' % i
            sev = str(f.get('severity') or '').lower()
            if sev and sev not in _SEVERITIES:
                return False, ('finding %d has severity %r; use one of: %s.'
                               % (i, f.get('severity'), ', '.join(sorted(_SEVERITIES))))
            if not str(f.get('description') or f.get('message') or '').strip():
                return False, 'finding %d has no description — an unexplained finding is unactionable.' % i

    # A blocking verdict with no findings is self-contradictory: it blocks the
    # run while saying nothing about what to fix.
    if verdict.strip().lower() == 'fail' and not findings:
        return False, 'returned "fail" with no findings. Say what is wrong, or use "pass"/"warn".'

    return True, ''


def main(argv):
    if len(argv) < 3:
        print('usage: gate_verdict_schema.py <gate-name> <log-file>', file=sys.stderr)
        return 2
    gate = argv[1]
    try:
        with open(argv[2], errors='replace') as f:
            text = f.read()
    except OSError:
        text = ''
    ok, reason = validate(gate, text)
    if ok:
        return 0
    print(reason)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
