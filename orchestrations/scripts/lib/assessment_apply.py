#!/usr/bin/env python3
"""assessment_apply.py — the pre-phase assessment decides; this applies.

mock1 runs 10 and 12: the assessment hit its 25-turn cap every time, 300-474K
tokens, ~40% of a run's cost, and never completed. Its plan pass is correct and
specific, so it is not reasoning badly. It is MUTATING a 135,901-char JSON file
with no `write_file` tool — so it hand-rolls python through bash, re-reads to
check, and finds it corrupted its own work:

    "The addendum was duplicated 4 times! This must have been caused by the
     python script being run multiple times or the profile string being
     concatenated incorrectly. Let me fix this by removing the duplicates"

Granting write_file would not rescue it: appending one rule means rewriting the
whole file, which needs the whole file read, which an 8,192-char tool-output
ceiling forbids.

So the agent stops writing. It emits a decision bound by EPAM_RESPONSE_SCHEMA —
enforced at the provider (AgentRunner sets responseFormat with strict:true), not
asked for in prose — and this module applies it deterministically.

Removing the writes is also what BOUNDS THE LOOP, and that is what makes
schema-binding safe. A schema over an agent that still exhausts returns a valid
EMPTY object: a loud failure turned silent. With nothing to write, the work is
read-reason-emit.

Every rule the agent was previously asked to honour in prose is enforced here:

  - a role is assigned ONLY to a story that has none (its step 3 says "for any
    story where agentRole is null or empty")
  - a profile is created ONLY when absent — 53 roles depend on these
  - a rule already present is NEVER appended again, so the duplication that cost
    run 12 its budget is unrepresentable
  - only agentRole is writable on a story, so the PRD field-allowlist check has
    nothing left to catch

Fails CLOSED and LOUD: malformed agent output changes nothing and says so. A
silent no-op would let the step report success having done nothing, which is the
failure mode this pipeline keeps producing.
"""

import argparse
import json
import os
import re
import sys

SCHEMA = {
    'name': 'pre_phase_assessment',
    'schema': {
        'type': 'object',
        'properties': {
            'storyRoleAssignments': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'storyId': {'type': 'string'},
                        'agentRole': {'type': 'string'},
                    },
                    'required': ['storyId', 'agentRole'],
                    'additionalProperties': False,
                },
            },
            'profileAdditions': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'role': {'type': 'string'},
                        'rules': {'type': 'array', 'items': {'type': 'string'}},
                    },
                    'required': ['role', 'rules'],
                    'additionalProperties': False,
                },
            },
            'newProfiles': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'role': {'type': 'string'},
                        'profile': {'type': 'string'},
                    },
                    'required': ['role', 'profile'],
                    'additionalProperties': False,
                },
            },
        },
        'required': ['storyRoleAssignments', 'profileAdditions', 'newProfiles'],
        'additionalProperties': False,
    },
}


def _arr(value):
    """A list, or nothing. The schema constrains the model; this survives the
    case where it did not apply (older provider, malformed env, manual run)."""
    return value if isinstance(value, list) else []


_PATHISH = re.compile(r'\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|cs|php)\b')


def ungrounded_paths(rule, repo_root):
    """File paths a rule cites that do not exist in the repository.

    Live AMSD-2041 run 4: the assessment wrote into sast-sentinel —

        "Only report findings on source files in the authorized list:
         src/cli.ts, src/api.ts, src/utils.ts, src/index.ts. Findings about
         other files are hallucinations and must be suppressed."

    None of the four exist in that repo, so the security gate was told to
    suppress every finding it could make. A fabricated allowlist is worse than
    no allowlist: it reads as authoritative scoping.

    A rule citing NO path is left alone — plenty of legitimate guidance names no
    file. Only a claim about a specific file is checkable, and only a false one
    is rejected.
    """
    if not repo_root:
        return []
    return [p for p in set(_PATHISH.findall(rule or ''))
            if not os.path.isfile(os.path.join(repo_root, p.lstrip('./')))]


def apply_decision(decision, prd, profiles, phase, repo_root=None):
    """Mutate prd/profiles in place. Returns a list of what changed."""
    changes = []
    if not isinstance(decision, dict):
        return changes

    phase_ids = set((prd.get('implementationOrder') or {}).get(phase) or [])
    by_id = {s.get('id'): s for s in (prd.get('stories') or []) if isinstance(s, dict)}

    # ── roles: fill blanks only, and only in this phase ──────────────────────
    for item in _arr(decision.get('storyRoleAssignments')):
        if not isinstance(item, dict):
            continue
        sid, role = item.get('storyId'), (item.get('agentRole') or '').strip()
        if not sid or not role or sid not in phase_ids:
            continue
        story = by_id.get(sid)
        if story is None or (story.get('agentRole') or '').strip():
            continue
        story['agentRole'] = role
        changes.append('assigned %s -> %s' % (sid, role))

    # ── new profiles: create only when absent ────────────────────────────────
    for item in _arr(decision.get('newProfiles')):
        if not isinstance(item, dict):
            continue
        role, text = item.get('role'), item.get('profile')
        if not role or not isinstance(text, str) or not text.strip():
            continue
        if role in profiles:
            continue
        profiles[role] = text.strip()
        changes.append('created profile %s' % role)

    # ── rule additions: append, never duplicate ──────────────────────────────
    for item in _arr(decision.get('profileAdditions')):
        if not isinstance(item, dict):
            continue
        role = item.get('role')
        if not role or role not in profiles or not isinstance(profiles[role], str):
            continue
        added = []
        for rule in _arr(item.get('rules')):
            if not isinstance(rule, str):
                continue
            rule = rule.strip()
            bad = ungrounded_paths(rule, repo_root)
            if bad:
                print('[assessment-apply] REJECTED a rule for %s — it cites file(s) that do '
                      'not exist: %s' % (role, ', '.join(sorted(bad))))
                print('    rule was: %s' % rule[:200])
                continue
            # Substring, not equality: the agent re-states a rule with different
            # surrounding punctuation between attempts, and four copies of the
            # same guidance is what broke run 12.
            if rule and rule not in profiles[role]:
                profiles[role] = profiles[role].rstrip() + '\n' + rule
                added.append(rule)
        if added:
            changes.append('appended %d rule(s) to %s' % (len(added), role))

    return changes


def _read_json(path, what):
    try:
        with open(path) as f:
            return json.load(f), None
    except Exception as e:
        return None, '%s: %s' % (what, e)


def extract_decision(text):
    """The decision object out of an answer that may carry a preamble.

    EPAM_RESPONSE_SCHEMA binds the output at the provider, so this should be
    pure JSON — but the schema is silently skipped when the env var is absent or
    malformed (AgentRunner warns and continues), and the log also captures
    whatever the runner printed. Recovering the object beats failing the phase
    over a wrapper.
    """
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--print-schema', action='store_true')
    ap.add_argument('--result')
    ap.add_argument('--prd')
    ap.add_argument('--profiles')
    ap.add_argument('--phase')
    ap.add_argument('--repo-root', default='')
    args = ap.parse_args()

    if args.print_schema:
        print(json.dumps(SCHEMA))
        return 0

    for required in ('result', 'prd', 'profiles', 'phase'):
        if not getattr(args, required):
            print('[assessment-apply] missing --%s' % required, file=sys.stderr)
            return 2

    try:
        with open(args.result) as f:
            decision = extract_decision(f.read())
        err = None if isinstance(decision, dict) else 'no JSON object in the agent output'
    except Exception as e:
        decision, err = None, 'agent output: %s' % e
    if err:
        # Loud, and nothing written. The step's own capability check decides what
        # to do about it; this must not paper over it by writing a partial state.
        print('[assessment-apply] could not parse the agent decision — NOTHING was '
              'applied (%s)' % err)
        return 1

    prd, err = _read_json(args.prd, 'PRD')
    if err:
        print('[assessment-apply] invalid PRD — nothing applied (%s)' % err)
        return 1
    profiles, err = _read_json(args.profiles, 'profiles')
    if err:
        print('[assessment-apply] invalid profiles — nothing applied (%s)' % err)
        return 1

    changes = apply_decision(decision, prd, profiles, args.phase, args.repo_root)

    if not changes:
        print('[assessment-apply] no decision to apply (0 changes)')
        return 0

    # Written only after every change succeeded, so a failure mid-way leaves both
    # files exactly as they were.
    with open(args.prd, 'w') as f:
        json.dump(prd, f, indent=2)
    with open(args.profiles, 'w') as f:
        json.dump(profiles, f, indent=2)

    print('[assessment-apply] applied %d change(s):' % len(changes))
    for c in changes:
        print('  - %s' % c)
    return 0


if __name__ == '__main__':
    sys.exit(main())
