#!/usr/bin/env python3
"""
POINT EVERY STORY ON ONE PROVIDER AT ONE MODEL.

The free-tier launcher uses this to move every story assigned to a provider onto the free model for
that provider, without touching stories on any other provider.

Lifted out of tier2-free-run.sh on 2026-08-16, where it was an UNQUOTED heredoc with the PRD path
and the model name substituted into its own source — twice each. The PROVIDER was written into the
program as a literal, so the launcher could only ever patch one; it is an argument now.

Generic: every input is an argument, and the rule holds for any project, provider or model.

    argv[1]  the PRD, rewritten in place
    argv[2]  the provider whose stories are moved
    argv[3]  the model to move them to
    stdout   a line saying how many stories moved

Written through a temporary file and os.replace, so an interrupted write never leaves a half-PRD.
An unreadable PRD is fatal — the launcher must not run against a PRD it failed to patch.
"""
import json
import os
import sys

if len(sys.argv) < 4:
    sys.stderr.write("[prd-set-model-for-provider] usage: <prd.json> <provider> <model>\n")
    sys.exit(1)

prd_path, provider, model = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(prd_path) as f:
        prd = json.load(f)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[prd-set-model-for-provider] cannot read {prd_path}: {e}\n")
    sys.exit(1)

moved = 0
for story in prd.get('stories', []):
    if story.get('aiProvider') == provider:
        story['model'] = model
        moved += 1

tmp = prd_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(tmp, prd_path)

print(f'PRD patched: {moved} {provider} stories -> {model}')
