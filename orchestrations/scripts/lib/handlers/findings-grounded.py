#!/usr/bin/env python3
"""Count a gate's findings that point at a file which actually exists.

THE GENERIC HALF OF WHAT FUZZ-VERIFY DOES. fuzz-verify.py adds an executable-test layer that only
makes sense for vulnerability claims; the layer underneath it — "does the file this finding names
exist in the project?" — is what every gate needs before a `fail` may block.

Found necessary on 2026-08-28: runtime-boundary's verdict was never read at all, so before wiring
it in there had to be something to ground it WITH. A claim about a file that does not exist is not
evidence, and a gate that blocks on one teaches the operator to ignore it.

  findings-grounded.py <gate-log> <project-root>   -> prints the count of grounded findings

Prints 0 on anything it cannot read. The caller decides what 0 means; here it only ever means
"nothing was demonstrated", never "nothing was found".
"""
import json
import os
import re
import sys


def _payloads(text):
    """Every JSON object in the log — gates print prose around their answer."""
    for m in re.finditer(r'\{.*\}', text, re.S):
        chunk = m.group(0)
        for candidate in (chunk, *re.findall(r'\{[^{}]*"verdict".*?\}', chunk, re.S)):
            try:
                yield json.loads(candidate)
            except Exception:
                continue


def _files(obj):
    """Any file path a finding names, whatever the gate calls the field."""
    for f in (obj.get('findings') or obj.get('issues') or []):
        if not isinstance(f, dict):
            continue
        for key in ('file', 'path', 'filePath', 'location'):
            v = f.get(key)
            if isinstance(v, str) and v.strip():
                yield v.strip()
                break


def main():
    if len(sys.argv) < 3:
        print(0)
        return
    log, root = sys.argv[1], sys.argv[2]
    try:
        with open(log, 'r', encoding='utf-8', errors='replace') as fh:
            text = fh.read()
    except OSError:
        print(0)
        return

    seen, grounded = set(), 0
    for obj in _payloads(text):
        if not isinstance(obj, dict):
            continue
        for rel in _files(obj):
            if rel in seen:
                continue
            seen.add(rel)
            # absolute paths are accepted as given; relative ones resolve against the codeline
            path = rel if os.path.isabs(rel) else os.path.join(root, rel)
            if os.path.exists(path):
                grounded += 1
    print(grounded)


if __name__ == '__main__':
    main()
