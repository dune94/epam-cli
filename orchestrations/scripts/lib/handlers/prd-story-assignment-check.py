#!/usr/bin/env python3
"""
DOES EVERY STORY CARRY AN ASSIGNMENT THE ENGINE CAN ACT ON?

Checks each story's aiProvider and status against the declared registry. A story with no provider,
or one naming a provider the engine does not know, cannot be routed — and the failure surfaces
later as an unexplained empty result rather than as a bad assignment.

Lifted out of preflight-check.sh on 2026-08-16, where it was a heredoc with the PRD path
interpolated into its own source AND the provider list written as a Python set literal inside it —
a registry no other check could read. The registry now lives in config/providers.json, which is the
only place a provider is named.

Generic: every input is an argument or config. Nothing here is project- or stack-specific.

    argv[1]  the PRD
    argv[2]  config/providers.json
    stdout   one line per problem, then a summary
    exit 0   every story is routable;  exit 1  at least one is not

Warnings do not fail the check: an effort tier that renders a misleading badge is worth saying and
not worth blocking a run for.
"""
import json
import sys

if len(sys.argv) < 3:
    sys.stderr.write("[prd-story-assignment-check] usage: <prd.json> <providers.json>\n")
    sys.exit(2)

try:
    with open(sys.argv[1]) as fh:
        prd = json.load(fh)
    with open(sys.argv[2]) as fh:
        registry = json.load(fh)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[prd-story-assignment-check] cannot read inputs: {e}\n")
    sys.exit(2)

known = set(registry.get('known', []))
effort_badged = set(registry.get('effortBadged', []))
statuses = set(registry.get('storyStatuses', []))
if not known or not statuses:
    # An empty registry would pass every story silently, which is the reading that lets a
    # misrouted PRD through the one check meant to catch it.
    sys.stderr.write(f"[prd-story-assignment-check] {sys.argv[2]} declares no providers or no statuses\n")
    sys.exit(2)

stories = prd.get('stories', [])
errors = []
warns = []

for s in stories:
    sid = s.get('id', '?')
    provider = s.get('aiProvider', '')
    effort = s.get('effort', 'medium')
    status = s.get('status', 'pending')

    if not provider:
        errors.append(f"{sid}: aiProvider is MISSING")
    elif provider not in known:
        errors.append(f"{sid}: aiProvider='{provider}' is not a known provider")

    if effort == 'low' and provider in effort_badged:
        warns.append(f"{sid}: effort=low maps to the cheapest badge in the viewer — consider 'medium'")

    if status not in statuses:
        errors.append(f"{sid}: status='{status}' is unexpected")

for e in errors:
    print(f"  ✗ {e}")
for w in warns:
    print(f"  ⚠ {w}")
if not errors:
    print(f"  ✓ All {len(stories)} stories have valid aiProvider/model/status")

sys.exit(1 if errors else 0)
