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
PLACEHOLDER_EVIDENCE = {'', 'n/a', 'na', 'none', 'null', '-', 'tbd', 'unknown'}


def _is_grounded(issue):
    """Did the reviewer say what it READ to justify this?

    An issue with no evidence is an assertion, and the pipeline used to act on assertions. Live
    metrolinx AMSD-2041: the reviewer twice claimed the Contentstack SDK "will not recognize"
    management_token. The installed index.d.ts declares exactly that key and contains zero
    occurrences of preview_token — the code was right, the review was wrong, and the writer spent
    attempts defending correct code. On an earlier draw the same seam checked the types unprompted
    and got it right. Nothing required it, so correctness was luck.

    Deliberately shallow: this asks whether the reviewer POINTED AT something, not whether the
    pointer is correct. Verifying the claim is the reviewer's job; refusing an unsupported one is
    this file's.
    """
    if not isinstance(issue, dict):
        return False
    ev = issue.get('evidence')
    if not isinstance(ev, str):
        return False
    return ev.strip().lower() not in PLACEHOLDER_EVIDENCE


if isinstance(result, dict) and isinstance(result.get('issues'), list):
    kept, dropped = [], []
    for _i in result['issues']:
        (kept if _is_grounded(_i) else dropped).append(_i)
    if dropped:
        # SAID OUT LOUD. Changing a verdict silently is the failure this file exists to prevent,
        # and dropping the findings that produced it is a change of verdict.
        sys.stderr.write(
            '[code-review] dropped %d issue(s) with no evidence — an unevidenced claim is not a '
            'finding: %s\n' % (
                len(dropped),
                '; '.join(str((d or {}).get('description', ''))[:80] for d in dropped)))
    result['issues'] = kept
    # A rejection whose every finding was discarded is not a rejection. Leaving it would block a
    # story on claims the pipeline itself refused to accept.
    if not kept and result.get('verdict') == 'changes_requested':
        sys.stderr.write('[code-review] no evidenced finding remains — the rejection does not stand\n')
        result['verdict'] = 'approved'

if not isinstance(result, dict) or 'verdict' not in result:
    # SAFE default = BLOCK, never silently approve an unreviewed change (2026-07-23).
    result = {'verdict': 'changes_requested', 'issues': [{'severity': 'blocker', 'description': 'review output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.'}], 'summary': 'review output unparseable'}
print(json.dumps(result))

