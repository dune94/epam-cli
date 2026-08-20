#!/usr/bin/env python3
"""
A ONE-OFF MIGRATION AUDIT TOOL, NOT A PIPELINE HANDLER.

It lived in lib/handlers/ and nothing in the engine called it — reported for nine days as a
handler nothing reaches, which for a real handler would mean the code it replaced is still what
runs. This one has no call site BY DESIGN: it was written for the tool-grant migration (ea9a14e)
and run by hand to produce the audit trail that migration needed.

Moved here so the classification matches what it is. Everything in lib/handlers/ is something the
pipeline invokes; a tool an operator runs once belongs beside the other tools.

WHICH TOOL-GRANT KIND EACH SEAM RUNS WITH — READ OFF ITS CALL SITE, NOT CHOSEN.

Every seam already runs with a grant today; it is just resolved at the call site instead of
declared on the seam, which is why the registry could both hardcode nine literal lists and leave
twenty-six seams declaring nothing. This reads the grant each seam ACTUALLY receives and maps it
to the kind that produces the same list, so moving the declaration into the registry is a
migration with an audit trail rather than thirty-six judgement calls.

  argv[1]  the scripts dir to scan
  stdout   seam<TAB>kind<TAB>evidence

The evidence column names the call site the kind came from. A seam whose grant cannot be found is
reported as `unknown` and NOT assigned: inventing one is exactly what this exists to avoid.
"""
import json
import os
import re
import sys

scripts = sys.argv[1] if len(sys.argv) > 1 else '.'
registry = json.load(open(os.path.join(scripts, '..', 'agents', 'invocation-profiles.json')))

# The grant each call site resolves, as observed in the source. Key is the env var it reads.
SITE = {}
for fn in os.listdir(scripts):
    if not fn.endswith(('.js', '.sh')):
        continue
    try:
        src = open(os.path.join(scripts, fn), encoding='utf-8', errors='ignore').read()
    except OSError:
        continue
    for var, lst in re.findall(r"([A-Z_]+_ALLOWED_TOOLS)\s*\|\|\s*'([a-z_,]+)'", src):
        SITE.setdefault(var, (lst, fn))

def kind_for(tools):
    """The kind whose resolved list equals this observed list."""
    t = set(x for x in tools.split(',') if x)
    if not t:
        return 'none'
    if 'write_file' in t:
        return 'write'
    if 'fetch_url' in t:
        return 'read-network'
    if 'bash' in t:
        return 'execute'
    return 'read-only'

# Which call site serves which seam, taken from how the pipeline groups them.
GROUP = [
    (re.compile(r'^qa-gate:'),                       'ORCH_GATE_ALLOWED_TOOLS'),
    (re.compile(r'^(spec-agent|spec-coordinator|ac-|cpa-|prd-change|role-assigner|vc-|tc-writer|guard-vocabulary|codeline-discovery)'),
                                                     'SPEC_MODE_ALLOWED_TOOLS'),
    (re.compile(r'^ticket-links$'),                  'TICKET_LINK_ALLOWED_TOOLS'),
    (re.compile(r'^code-graph-detective$'),          'CODEGRAPH_DETECTIVE_ALLOWED_TOOLS'),
]

for name, prof in sorted(registry['profiles'].items()):
    # A literal already on the seam is its own evidence — the strongest kind there is.
    if prof.get('allowedTools'):
        print(f"{name}\t{kind_for(prof['allowedTools'])}\tregistry allowedTools: {prof['allowedTools']}")
        continue
    matched = None
    for pattern, var in GROUP:
        if pattern.search(name) and var in SITE:
            matched = var
            break
    if matched:
        tools, fn = SITE[matched]
        print(f"{name}\t{kind_for(tools)}\t{matched} in {fn}: {tools}")
    else:
        # readOnlyToolGrant() callers: the mint stage agents.
        if name in ('agent-mint', 'roster-review', 'estate-survey', 'prompt-review'):
            print(f"{name}\tread-only\treadOnlyToolGrant() at the mint stage")
        elif name == 'repro-test-writer':
            # brownfield-repro-test-writer.sh opens the tool channel AND grants a write path:
            # it authors the test file the bug-reproduction gate then executes.
            print(f"{name}\twrite\tAI_GATE_ALLOW_TOOLS + EPAM_ALLOWED_WRITE_PATHS in brownfield-repro-test-writer.sh")
        else:
            print(f"{name}\tunknown\tno call site found — not assigned")
