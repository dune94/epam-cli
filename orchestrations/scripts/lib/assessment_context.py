#!/usr/bin/env python3
"""assessment_context.py — hand the pre-phase assessment the facts it needs.

Live AMSD-2041 run 4: turns=1, in=3,366, out=516. The prompt alone is ~2,100
tokens, so the assessment never read the PRD, never ran find, never touched the
repository. It answered from its own instructions and invented story IDs
(core-1..core-6 for a phase containing exactly AMSD-2041) and an "authorized"
file list (src/cli.ts, src/api.ts, src/utils.ts, src/index.ts — none of which
exist in that repo), then told sast-sentinel to suppress everything else.

That was caused by fixing its previous failure: it used to burn 25 turns
hand-writing files, and making it RETURN a decision removed the only thing that
forced it to look at anything.

Removing the prompt's worked examples took away what it fabricated WITH. This
takes away the need to fabricate: the script computes what it already knows —
the real stories in this phase, the real files and whether they exist, and the
project's own manifest facts — and hands them over. Same move as
phase_profiles.py, same reason.

DELIBERATELY NOT A REPO DUMP. Injecting every file would trade fabrication for a
prompt that grows with the codebase, which is the mistake made once already.
Only the stories in this phase and the files they name are included.

Nothing here knows any stack: the test runner, module system and scripts are READ
from the project's own package.json, never assumed.
"""

import argparse
import json
import os
import sys


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def project_facts(repo_root):
    """What the project says about itself. Read, never assumed."""
    pkg = _load(os.path.join(repo_root, 'package.json'))
    if not pkg:
        return []

    deps = {}
    deps.update(pkg.get('dependencies') or {})
    deps.update(pkg.get('devDependencies') or {})

    facts = []
    if pkg.get('name'):
        facts.append('project name: %s' % pkg['name'])
    # The test runner is whatever the project depends on — do not guess a name.
    runners = [d for d in deps if d in ('vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine')]
    if runners:
        facts.append('test runner: %s' % ', '.join('%s@%s' % (r, deps[r]) for r in runners))
    if (pkg.get('scripts') or {}).get('test'):
        facts.append('test script: %s' % pkg['scripts']['test'])
    facts.append('module system: %s' % ('ESM ("type": "module")' if pkg.get('type') == 'module'
                                        else 'CommonJS (no "type": "module")'))
    # Frameworks are just the top-level dependencies; naming any specific one
    # here would be exactly the hard-coding this file exists to remove.
    if deps:
        top = sorted(deps)[:12]
        facts.append('declared dependencies (first %d): %s' % (len(top), ', '.join(top)))
    return facts


def phase_stories(prd, repo_root, phase):
    """The real stories in this phase, with the real state of their files."""
    order = (prd.get('implementationOrder') or {}).get(phase) or []
    by_id = {s.get('id'): s for s in (prd.get('stories') or []) if isinstance(s, dict)}

    out = []
    for sid in order:
        s = by_id.get(sid)
        if not s:
            continue
        files = []
        for f in ((s.get('technicalNotes') or {}).get('files') or []):
            exists = os.path.isfile(os.path.join(repo_root, f))
            # A missing file is INFORMATION for a novel story, not an error:
            # the capability does not exist yet and creating it is the work.
            files.append('%s [%s]' % (f, 'exists' if exists else 'MISSING — would be NEW'))
        out.append({
            'id': sid,
            'agentRole': (s.get('agentRole') or '').strip(),
            'unitTests': bool(s.get('unitTests')),
            'files': files,
        })
    return out


def render(prd, repo_root, phase):
    facts = project_facts(repo_root)
    stories = phase_stories(prd, repo_root, phase)

    lines = ['## GROUNDED FACTS — read from this project, not assumed',
             'These are computed from the PRD and the repository. They are the ONLY',
             'story IDs and file paths that exist. Do not introduce any others: a story',
             'or file not listed here does not exist, and a rule that cites one is false.']

    if facts:
        lines.append('\n### This project')
        lines.extend('- %s' % f for f in facts)

    lines.append('\n### Stories in phase "%s" (%d)' % (phase, len(stories)))
    if not stories:
        lines.append('- (none)')
    for s in stories:
        role = s['agentRole'] or 'null — UNASSIGNED, you must assign it'
        lines.append('- %s — agentRole: %s, unitTests: %s' % (s['id'], role, s['unitTests']))
        for f in s['files']:
            lines.append('    file: %s' % f)
        if not s['files']:
            lines.append('    file: (none declared)')

    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prd', required=True)
    ap.add_argument('--repo-root', required=True)
    ap.add_argument('--phase', required=True)
    args = ap.parse_args()
    print(render(_load(args.prd), args.repo_root, args.phase))
    return 0


if __name__ == '__main__':
    sys.exit(main())
