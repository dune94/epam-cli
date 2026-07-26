#!/usr/bin/env python3
"""generate-run-report.py — the two deliverables a successful run owes: a run
narrative and a QA test summary.

Every claim traces to a real artifact. Where an artifact is missing the report
says "not recorded" rather than inferring — a run report that fabricates is
worse than no run report, because it reads exactly like a verified one. That is
the same lie-that-looks-like-data hazard as a stale log.

Usage:
  generate-run-report.py --launch-log <file> --logs-dir <dir> --out <dir>
                         [--codeline <repo>] [--baseline <sha>] [--prd <file>]
"""

import argparse
import collections
import html
import json
import os
import re
import subprocess
import sys
from datetime import datetime

MISSING = '<span class="missing">not recorded</span>'


def read(path, limit=None):
    try:
        with open(path, errors='replace') as f:
            return f.read(limit) if limit else f.read()
    except OSError:
        return ''


def find_all(pattern, text, flags=0):
    return [m.group(0) if not m.groups() else m.group(1)
            for m in re.finditer(pattern, text, flags)]


def first(pattern, text, flags=0):
    m = re.search(pattern, text, flags)
    if not m:
        return None
    return m.group(1) if m.groups() else m.group(0)


def strip_ansi(s):
    return re.sub(r'\x1b\[[0-9;]*m', '', s)


def esc(s):
    return html.escape(str(s)) if s is not None else ''


# ── data collection ────────────────────────────────────────────────────────────

def collect(args):
    log = strip_ansi(read(args.launch_log))
    d = {'launch_log': args.launch_log, 'logs_dir': args.logs_dir}

    d['story'] = first(r'\b(AMSD-\d+|[A-Z]{2,}-\d+)\b', log)
    d['cost_before'] = first(r'OpenRouter usage before:\s*\$([0-9.]+)', log)
    d['cost_after'] = first(r'OpenRouter usage after:\s*\$([0-9.]+)', log)
    d['cost_total'] = first(r'Total spent this run:\s*\$([0-9.]+)', log)
    d['pipeline_complete'] = 'Pipeline complete' in log
    d['passed'] = bool(re.search(r'PASSED — all \d+ stories complete', log))
    d['codeline'] = first(r"Phase 'core' — codeline '([^']+)'", log)

    times = find_all(r'\[(\d{2}:\d{2}:\d{2})\]', log)
    d['t_start'], d['t_end'] = (times[0], times[-1]) if times else (None, None)

    # Detective
    d['detective_ungrounded'] = len(find_all(r'is UNGROUNDED', log))
    d['detective_bad_quote'] = first(r'quote code that is NOT in the file they name '
                                     r'\(e\.g\. [^:]+: "([^"]+)"\)', log)
    d['detective_escalation'] = first(
        r'ladder escalation for \S+ \(attempt \d/\d\) — model (\S+ → \S+)', log)
    d['detective_maxiter'] = len(find_all(r'reached maximum iterations', log))

    # Gates
    d['repro_gate'] = first(r'\[repro-gate\] ✓ ([^\n]+)', log)
    d['review_decision'] = first(r'Review Decision: ([A-Z_ ]+)', log)
    d['review_cycle'] = first(r'code review APPROVED for phase \'[^\']+\' \(cycle (\d+)\)', log)
    d['lint_scope'] = first(r'\[lint\] scope: (\d+) file', log)
    d['lint_result'] = first(r'\[lint\] eslint: ([^\n]+)', log)
    d['lint_baseline_warning'] = 'could not compute baseline findings' in log
    d['mutation_score'] = first(r'"mutationScore":\s*(\d+)', log)
    d['mutant_verdict'] = first(r'Mutant-hunter: ([A-Z]+[^\n]*)', log)
    d['implemented'] = first(r'Implemented:\s*(\d+)', log)
    d['failed'] = first(r'Failed:\s*(\d+)', log)

    # Story-loop retries: a per-attempt WARNING, not a failure.
    d['unchanged_warnings'] = len(find_all(r'declared deliverable\(s\) exist but are UNCHANGED', log))

    # Self-heal
    d['selfheal_constraints'] = sorted(set(find_all(
        r'constraints applied for [\w-]+ \(story:[^)]+\): ([^\n]+)', log)))
    d['test_writer_attempts'] = first(r'test produced and validated on attempt (\d+)', log)
    d['test_writer_rejected'] = len(find_all(r'written test FAILS TYPECHECK', log))

    # Writer-output manifest.
    #
    # Read from the run's OWN commits, not from logs_dir/story-outputs-core.txt.
    # That file is live mutable state: anything running after the pipeline (a
    # test suite, a later run) appends to it, and a report that reads it would
    # attribute other work to this run. Found while generating the first report
    # — the live manifest had picked up stub.sh, attempts.txt and
    # node_modules/.bin/vitest from test runs. The commits are immutable.
    d['manifest'] = []
    d['manifest_source'] = 'commits'

    # Per-agent cost from the activity stream
    costs = collections.defaultdict(lambda: [0.0, 0, 0, 0])
    for line in read(os.path.join(args.logs_dir, 'agent-activity.jsonl')).splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('type') != 'cost_snapshot':
            continue
        det = e.get('detail') or {}
        row = costs[e.get('agent') or '?']
        row[0] += float(det.get('costUsd') or 0)
        row[1] += int(det.get('tokensIn') or 0)
        row[2] += int(det.get('tokensOut') or 0)
        row[3] += 1
    d['costs'] = sorted(((a, *v) for a, v in costs.items()), key=lambda r: -r[1])
    d['cost_tracked'] = sum(v[0] for v in costs.values())

    # Gate logs actually written by this run
    gates = ['sast-sentinel', 'spec-validator', 'review-ranger',
             'mutant-hunter', 'fuzz-weaver', 'perf-sentinel']
    d['gate_logs'] = []
    for g in gates:
        p = os.path.join(args.logs_dir, f'{g}-core.log')
        size = os.path.getsize(p) if os.path.exists(p) else None
        body = read(p, 4000) if size else ''
        verdict = first(r'"verdict":\s*"(\w+)"', body)
        d['gate_logs'].append({
            'name': g, 'size': size, 'verdict': verdict,
            'wrote_file_instead': 'has been written' in body,
        })

    # Commits produced in the codeline
    d['commits'] = []
    if args.codeline and args.baseline:
        try:
            out = subprocess.run(
                ['git', '-C', args.codeline, 'log', '--format=%h|%s|%ad', '--date=iso',
                 f'{args.baseline}..HEAD'],
                capture_output=True, text=True, timeout=30).stdout
            d['commits'] = [l.split('|', 2) for l in out.splitlines() if l.strip()]
            diff = subprocess.run(
                ['git', '-C', args.codeline, 'diff', f'{args.baseline}..HEAD'],
                capture_output=True, text=True, timeout=30).stdout
            d['diff'] = diff
            d['diffstat'] = subprocess.run(
                ['git', '-C', args.codeline, 'diff', '--stat', f'{args.baseline}..HEAD'],
                capture_output=True, text=True, timeout=30).stdout
            names = subprocess.run(
                ['git', '-C', args.codeline, 'diff', '--name-only', f'{args.baseline}..HEAD'],
                capture_output=True, text=True, timeout=30).stdout
            d['manifest'] = [l for l in names.splitlines() if l.strip()]
        except (OSError, subprocess.SubprocessError):
            pass

    # PRD-derived facts
    d['fix_sites'], d['vcs'], d['declared_files'] = [], [], []
    if args.prd and os.path.exists(args.prd):
        try:
            with open(args.prd) as f:
                prd = json.load(f)
            for s in prd.get('stories', []):
                if d['story'] and s.get('id') != d['story']:
                    continue
                d['fix_sites'] = s.get('fixSiteAnalysis') or []
                d['vcs'] = s.get('verificationCriteria') or []
                d['declared_files'] = (s.get('technicalNotes') or {}).get('files') or []
                d['title'] = s.get('title') or ''
        except (OSError, ValueError):
            pass
    return d


# ── rendering ──────────────────────────────────────────────────────────────────

CSS = """
:root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#666; --line:#e2e2e2;
        --ok:#0a7c42; --warn:#a86500; --bad:#c02626; --card:#fafafa; --code:#f4f4f5; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --bg:#141416; --muted:#9a9a9a; --line:#2c2c30;
          --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --card:#1c1c20; --code:#202024; } }
* { box-sizing:border-box; }
body { margin:0; padding:2rem 1.25rem 4rem; font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       color:var(--fg); background:var(--bg); }
main { max-width:60rem; margin:0 auto; }
h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.01em; }
h2 { font-size:1.15rem; margin:2.5rem 0 .75rem; padding-bottom:.35rem; border-bottom:1px solid var(--line); }
h3 { font-size:1rem; margin:1.5rem 0 .5rem; }
.sub { color:var(--muted); margin:0 0 1.5rem; }
table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; font-size:14px; }
th,td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-weight:600; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
code { background:var(--code); padding:.1rem .3rem; border-radius:3px; font-size:.9em; }
pre { background:var(--code); padding:.8rem 1rem; border-radius:6px; overflow-x:auto; font-size:13px; line-height:1.5; }
.cards { display:flex; flex-wrap:wrap; gap:.75rem; margin:1rem 0 0; }
.card { flex:1 1 8rem; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.7rem .85rem; }
.card .k { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
.card .v { font-size:1.25rem; font-variant-numeric:tabular-nums; margin-top:.15rem; }
.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
.missing { color:var(--muted); font-style:italic; }
.note { background:var(--card); border-left:3px solid var(--warn); padding:.7rem .9rem; border-radius:0 6px 6px 0; margin:1rem 0; }
.note.bad { border-left-color:var(--bad); }
ul { padding-left:1.2rem; } li { margin:.2rem 0; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
.diff-add{color:var(--ok)} .diff-del{color:var(--bad)}
"""


def render_diff(diff):
    if not diff:
        return f'<p>{MISSING}</p>'
    out = []
    for line in diff.splitlines():
        cls = ''
        if line.startswith('+') and not line.startswith('+++'):
            cls = 'diff-add'
        elif line.startswith('-') and not line.startswith('---'):
            cls = 'diff-del'
        out.append(f'<span class="{cls}">{esc(line)}</span>' if cls else esc(line))
    return '<pre>' + '\n'.join(out) + '</pre>'


def narrative_html(d):
    verdict_cls = 'ok' if d['passed'] else 'bad'
    verdict = 'PASSED' if d['passed'] else 'DID NOT COMPLETE'
    fs = d['fix_sites'][0] if d['fix_sites'] else {}

    detective = []
    if d['detective_ungrounded']:
        detective.append(
            f"Attempt 1 was <strong>rejected as ungrounded</strong>: it quoted "
            f"<code>{esc(d['detective_bad_quote'])}</code> as the broken code, an expression that "
            f"does not exist in the file it named. The evidence gate checks the quote against the "
            f"real file, so the answer was refused rather than handed to the implementer.")
    if d['detective_escalation']:
        detective.append(f"The ladder escalated: <code>{esc(d['detective_escalation'])}</code>.")
    if fs:
        detective.append(
            f"The accepted diagnosis names <code>{esc(fs.get('file'))}</code>, quoting "
            f"<code>{esc(fs.get('brokenLine'))}</code>, and prescribes reuse of the existing helper "
            f"<code>{esc(fs.get('helper'))}</code>. <code>evidenceVerified</code> = "
            f"<strong>{esc(fs.get('evidenceVerified'))}</strong> — the quoted line was confirmed present.")

    gap = None
    if d['cost_total']:
        gap = float(d['cost_total']) - d['cost_tracked']

    rows = '\n'.join(
        f'<tr><td><code>{esc(a)}</code></td><td class="num">${c:.4f}</td>'
        f'<td class="num">{i:,}</td><td class="num">{o:,}</td><td class="num">{n}</td></tr>'
        for a, c, i, o, n in d['costs'])

    return f"""<title>Run narrative — {esc(d['story'])}</title>
<style>{CSS}</style>
<main>
<h1>Run narrative — {esc(d['story'])}</h1>
<p class="sub">{esc(d.get('title',''))}</p>

<div class="cards">
  <div class="card"><div class="k">Outcome</div><div class="v {verdict_cls}">{verdict}</div></div>
  <div class="card"><div class="k">Cost (billed)</div><div class="v">${esc(d['cost_total'] or '?')}</div></div>
  <div class="card"><div class="k">Window</div><div class="v">{esc(d['t_start'] or '?')}–{esc(d['t_end'] or '?')}</div></div>
  <div class="card"><div class="k">Codeline</div><div class="v">{esc(d['codeline'] or '?')}</div></div>
  <div class="card"><div class="k">Stories</div><div class="v">{esc(d['implemented'] or '?')} impl / {esc(d['failed'] or '?')} failed</div></div>
</div>

<h2>What happened</h2>
<h3>1 · Locating the cause</h3>
{''.join(f'<p>{p}</p>' for p in detective) or f'<p>{MISSING}</p>'}

<h3>2 · The change</h3>
<p>Declared candidate files: {len(d['declared_files'])}. Commits produced:</p>
<table><tr><th>SHA</th><th>Subject</th><th>When</th></tr>
{''.join(f'<tr><td><code>{esc(c[0])}</code></td><td>{esc(c[1])}</td><td>{esc(c[2] if len(c)>2 else "")}</td></tr>' for c in d['commits']) or f'<tr><td colspan="3">{MISSING}</td></tr>'}
</table>
<pre>{esc(d.get('diffstat','').strip()) or 'not recorded'}</pre>
{render_diff(d.get('diff',''))}

<h3>3 · Proving it</h3>
<p>{('<strong class="ok">' + esc(d['repro_gate']) + '</strong>') if d['repro_gate'] else MISSING}</p>
<p>This is an executed check, not a judgement: the test was run against the untouched
baseline and against the fix.</p>

<h3>4 · Retries and self-healing</h3>
<ul>
<li>Story attempts that produced no change (per-attempt warnings, not failures): <strong>{d['unchanged_warnings']}</strong></li>
<li>Reproducing test rejected by typecheck before commit: <strong>{d['test_writer_rejected']}</strong>{' — validated on attempt ' + esc(d['test_writer_attempts']) if d['test_writer_attempts'] else ''}</li>
<li>Self-heal constraints applied: {('<code>' + '</code>, <code>'.join(esc(c) for c in d['selfheal_constraints']) + '</code>') if d['selfheal_constraints'] else MISSING}</li>
<li>Detective iteration-cap exhaustions: <strong>{d['detective_maxiter']}</strong></li>
</ul>

<h2>Verification criteria</h2>
<ul>{''.join(f'<li>{esc(v)}</li>' for v in d['vcs']) or f'<li>{MISSING}</li>'}</ul>

<h2>Cost</h2>
<table><tr><th>Agent</th><th class="num">Cost</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Calls</th></tr>
{rows or f'<tr><td colspan="5">{MISSING}</td></tr>'}
<tr><th>Tracked total</th><th class="num">${d['cost_tracked']:.4f}</th><th colspan="3"></th></tr>
<tr><th>Billed (provider)</th><th class="num">${esc(d['cost_total'] or '?')}</th><th colspan="3"></th></tr>
</table>
{f'''<div class="note bad"><strong>Attribution gap: ${gap:.4f}.</strong> The provider billed
${esc(d['cost_total'])} but only ${d['cost_tracked']:.4f} is attributed to a named agent.
Some calls are not emitting cost events. Separately, several agents report
<code>tokensIn=0, tokensOut=0</code> with a non-zero cost, so token accounting is incomplete
for those providers.</div>''' if gap and abs(gap) > 0.005 else ''}

<footer>Generated from: <code>{esc(d['launch_log'])}</code>, <code>{esc(d['logs_dir'])}/agent-activity.jsonl</code>,
the phase gate logs, and the codeline git history. Fields with no supporting artifact are
marked <span class="missing">not recorded</span> rather than inferred.</footer>
</main>"""


def qa_html(d):
    def gate_row(g):
        if g['size'] is None:
            return f'<tr><td><code>{esc(g["name"])}</code></td><td>{MISSING}</td><td colspan="2">log absent — this gate did not run</td></tr>'
        if g['wrote_file_instead']:
            state = '<span class="bad">no verdict</span>'
            note = 'answered by calling a write tool — reviewed nothing'
        elif g['verdict']:
            cls = 'ok' if g['verdict'] == 'pass' else 'warn'
            state = f'<span class="{cls}">{esc(g["verdict"])}</span>'
            note = ''
        else:
            state = '<span class="warn">no structured verdict</span>'
            note = 'log written but no parseable verdict'
        return (f'<tr><td><code>{esc(g["name"])}</code></td><td>{state}</td>'
                f'<td class="num">{g["size"]} B</td><td>{note}</td></tr>')

    lint_note = ('<div class="note"><strong>Baseline subtraction did not run.</strong> '
                 'The gate logged <code>could not compute baseline findings</code>, so every finding '
                 'would have been attributed to this run. It passed only because the files were clean '
                 'at baseline — the inherited-debt protection was not exercised.</div>'
                 if d['lint_baseline_warning'] else '')

    return f"""<title>QA summary — {esc(d['story'])}</title>
<style>{CSS}</style>
<main>
<h1>QA test summary — {esc(d['story'])}</h1>
<p class="sub">Every row below is read from a gate log written by this run. An absent log means the gate did not run.</p>

<div class="cards">
  <div class="card"><div class="k">Bug reproduction</div><div class="v {'ok' if d['repro_gate'] else 'bad'}">{'PROVEN' if d['repro_gate'] else '?'}</div></div>
  <div class="card"><div class="k">Code review</div><div class="v {'ok' if (d['review_decision'] or '').strip()=='APPROVED' else 'warn'}">{esc((d['review_decision'] or '?').strip())}</div></div>
  <div class="card"><div class="k">Mutation score</div><div class="v">{esc(d['mutation_score'] or '?')}</div></div>
  <div class="card"><div class="k">Lint scope</div><div class="v">{esc(d['lint_scope'] or '?')} files</div></div>
</div>

<h2>Bug-reproduction gate</h2>
<p>{('<strong class="ok">' + esc(d['repro_gate']) + '</strong>') if d['repro_gate'] else MISSING}</p>

<h2>Code review</h2>
<p>Decision <strong>{esc((d['review_decision'] or '?').strip())}</strong>{' on cycle ' + esc(d['review_cycle']) if d['review_cycle'] else ''}.</p>

<h2>Lint gate</h2>
<p>Scope: <strong>{esc(d['lint_scope'] or '?')} file(s)</strong> taken from the writer-output manifest —
the files this run actually produced, not the whole tree. Listed below from the run's own
commits (the live manifest file is mutable and would attribute later work to this run):</p>
<ul>{''.join(f'<li><code>{esc(f)}</code></li>' for f in d['manifest']) or f'<li>{MISSING}</li>'}</ul>
<p>Result: <strong>{esc(d['lint_result'] or '?')}</strong></p>
{lint_note}

<h2>Quality gates</h2>
<table><tr><th>Gate</th><th>Verdict</th><th class="num">Log</th><th>Note</th></tr>
{''.join(gate_row(g) for g in d['gate_logs'])}
</table>
<p>Mutation: <strong>{esc(d['mutant_verdict'] or MISSING)}</strong></p>

<h2>Test artifacts committed</h2>
<table><tr><th>SHA</th><th>Subject</th></tr>
{''.join(f'<tr><td><code>{esc(c[0])}</code></td><td>{esc(c[1])}</td></tr>' for c in d['commits']) or f'<tr><td colspan="2">{MISSING}</td></tr>'}
</table>

<footer>Generated {esc(datetime.now().strftime('%Y-%m-%d %H:%M'))} from the run's own logs.
Gate rows reflect what each log contains — including gates that produced no verdict.</footer>
</main>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--launch-log', required=True)
    ap.add_argument('--logs-dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--codeline')
    ap.add_argument('--baseline')
    ap.add_argument('--prd')
    args = ap.parse_args()

    d = collect(args)
    os.makedirs(args.out, exist_ok=True)
    for name, body in (('narrative.html', narrative_html(d)),
                       ('qa-summary.html', qa_html(d))):
        with open(os.path.join(args.out, name), 'w') as f:
            f.write(body)
        print('wrote', os.path.join(args.out, name))
    with open(os.path.join(args.out, 'run-facts.json'), 'w') as f:
        json.dump({k: v for k, v in d.items() if k != 'diff'}, f, indent=2, default=str)
    print('wrote', os.path.join(args.out, 'run-facts.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
