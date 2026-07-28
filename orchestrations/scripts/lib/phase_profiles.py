#!/usr/bin/env python3
"""phase_profiles.py — hand the pre-phase assessment the profiles it needs.

The assessment is the most expensive call in the pipeline and had never once
completed. mock1 run 10: 2 calls, 25 turns each, 586,478 tokens, $0.2163 — 57% of
the run — and its entire output, three runs running, was:

    Agent reached maximum iterations (25) without completing.

The cause is arithmetic, not prompting:

    profiles.json                       135,901 chars across 53 roles
    DEFAULT_MAX_TOOL_OUTPUT_CHARS         8,192 chars
    one read shows it                         6% of the file
    turns to page through it                 17
    iteration cap                            25

Reading the file once costs 68% of its budget, and narrowing does not rescue it:
the `typescript-engineer` entry alone is 15,495 chars, 1.9x the ceiling.
`truncateToolOutput` keeps `slice(0, limit)` with a marker, and ReadFile accepts
only `path` and `encoding` — no offset, no range — so the read tool cannot page
at all. The agent was asked to reason about what a profile already contains while
being structurally unable to see one.

So the profiles come to it, which is the rule this pipeline already applies to
gates: they are HANDED what the run produced rather than sent to find it.

SCOPE IS THE POINT. Injecting all 53 roles would swap a paging loop for a
136K-char prompt resent on every turn. Only the roles this phase's stories
actually name are sent — typically 2 of 53.

Reports what it could NOT supply, too: roles with no profile (creating them is
step 4 of the agent's task) and stories with no agentRole (assigning them is step
3). An empty section would otherwise be indistinguishable from "nothing to do".
"""

import argparse
import json
import sys


def relevant_profiles(prd, profiles, phase):
    """Return {roles, missing, unassigned} for the stories in one phase."""
    order = (prd.get('implementationOrder') or {}).get(phase) or []
    by_id = {s.get('id'): s for s in (prd.get('stories') or []) if isinstance(s, dict)}

    roles, missing, unassigned = {}, [], []
    for sid in order:
        story = by_id.get(sid)
        if not story:
            # A story id in implementationOrder with no story object is a PRD
            # defect, but it must not take the assessment down with it.
            continue
        role = (story.get('agentRole') or '').strip()
        if not role:
            unassigned.append({
                'id': sid,
                'files': ((story.get('technicalNotes') or {}).get('files') or []),
                'unitTests': bool(story.get('unitTests')),
            })
            continue
        if role in profiles:
            roles[role] = profiles[role]
        elif role not in missing:
            missing.append(role)

    return {'roles': roles, 'missing': sorted(missing), 'unassigned': unassigned}


def as_prompt_block(data):
    """The text injected into the assessment prompt."""
    out = []
    if data['roles']:
        out.append('## Profiles for the roles THIS phase uses')
        out.append('These are the complete current profile strings. They are given to you '
                   'in full — do NOT read the profiles file to obtain them; it is far '
                   'larger than any tool result can return, and reading it is what '
                   'exhausted every previous attempt.')
        for role, text in data['roles'].items():
            out.append('\n### %s\n%s' % (role, text))
    if data['missing']:
        out.append('\n## Roles with NO profile yet (you must create these)')
        for role in data['missing']:
            out.append('- %s' % role)
    if data['unassigned']:
        out.append('\n## Stories with NO agentRole yet (you must assign these)')
        for s in data['unassigned']:
            out.append('- %s — files: %s, unitTests: %s'
                       % (s['id'], ', '.join(s['files']) or '(none)', s['unitTests']))
    return '\n'.join(out)


def _load(path, what):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        # Fail soft and SAY SO: an unreadable input must not abort the phase, but
        # a silently empty injection would send the agent back to the file.
        print('[phase_profiles] could not read %s (%s): %s' % (what, path, e), file=sys.stderr)
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prd', required=True)
    ap.add_argument('--profiles', required=True)
    ap.add_argument('--phase', required=True)
    ap.add_argument('--json', action='store_true', help='emit raw JSON (tests)')
    args = ap.parse_args()

    data = relevant_profiles(_load(args.prd, 'PRD'), _load(args.profiles, 'profiles'), args.phase)
    print(json.dumps(data) if args.json else as_prompt_block(data))


if __name__ == '__main__':
    main()
