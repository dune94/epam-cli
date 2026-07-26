#!/usr/bin/env python3
"""langfuse-run-view.py — see what every model call in a run actually did.

Langfuse captures the full prompt, response, latency, tokens and cost of every
LLM call the pipeline makes. The web UI at :3100 makes that hard to use: every
trace is named `llm-stream` or `chain:stream` with no agent, story or content at
the top level, so the list is unreadable and you must open traces at random to
find anything.

This prints the view you actually want — one line per call, in order, with the
things that matter for diagnosing a run:

  * how long each call took, so a slow or HUNG call is obvious
  * whether it produced any output at all
  * how many tool calls it made, so thrashing is visible
  * tokens and cost per call

and flags the anomalies explicitly rather than leaving them to be spotted.

It found a real defect the first time it was used: the code-graph-detective made
seven quick, productive tool calls in ~65 seconds and then its forced
"answer now" turn hung and never returned, burning the remaining five minutes of
its budget until the timeout fired. From the log alone that looked like "glm-5.1
is slow"; it was nothing of the kind.

Usage:
  langfuse-run-view.py                       # newest session
  langfuse-run-view.py --session 20260726T150240Z
  langfuse-run-view.py --list                # what sessions exist
  langfuse-run-view.py --agent detective     # filter
  langfuse-run-view.py --prompt <obs-id>     # dump one call's full prompt/response
"""

import argparse
import base64
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get('LANGFUSE_BASE_URL', 'http://localhost:3100')
PUB = os.environ.get('LANGFUSE_PUBLIC_KEY', 'pk-lf-epam-dev')
SEC = os.environ.get('LANGFUSE_SECRET_KEY', 'sk-lf-epam-dev')


def api(path, **params):
    qs = '&'.join(f'{k}={v}' for k, v in params.items() if v is not None)
    url = f'{BASE}/api/public/{path}' + (('?' + qs) if qs else '')
    req = urllib.request.Request(url)
    token = base64.b64encode(f'{PUB}:{SEC}'.encode()).decode()
    req.add_header('Authorization', 'Basic ' + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        print(f'cannot reach Langfuse at {BASE}: {e}', file=sys.stderr)
        print('is the container up?  docker ps | grep langfuse', file=sys.stderr)
        sys.exit(2)


def secs(o):
    st, en = o.get('startTime'), o.get('endTime')
    if not st or not en:
        return None
    f = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return (f(en) - f(st)).total_seconds()


def agent_of(o):
    """Best available label for who made this call."""
    md = o.get('metadata') or {}
    for k in ('agent', 'costAgent', 'role'):
        if md.get(k):
            return str(md[k])
    inp = o.get('input')
    if isinstance(inp, dict):
        msgs = inp.get('messages') or []
        if msgs:
            head = str(msgs[0].get('content') or '')[:400].lower()
            for name, needle in [
                ('detective', 'code-graph-detective'), ('spec', 'openspec'),
                ('reviewer', 'you are the review'), ('test-writer', 'reproducing test'),
                ('sast', 'sast-sentinel'), ('mutant', 'mutant-hunter'),
                ('fuzz', 'fuzz-weaver'), ('perf', 'perf-sentinel'),
                ('ranger', 'review-ranger'), ('validator', 'spec-validator'),
            ]:
                if needle in head:
                    return name
    return '—'


def tool_calls(o):
    out = o.get('output')
    if isinstance(out, dict):
        return len(out.get('toolCalls') or [])
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--agent')
    ap.add_argument('--prompt', help='observation id — dump its full prompt and response')
    ap.add_argument('--limit', type=int, default=200)
    args = ap.parse_args()

    if args.prompt:
        o = api(f'observations/{args.prompt}')
        print('=' * 78)
        print('MODEL   :', o.get('model'), '  latency:', secs(o), 's')
        print('AGENT   :', agent_of(o))
        print('=' * 78)
        inp = o.get('input') or {}
        for m in (inp.get('messages') or []):
            print(f'\n--- {m.get("role", "?").upper()} ---')
            print(str(m.get('content'))[:6000])
        print('\n--- RESPONSE ---')
        print(json.dumps(o.get('output'), indent=2)[:6000] if o.get('output')
              else '(none — this call produced no output)')
        return 0

    traces = api('traces', limit=200).get('data', [])
    sessions = {}
    for t in traces:
        sid = t.get('sessionId') or '(none)'
        sessions.setdefault(sid, []).append(t)

    if args.list or not sessions:
        print(f'{"session":<26}{"traces":>8}  newest')
        for sid, ts in sorted(sessions.items(), reverse=True):
            newest = max((t.get('timestamp') or '') for t in ts)
            print(f'{sid:<26}{len(ts):>8}  {newest}')
        return 0

    session = args.session or sorted(sessions, reverse=True)[0]
    obs = [o for o in api('observations', limit=args.limit, type='GENERATION').get('data', [])
           if o.get('traceId') in {t['id'] for t in sessions.get(session, [])}]
    obs.sort(key=lambda o: o.get('startTime') or '')

    print(f'\nRUN {session} — {len(obs)} model calls\n')
    print(f'{"time":<10}{"agent":<12}{"model":<22}{"secs":>7}{"in":>8}{"out":>7}{"tools":>6}{"cost":>9}')
    print('-' * 82)

    hung, slow, empty, total_cost = [], [], [], 0.0
    for o in obs:
        if args.agent and args.agent.lower() not in agent_of(o).lower():
            continue
        s = secs(o)
        u = o.get('usage') or {}
        cost = (o.get('calculatedTotalCost') or (u.get('totalCost') if isinstance(u, dict) else 0)) or 0
        total_cost += float(cost or 0)
        t = (o.get('startTime') or '?')[11:19]
        mark = ''
        if s is None:
            hung.append((t, agent_of(o), o.get('id')))
            mark = '  ← NEVER RETURNED'
        elif s > 120:
            slow.append((t, agent_of(o), s))
            mark = '  ← slow'
        elif not o.get('output'):
            empty.append((t, agent_of(o)))
            mark = '  ← no output'
        print(f'{t:<10}{agent_of(o)[:11]:<12}{(o.get("model") or "?")[:21]:<22}'
              f'{(round(s, 1) if s else 0):>7}{u.get("input") or 0:>8}{u.get("output") or 0:>7}'
              f'{tool_calls(o):>6}{cost:>9.4f}{mark}')

    print('-' * 82)
    print(f'{"TOTAL":<52}{total_cost:>29.4f}')

    if hung or slow or empty:
        print('\nANOMALIES')
        for t, a, oid in hung:
            print(f'  HUNG      {t}  {a}: the call never returned. Everything after it waited on a '
                  f'request that was never going to finish.')
            print(f'            inspect with:  langfuse-run-view.py --prompt {oid}')
        for t, a, s in slow:
            print(f'  SLOW      {t}  {a}: {s:.0f}s in a single call.')
        for t, a in empty:
            print(f'  NO OUTPUT {t}  {a}: returned successfully but produced nothing usable.')
    else:
        print('\nNo hung, slow or empty calls.')
    print(f'\nWeb UI: {BASE}/project/epam-cli/sessions/{session}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
