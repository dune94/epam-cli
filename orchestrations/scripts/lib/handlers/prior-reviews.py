#!/usr/bin/env python3
"""prior-reviews.py — what this reviewer already said about this story.

THE ONLY REVIEWER THE PIPELINE RUNS HAD NO MEMORY.

team-lead-review.sh is executed once per review cycle (run-agent-orchestration.sh:8045, its single
call site). Its prompt carried the story, the diff, the criteria and several context blocks — and
no prior verdict and no iteration number. So each cycle reviewed as if for the first time.

Live metrolinx AMSD-2041, run 2, 2026-08-20:

    Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED
    Step 3.6: the verdict changed and the code did not — the blocker was never resolved.

It did not change its mind. It never knew. Consistency was impossible by construction, and the
guard that noticed called an escalation function that does not exist.

The record was already there and already append-only: code-reviews.jsonl, written with `>>`. This
reads it back for one story.

    argv[1]  the review log (JSONL)
    argv[2]  the story id
    stdout   a block for the prompt, or NOTHING when there is no prior review

ABSENT IS ABSENT: no prior review prints nothing, so the caller renders no section rather than an
empty heading that reads as "there was nothing to say".

A malformed line is skipped, never fatal. Losing the whole history because one record was truncated
would reproduce the amnesia this exists to fix.
"""
import json
import sys


def _issues(rec):
    out = []
    for i in rec.get('issues') or []:
        if not isinstance(i, dict):
            continue
        sev = str(i.get('severity', '') or '?')
        desc = str(i.get('description', '') or '').strip()
        if not desc:
            continue
        out.append((sev, desc))
    return out


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('[prior-reviews] usage: <review-log.jsonl> <story-id>\n')
        return 2
    path, story = sys.argv[1], sys.argv[2]

    records = []
    malformed = 0
    parsed = 0
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    # ONE bad line must not cost the history. ALL of them is a broken log,
                    # not an absence of history — and reporting that as "no previous reviews"
                    # is what let the reviewer approve code carrying its own prior findings
                    # (live 2026-08-21). Counted, and refused below if nothing parsed at all.
                    malformed += 1
                    continue
                parsed += 1
                if isinstance(rec, dict) and str(rec.get('story', '')) == story:
                    records.append(rec)
    except OSError:
        return 0                                  # no log yet — nothing to say

    # A log that exists but yielded NOT ONE parseable record is a defect in the producer,
    # never evidence that this is the first review. Say so, loudly, and fail.
    if malformed and not parsed:
        sys.stderr.write(
            '[prior-reviews] %s: %d line(s), none parseable as JSON — the review log is not '
            'JSONL. The reviewer would silently lose its own history.\n' % (path, malformed))
        return 1

    if not records:
        return 0

    lines = ['## YOUR PREVIOUS REVIEWS OF THIS STORY', '']
    for n, rec in enumerate(records, start=1):
        verdict = str(rec.get('verdict', '?'))
        lines.append('Iteration %d — you returned: %s' % (n, verdict))
        for sev, desc in _issues(rec):
            lines.append('  - [%s] %s' % (sev, desc))
        lines.append('')

    sys.stdout.write('\n'.join(lines))
    return 0


if __name__ == '__main__':
    sys.exit(main())
