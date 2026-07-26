#!/usr/bin/env python3
"""story_oracle.py — hand a gate the criteria the story is actually judged against.

Live metrolinx 2026-07-26, run 8. The spec validator returned:

    {"stories":[{"storyId":"AMSD-1820","criteria":[],"overallCompliance":100,
                 "verdict":"pass"}],"overallVerdict":"pass"}

It had evaluated nothing and reported full compliance — and it was right to. Its
prompt says "use the pre-injected acceptanceCriteria", and the oracle that builds
that section read `acceptanceCriteria` alone. Brownfield stories carry
`verificationCriteria`: observable statements a test can be written against,
introduced precisely because bare ACs were too vague to verify. AMSD-1820 ended
the run with three VCs and zero ACs, so the oracle emitted "Acceptance criteria
(0):" and the agent honestly classified an empty list.

The criteria moved and the oracle did not follow. That is the whole defect: a
gate silently validating against a field its flow no longer populates, and
producing a 100% score over the empty set.

So the oracle asks what this story is judged against rather than assuming, and
LABELS what it found — an agent told "Verification criteria (3)" is being told
the truth, where "Acceptance criteria (0)" was an invitation to pass.
"""

import json

# Ordered by specificity: verification criteria are observable and testable, so
# they win when a story carries both. Adding a criteria field to the PRD means
# adding it here — deliberately explicit, so a new field cannot silently become
# invisible to every gate the way this one did.
CRITERIA_FIELDS = (
    ('verificationCriteria', 'Verification criteria'),
    ('acceptanceCriteria', 'Acceptance criteria'),
)


def criteria_of(story):
    """(label, [text, ...]) — what this story is actually judged against."""
    for field, label in CRITERIA_FIELDS:
        raw = story.get(field) or []
        items = []
        for c in raw:
            # Criteria are plain strings in some flows and {text, status} in others.
            text = c.get('text', '') if isinstance(c, dict) else str(c)
            if text.strip():
                items.append(text.strip())
        if items:
            return label, items
    return 'Criteria', []


def build(prd_path, phase_id):
    try:
        with open(prd_path) as f:
            prd = json.load(f)
    except Exception as e:
        return '(story oracle error: {})'.format(e)

    phase_ids = prd.get('implementationOrder', {}).get(phase_id, [])
    story_map = {s['id']: s for s in prd.get('stories', []) if 'id' in s}

    lines = ["Stories in phase '{}': {}".format(phase_id, len(phase_ids))]
    for sid in phase_ids:
        s = story_map.get(sid)
        if not s:
            continue
        lines.append('\n### {}: {} [status={}, completed={}]'.format(
            sid, s.get('title', '?'), s.get('status', '?'), s.get('completed', False)))
        lines.append('AgentRole: {}'.format(s.get('agentRole', '?')))

        tn = s.get('technicalNotes')
        files = tn.get('files', []) if isinstance(tn, dict) else []
        if files:
            lines.append('Expected files: {}'.format(', '.join(files)))

        label, items = criteria_of(s)
        lines.append('{} ({}):'.format(label, len(items)))
        for i, text in enumerate(items, 1):
            lines.append('  {}. {}'.format(i, text))
        if not items:
            # Never let an empty list read as "nothing to check, therefore fine".
            lines.append('  (none recorded — you cannot report compliance against '
                         'an empty set; say so rather than passing)')
    return '\n'.join(lines)


if __name__ == '__main__':
    import sys
    print(build(sys.argv[1], sys.argv[2]))
