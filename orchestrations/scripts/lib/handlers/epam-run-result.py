#!/usr/bin/env python3
"""THE RESULT `epam run --json` REPORTED, OUT OF ITS RAW OUTPUT.

    argv[1]  the raw output (log lines and the result object, pretty-printed, interleaved)
    stdout   the normalized result

The raw stream mixes one-line log records with the result object `epam run` prints at the end,
pretty-printed across many lines. This read it with `jq -s`, which rejects the WHOLE stream on one
line that is not JSON — a log record cut mid-write — and the caller's `|| true` then left the result
file empty: live 2026-09-24 an attempt of 11.4M input tokens was recorded as $0, class "unknown".

Every JSON object that starts a line is decoded where it stands; anything that does not decode is
skipped, never fatal. The LAST object carrying `result` is the attempt's. Nothing it reported is
dropped: how it ended (stop_reason), how long it ran (iterations, toolCallCount), what ran it
(model, provider) and whether its cost is priced or measured (cost_is_estimate) all travel on —
the ledger, the failure classifier and the analyst read them. A stream with no result object says
so (no_result_reported) rather than passing as a zero-cost success.
"""
import json
import sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read() if len(sys.argv) > 1 else ''
dec = json.JSONDecoder()
found = None
starts = [0] + [i + 1 for i, ch in enumerate(raw) if ch == '\n']
for s in starts:
    if s >= len(raw) or raw[s] != '{':
        continue
    try:
        obj, _ = dec.raw_decode(raw, s)
    except ValueError:
        continue
    if isinstance(obj, dict) and 'result' in obj:
        found = obj

if found is None:
    print(json.dumps({'result': '', 'total_cost_usd': 0,
                      'usage': {'input_tokens': 0, 'output_tokens': 0},
                      'no_result_reported': True, 'raw_bytes': len(raw.encode('utf-8'))}, indent=2))
    sys.exit(0)

u = found.get('usage') or {}
usage = {'input_tokens': u.get('inputTokens', u.get('input_tokens', 0)) or 0,
         'output_tokens': u.get('outputTokens', u.get('output_tokens', 0)) or 0}
if 'cached_input_tokens' in u:            # absent is not zero: an unmeasured value stays absent
    usage['cached_input_tokens'] = u['cached_input_tokens']
out = {'result': found.get('result') or '',
       'total_cost_usd': found.get('cost_usd', found.get('total_cost_usd', 0)) or 0,
       'usage': usage}
for k in ('stop_reason', 'iterations', 'toolCallCount', 'model', 'provider', 'cost_is_estimate'):
    if k in found and found[k] is not None:
        out[k] = found[k]
print(json.dumps(out, indent=2))
