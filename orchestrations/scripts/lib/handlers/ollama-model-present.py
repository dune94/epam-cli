#!/usr/bin/env python3
"""
IS A MODEL ALREADY PULLED IN A LOCAL OLLAMA?

Reads an Ollama /api/tags response and exits 0 when the wanted model is among the installed ones.

Lifted out of tier1-ollama-run.sh on 2026-08-16, where it was a `python3 -c "..."` string with the
model name interpolated into its own source — twice, once in the test and once in the message, so a
model name containing a quote broke the check that decides whether to pull.

Generic: the model name is an argument, and the rule holds for any model.

    argv[1]  the wanted model name
    stdin    the /api/tags response
    exit 0   installed;  exit 1  not installed, with the available names on stdout
"""
import json
import sys

if len(sys.argv) < 2:
    sys.stderr.write("[ollama-model-present] usage: <model-name>  (tags JSON on stdin)\n")
    sys.exit(2)

wanted = sys.argv[1]

try:
    tags = json.load(sys.stdin)
except ValueError as e:
    # Exit 2, not 1: the caller reads 1 as "pull it", and a garbled response is not evidence the
    # model is absent — it is evidence Ollama did not answer.
    sys.stderr.write(f"[ollama-model-present] unreadable /api/tags response: {e}\n")
    sys.exit(2)

names = [m.get('name', '') for m in tags.get('models', [])]
if not any(wanted in n for n in names):
    print(f'Model {wanted} not found. Available:', names)
    sys.exit(1)
