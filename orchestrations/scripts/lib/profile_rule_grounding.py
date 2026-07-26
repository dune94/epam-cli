#!/usr/bin/env python3
"""profile_rule_grounding.py — is a proposed agent-profile rule true of THIS repo?

Live metrolinx 2026-07-26. mutant-hunter scored 0 (it had been shown no tests,
because of a manifest bug), gate remediation treated that as a real finding, and
profile-augmentor appended a rule to typescript-engineer containing:

    test_file="${file%.ts}.test.ts"; [ -f "$test_file" ] && ...

Every test in that repository is named `.spec.ts`. The remediation encoded, as
permanent guidance, the exact naming assumption that had blinded mutant-hunter
in the first place. And it WAS reviewed — the run logged "(reviewer approved)".

The reviewer could not have caught it. It receives the last 500 characters of
profiles.json before and after, with no tools and no access to the repo under
work, and is asked for a verdict. `.test.ts` is entirely plausible in isolation;
it is false only against a codebase the reviewer cannot see. Asking a model to
judge plausibility harder does not fix that — checking the claim does.

So: a rule that asserts a FILE CONVENTION is making a verifiable claim. Either
files matching it exist in the repo, or they do not. This extracts those claims
from the text the change ADDED and tests each one.

Deliberately narrow. It judges only file-convention claims, only in added text,
and only when the repo has source to contradict them. Everything else passes —
this is a guard against encoding a falsehood, not a general rule reviewer, and
it must never become a new way for remediation to die.

Usage:  profile_rule_grounding.py <profiles_before.json> <profiles_after.json> <repo_root>
Exit:   0 = grounded (allow)   1 = unfounded claim (reject)
"""

import json
import os
import re
import sys

# `.spec.ts`, `.test.tsx`, `_test.go` — a suffix convention naming a file KIND.
_SUFFIX_CLAIM = re.compile(r'[.*_/]((?:spec|test)\.[A-Za-z0-9]{1,5})\b')
# `__tests__/`, `tests/` style directory conventions.
_DIR_CLAIM = re.compile(r'\b(__tests__|__specs__)/')

_SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'coverage', '.codegraph', '.epam'}


def load_profiles(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def added_text(before, after):
    """Only what this change contributed — pre-existing wording is not ours to judge."""
    chunks = []
    for key, new_val in (after or {}).items():
        if not isinstance(new_val, str):
            continue
        old_val = (before or {}).get(key)
        if not isinstance(old_val, str):
            chunks.append(new_val)
        elif new_val != old_val and new_val.startswith(old_val):
            chunks.append(new_val[len(old_val):])
        elif new_val != old_val:
            # Rewritten rather than appended: judge only lines that are new.
            old_lines = set(old_val.splitlines())
            chunks.append('\n'.join(l for l in new_val.splitlines() if l not in old_lines))
    return '\n'.join(chunks)


def walk_files(repo):
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            yield os.path.join(root, f)


def main(argv):
    if len(argv) < 4:
        print('usage: profile_rule_grounding.py <before.json> <after.json> <repo_root>',
              file=sys.stderr)
        return 0  # fail open: this guard must never block on its own misuse

    before = load_profiles(argv[1])
    after = load_profiles(argv[2])
    repo = argv[3]
    if after is None or not repo or not os.path.isdir(repo):
        return 0  # fail open — see module docstring

    text = added_text(before, after)
    if not text.strip():
        return 0

    suffix_claims = {m.group(1) for m in _SUFFIX_CLAIM.finditer(text)}
    dir_claims = {m.group(1) for m in _DIR_CLAIM.finditer(text)}
    if not suffix_claims and not dir_claims:
        return 0

    all_files = list(walk_files(repo))
    if not all_files:
        return 0  # greenfield: nothing yet to contradict the claim

    unfounded = []
    for claim in sorted(suffix_claims):
        if not any(p.endswith('.' + claim) or p.endswith('_' + claim) for p in all_files):
            unfounded.append('.' + claim)
    for claim in sorted(dir_claims):
        if not any(('/' + claim + '/') in p for p in all_files):
            unfounded.append(claim + '/')

    if unfounded:
        print('profile_rule_grounding: REJECT — the proposed rule asserts file '
              'convention(s) this repository does not use: %s' % ', '.join(unfounded),
              file=sys.stderr)
        print('profile_rule_grounding: writing it would encode a falsehood as permanent '
              'agent guidance (live 2026-07-26: a .test.ts rule was approved for a '
              '.spec.ts codebase, from a finding that was itself an artefact).',
              file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
