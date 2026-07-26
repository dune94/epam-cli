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

    d['timeline'] = build_timeline(read(args.launch_log))
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

    # PRD-derived facts.
    #
    # The per-codeline working PRD lives in /tmp and is EPHEMERAL — generating a
    # report after it is cleaned produced a run narrative claiming no
    # verification criteria for a run whose log plainly records four of them. A
    # report that silently loses evidence is the failure it exists to prevent,
    # so the log is the fallback and the PRD is snapshotted alongside the report.
    d['fix_sites'], d['vcs'], d['declared_files'] = [], [], []
    d['vc_count'] = first(r'(\d+) verification criteria persisted', log)
    d['vc_resolution'] = first(r'verification criteria persisted \(source: [^,]+, resolution: (\w+)\)', log)
    d['vc_regenerated'] = 'resolution: regenerated' in log
    d['vc_mechanism_flagged'] = first(r'VC guard flagged mechanism[^\n]*', log)
    d['prd_available'] = bool(args.prd and os.path.exists(args.prd))
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



# ── chronological timeline ─────────────────────────────────────────────────────

# Checklist RE-RENDERS ("  ✓ 2      Step 2: CPA pre-pass") repeat every ~30s and
# are not events. The run's real beats carry a ▶/✓/⊘/⚠ with no leading index.
_CHECKLIST_RERENDER = re.compile(r'^\s*[✓○⊘⚠]\s+\d+[a-z]?\s+')

# (pattern, kind, status, headline template, commentary)
_EVENTS = [
    (r'OpenRouter usage before:\s*\$([\d.]+)', 'cost', 'info',
     'Run starts — provider balance ${0}', ''),
    (r'Moved (\d+) stale [^\n]*file\(s\) → (\S+)', 'reset', 'info',
     'Clean slate: {0} stale artefact(s) archived',
     'A leftover log or manifest reads exactly like current data, so they are moved, not truncated.'),
    (r'Cleared (\d+) KB scratchpad file', 'reset', 'info', 'KB scratchpad cleared ({0} file(s))', ''),
    (r'\[jira\] (https?://\S+) \(project: (\w+)\)', 'ingest', 'info',
     'Jira ingest — {1} from {0}', ''),
    (r'\[ac-gate\]\s+verdict: (\w+)', 'ingest', 'info', 'AC gate verdict: {0}',
     'The ticket carries no acceptance criteria; the gate judged whether the description alone is enough.'),
    (r"\[orch\] Codeline '(\S+)' → (\S+)", 'ingest', 'info', 'Codeline selected: {0}', ''),
    (r'\[orch\] Brownfield baseline: (\S+) @ (\S+)', 'ingest', 'info',
     'Baseline pinned: {0} @ {1}', 'Everything later is measured against this commit.'),
    (r'^\s*▶ (Step [\d.]+[a-z]?: .+?)\s*$', 'step', 'info', '{0}', ''),
    (r'^\s*✓ (Step [\d.]+[a-z]?: .+?)\s*$', 'step', 'ok', '{0} — passed', ''),
    (r'^\s*⊘ (Step [\d.]+[a-z]?: .+?)\s+\[(.+?)\]', 'step', 'skip', '{0} — skipped ({1})', ''),
    (r'^\s*⚠ (Step [\d.]+[a-z]?: .+?)\s+\[(.+?)\]', 'step', 'warn', '{0} — {1}', ''),
    (r'is UNGROUNDED \(attempt (\d)/(\d)\)[^\n]*?"([^"]+)"', 'detective', 'warn',
     'Detective answer REJECTED as ungrounded (attempt {0}/{1})',
     'It quoted <code>{2}</code> as the broken code — an expression not present in the file it named. '
     'The evidence gate checks the quote against the real file, so the diagnosis was refused instead of trusted.'),
    (r'ladder escalation for \S+ \(attempt (\d)/(\d)\) — model (\S+) → (\S+)', 'detective', 'warn',
     'Model escalated: {2} → {3}', 'Attempt {0} of {1}.'),
    (r'code-graph-detective located fix site: (\S+)(?: \(reuse (\S+)\))?', 'detective', 'ok',
     'Fix site located: {0}', 'Prescribed reuse of the existing helper <code>{1}</code>.'),
    (r'(\d+) verification criteria persisted', 'spec', 'ok', '{0} verification criteria written', ''),
    (r'InferenceLadder\[Rung(\d)/R(\d)\]: model=.(\S+?). ', 'impl', 'info',
     'Implementation ladder rung {0}, try {1} — model {2}', ''),
    (r'declared deliverable\(s\) exist but are UNCHANGED[^\n]*?\[attempt (\d+)/(\d+)', 'impl', 'warn',
     'Attempt {0}/{1} produced no change — retrying',
     'A per-attempt verdict, not a failure: the guard refuses to accept a turn that wrote nothing.'),
    (r'Cost\[(\S+)\] model=(\S+) in=(\d+) out=(\d+) cost=\$([\d.]+)[^\n]*status=(\w+)', 'impl', 'info',
     'Agent call — {1} · in {2} / out {3} tokens · ${4} ({5})', ''),
    (r'Implemented: (\d+), Failed: (\d+), Skipped: (\d+)', 'impl', 'ok',
     'Story implemented — {0} done, {1} failed, {2} skipped', ''),
    (r'\[repro-test-writer\] writing reproducing test[^\n]*→ (\S+)', 'test', 'info',
     'Writing a bug-reproducing test → {0}', ''),
    (r'written test FAILS TYPECHECK', 'test', 'warn', 'Written test rejected — it does not compile',
     'Discarded rather than committed: a test that cannot run would look like coverage while proving nothing.'),
    (r'constraints applied for (\S+) \(story:[^)]+\): (\S+)', 'test', 'info',
     'Self-heal constraints applied to {0}', 'Compiled constraints, not prompt text: <code>{1}</code>'),
    (r'test produced and validated on attempt (\d+) \(model (\S+)\)', 'test', 'ok',
     'Valid test produced on attempt {0} ({1})', ''),
    (r'\[repro-test-writer\] committed reproducing test: (\S+)', 'test', 'ok',
     'Reproducing test committed — {0}', ''),
    (r'\[repro-gate\] ✓ (\S+): the test reproduces the bug[^\n]*', 'test', 'ok',
     'BUG REPRODUCTION PROVEN for {0}',
     'The test was executed against the untouched baseline and against the fix: it fails on one and passes on the '
     'other. This is a demonstration, not a judgement.'),
    (r'Review Decision: ([A-Z_ ]+)', 'review', 'ok', 'Team-lead review: {0}', ''),
    (r'code review APPROVED for phase \S+ \(cycle (\d+)\)', 'review', 'ok',
     'Review approved on cycle {0}', ''),
    (r'review requested changes — re-implementing \(cycle (\d+) → (\d+)\)', 'review', 'warn',
     'Review requested changes — re-implementing (cycle {0} → {1})', ''),
    (r'\[lint\] scope: (\d+) file\(s\) from (.+)', 'lint', 'info',
     'Lint gate scoped to {0} file(s)', 'Source: {1} — the files this run produced, not the whole tree.'),
    (r'could not compute baseline findings for (\S+)', 'lint', 'warn',
     'Baseline findings could NOT be computed',
     'Every finding will be attributed to this run — the inherited-debt protection did not run.'),
    (r'\[lint\] auto-fixing (\d+) file\(s\) clean at baseline \((\d+) skipped', 'lint', 'info',
     'Auto-fixing {0} file(s) clean at baseline', '{1} skipped — files carrying pre-existing findings are not reformatted.'),
    (r'\[lint\] eslint: (PASS[^\n]*|FAIL[^\n]*|COULD NOT RUN[^\n]*)', 'lint', 'ok', 'Lint: {0}', ''),
    (r'\[qa-gate\] (\S+) attempt (\d) produced no structured output', 'gate', 'warn',
     '{0}: no structured output on attempt {1} — retrying with an escalated model', ''),
    (r'\[qa-gate\] (\S+) all (\d+) attempt\(s\) exhausted with no structured output', 'gate', 'bad',
     '{0}: NO VERDICT after {1} attempts', 'This gate reviewed nothing.'),
    (r'"mutationScore":\s*(\d+)', 'gate', 'info', 'Mutation score: {0}', ''),
    (r'Mutant-hunter: ([A-Z]+ — [^\n]+)', 'gate', 'warn', 'Mutant-hunter: {0}', ''),
    (r'Step 4\.\d[a-z]?: Running (\S+)\.\.\.', 'gate', 'info', 'Quality gate: {0}', ''),
    (r'\[orch\] ✅ (Pipeline complete)', 'terminal', 'ok', 'PIPELINE COMPLETE', ''),
    (r'Total spent this run:\s+\$([\d.]+)', 'cost', 'ok', 'Total billed for this run: ${0}', ''),
    (r'✓ (\S+): completed', 'terminal', 'ok', 'Story {0} marked completed', ''),
    (r'PASSED — all (\d+) stories complete', 'terminal', 'ok', 'RUN PASSED — {0}/{0} stories complete', ''),
]


def build_timeline(raw):
    """Ordered (time, kind, status, headline, commentary) from the run's own log."""
    events, seen, clock = [], set(), None
    for line in strip_ansi(raw).splitlines():
        ts = re.match(r'^\[(\d{2}:\d{2}:\d{2})\]', line) or \
             re.match(r'^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\]', line)
        if ts:
            clock = ts.group(1)
        if _CHECKLIST_RERENDER.match(line):
            continue
        for pat, kind, status, head, note in _EVENTS:
            m = re.search(pat, line)
            if not m:
                continue
            g = [x if x is not None else '' for x in m.groups()]
            try:
                headline, commentary = head.format(*g), note.format(*g) if note else ''
            except (IndexError, KeyError):
                continue
            key = (kind, headline)
            if key in seen and kind not in ('step', 'impl', 'gate'):
                break
            seen.add(key)
            events.append({'t': clock, 'kind': kind, 'status': status,
                           'head': headline, 'note': commentary})
            break
    return events


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


TIMELINE_CSS = """
.tl { border-left:2px solid var(--line); margin:1rem 0 0 .5rem; padding-left:0; list-style:none; }
.tl li { position:relative; padding:.55rem 0 .55rem 1.4rem; }
.tl li::before { content:""; position:absolute; left:-.42rem; top:1.05rem; width:.7rem; height:.7rem;
                 border-radius:50%; background:var(--muted); border:2px solid var(--bg); }
.tl li.ok::before{background:var(--ok)} .tl li.warn::before{background:var(--warn)}
.tl li.bad::before{background:var(--bad)} .tl li.skip::before{background:var(--line)}
.tl .t { font-variant-numeric:tabular-nums; color:var(--muted); font-size:12px; margin-right:.5rem; }
.tl .h { font-weight:600; }
.tl li.ok .h{color:var(--ok)} .tl li.warn .h{color:var(--warn)} .tl li.bad .h{color:var(--bad)}
.tl li.skip .h{color:var(--muted); font-weight:400;}
.tl .n { display:block; color:var(--muted); font-size:13.5px; margin-top:.15rem; }
.phase { margin:1.75rem 0 .35rem; font-size:.78rem; text-transform:uppercase; letter-spacing:.07em;
         color:var(--muted); font-weight:700; }
"""

_QA_KINDS = {'test', 'review', 'lint', 'gate', 'terminal'}

_PHASE_OF = {
    'cost': 'Setup', 'reset': 'Setup', 'ingest': 'Ingest & selection',
    'step': 'Pipeline steps', 'detective': 'Diagnosis', 'spec': 'Diagnosis',
    'impl': 'Implementation', 'test': 'Proving the fix', 'review': 'Review',
    'lint': 'Lint gate', 'gate': 'Quality gates', 'terminal': 'Outcome',
}


def render_timeline(events, kinds=None):
    """Chronological play-by-play, grouped by the phase each beat belongs to."""
    rows, current = [], None
    for e in events:
        if kinds and e['kind'] not in kinds:
            continue
        phase = _PHASE_OF.get(e['kind'], '')
        if phase != current:
            if current is not None:
                rows.append('</ul>')
            rows.append('<div class="phase">' + esc(phase) + '</div><ul class="tl">')
            current = phase
        note = ('<span class="n">' + e['note'] + '</span>') if e['note'] else ''
        rows.append(
            '<li class="' + e['status'] + '"><span class="t">' + esc(e['t'] or '') + '</span>'
            '<span class="h">' + esc(e['head']) + '</span>' + note + '</li>')
    if current is not None:
        rows.append('</ul>')
    return '\n'.join(rows) or ('<p>' + MISSING + '</p>')


def head_block(title, subtitle, cards):
    return ('<title>' + esc(title) + '</title>\n<style>' + CSS + TIMELINE_CSS + '</style>\n<main>\n'
            '<h1>' + esc(title) + '</h1>\n<p class="sub">' + subtitle + '</p>\n'
            '<div class="cards">' + cards + '</div>')


def narrative_html(d):
    verdict_cls = 'ok' if d['passed'] else 'bad'
    verdict = 'PASSED' if d['passed'] else 'DID NOT COMPLETE'
    gap = (float(d['cost_total']) - d['cost_tracked']) if d['cost_total'] else None

    cards = (
        '<div class="card"><div class="k">Outcome</div><div class="v ' + verdict_cls + '">' + verdict + '</div></div>'
        '<div class="card"><div class="k">Billed</div><div class="v">$' + esc(d['cost_total'] or '?') + '</div></div>'
        '<div class="card"><div class="k">Window</div><div class="v">' + esc(d['t_start'] or '?') + '&ndash;' + esc(d['t_end'] or '?') + '</div></div>'
        '<div class="card"><div class="k">Codeline</div><div class="v">' + esc(d['codeline'] or '?') + '</div></div>')

    costs = '\n'.join(
        '<tr><td><code>%s</code></td><td class="num">$%.4f</td><td class="num">%s</td>'
        '<td class="num">%s</td><td class="num">%d</td></tr>'
        % (esc(a), c, format(i, ','), format(o, ','), n)
        for a, c, i, o, n in d['costs'])

    vc_items = ''.join('<li>' + esc(v) + '</li>' for v in d['vcs'])
    if not vc_items and d.get('vc_count'):
        vc_items = ('<li><strong>' + esc(d['vc_count']) + ' verification criteria</strong> were written '
                    '(resolution: ' + esc(d.get('vc_resolution') or '?') + '). Their text is not in this report: it '
                    'lived in the per-codeline working PRD, which is temporary and had already been deleted when this '
                    'report was generated. Future runs snapshot it as <code>working-prd.json</code>.</li>')

    gap_note = ''
    if gap and abs(gap) > 0.005:
        gap_note = ('<div class="note bad"><strong>Attribution gap: $%.4f.</strong> The provider billed $%s but only '
                    '$%.4f is attributed to a named agent. Some calls emit no cost event, and several agents report '
                    '<code>tokensIn=0, tokensOut=0</code> with a non-zero cost.</div>'
                    % (gap, esc(d['cost_total']), d['cost_tracked']))

    vc_note = ''
    if d.get('vc_regenerated'):
        vc_note = ('<div class="note"><strong>The VC guard rejected its first draft and regenerated.</strong> '
                   + esc(d.get('vc_mechanism_flagged') or '') + '</div>')

    commits = ''.join('<tr><td><code>%s</code></td><td>%s</td><td>%s</td></tr>'
                      % (esc(c[0]), esc(c[1]), esc(c[2] if len(c) > 2 else ''))
                      for c in d['commits']) or ('<tr><td colspan="3">' + MISSING + '</td></tr>')

    return (head_block('Run narrative — ' + (d['story'] or ''),
                       'A play-by-play of the run, in the order it happened. Every beat is read from the '
                       'run&rsquo;s own log.', cards)
            + '\n<h2>Play-by-play</h2>\n' + render_timeline(d['timeline'])
            + '\n<h2>The change it produced</h2>\n<table><tr><th>SHA</th><th>Subject</th><th>When</th></tr>'
            + commits + '</table>\n<pre>' + esc((d.get('diffstat') or '').strip() or 'not recorded') + '</pre>\n'
            + render_diff(d.get('diff', ''))
            + '\n<h2>Verification criteria</h2>\n<ul>' + (vc_items or '<li>' + MISSING + '</li>') + '</ul>\n' + vc_note
            + '\n<h2>Cost</h2>\n<table><tr><th>Agent</th><th class="num">Cost</th><th class="num">Tokens in</th>'
              '<th class="num">Tokens out</th><th class="num">Calls</th></tr>\n'
            + (costs or '<tr><td colspan="5">' + MISSING + '</td></tr>')
            + '\n<tr><th>Tracked total</th><th class="num">$%.4f</th><th colspan="3"></th></tr>' % d['cost_tracked']
            + '\n<tr><th>Billed by provider</th><th class="num">$' + esc(d['cost_total'] or '?') + '</th><th colspan="3"></th></tr></table>\n'
            + gap_note
            + '\n<footer>Generated from <code>' + esc(d['launch_log']) + '</code>, the gate logs, '
              '<code>agent-activity.jsonl</code> and the codeline git history. Anything without a supporting '
              'artefact is marked <span class="missing">not recorded</span> rather than inferred.</footer>\n</main>')


def qa_html(d):
    def gate_row(g):
        name = '<td><code>' + esc(g['name']) + '</code></td>'
        if g['size'] is None:
            return '<tr>' + name + '<td><span class="bad">did not run</span></td><td class="num">&mdash;</td><td>no log written</td></tr>'
        if g['wrote_file_instead']:
            return ('<tr>' + name + '<td><span class="bad">no verdict</span></td><td class="num">'
                    + str(g['size']) + ' B</td><td>answered by calling a write tool &mdash; reviewed nothing</td></tr>')
        if g['verdict']:
            cls = 'ok' if g['verdict'] == 'pass' else 'warn'
            return ('<tr>' + name + '<td><span class="' + cls + '">' + esc(g['verdict']) + '</span></td>'
                    '<td class="num">' + str(g['size']) + ' B</td><td></td></tr>')
        return ('<tr>' + name + '<td><span class="warn">no structured verdict</span></td><td class="num">'
                + str(g['size']) + ' B</td><td>log written but nothing parseable</td></tr>')

    log_text = read(d['launch_log'])
    verdicts = [g for g in d['gate_logs'] if g['verdict']]
    quiet = [g for g in d['gate_logs'] if not g['verdict']]

    cards = (
        '<div class="card"><div class="k">Bug reproduction</div><div class="v ' + ('ok">PROVEN' if d['repro_gate'] else 'bad">?') + '</div></div>'
        '<div class="card"><div class="k">Code review</div><div class="v ' +
        ('ok' if (d['review_decision'] or '').strip() == 'APPROVED' else 'warn') + '">' + esc((d['review_decision'] or '?').strip()) + '</div></div>'
        '<div class="card"><div class="k">Mutation score</div><div class="v">' + esc(d['mutation_score'] or '?') + '</div></div>'
        '<div class="card"><div class="k">Gates reporting</div><div class="v">' + str(len(verdicts)) + '/' + str(len(d['gate_logs'])) + '</div></div>')

    ok = lambda cond, yes: ('<span class="ok">' + yes + '</span>') if cond else MISSING
    artifacts = ''.join(
        '<tr><td><code>%s</code></td><td>%s</td></tr>'
        % (esc(f), 'reproducing test' if ('.spec.' in f or '.test.' in f) else 'source change')
        for f in d['manifest']) or ('<tr><td colspan="2">' + MISSING + '</td></tr>')

    quiet_note = ''
    if quiet:
        quiet_note = ('<div class="note bad"><strong>' + str(len(quiet)) + ' of ' + str(len(d['gate_logs']))
                      + ' gates produced no verdict.</strong> A gate that returns nothing has not reviewed the '
                        'change; the phase passed on the remaining ' + str(len(verdicts)) + '.</div>')

    lint_note = ''
    if d['lint_baseline_warning']:
        lint_note = ('<div class="note"><strong>Inherited-debt protection did not execute.</strong> The gate could '
                     'not compute baseline findings, so every finding would have been blamed on this run. It passed '
                     'only because the touched files were clean at baseline.</div>')

    constraints = ('<code>' + '</code>, <code>'.join(esc(c) for c in d['selfheal_constraints']) + '</code>') \
        if d['selfheal_constraints'] else 'none'

    return (head_block('QA test summary — ' + (d['story'] or ''),
                       'Testing and quality events in the order they happened, then the structured summary.', cards)
            + '\n<h2>Play-by-play — testing &amp; quality</h2>\n' + render_timeline(d['timeline'], kinds=_QA_KINDS)
            + '\n<h2>Testing summary</h2>'
            + '\n<h3>1 &middot; Does the change fix the reported bug?</h3>'
              '\n<table><tr><th>Check</th><th>Result</th><th>Evidence</th></tr>'
              '\n<tr><td>Bug reproduced by a test</td><td>' + ok(d['repro_gate'], 'PROVEN') + '</td><td>' + esc(d['repro_gate'] or '') + '</td></tr>'
              '\n<tr><td>Fails on baseline, passes with fix</td><td>' + ok(d['repro_gate'], 'yes') + '</td><td>executed by the repro gate against both states</td></tr>'
              '\n<tr><td>Pre-existing suite still green</td><td>' + ok('Regression guard PASSED' in log_text, 'yes') + '</td><td>Step 5 regression guard</td></tr>'
              '\n<tr><td>Type check</td><td>' + ok('tsc: PASS' in log_text, 'PASS') + '</td><td>Step 20 <code>tsc --noEmit</code></td></tr></table>'
            + '\n<h3>2 &middot; Test artifacts produced</h3>\n<table><tr><th>File</th><th>Role</th></tr>' + artifacts + '</table>'
            + '\n<h3>3 &middot; Quality gates</h3>\n<table><tr><th>Gate</th><th>Verdict</th><th class="num">Log</th><th>Note</th></tr>'
            + ''.join(gate_row(g) for g in d['gate_logs']) + '</table>'
            + '\n<p>Mutation testing: <strong>' + esc(d['mutant_verdict'] or MISSING) + '</strong></p>' + quiet_note
            + '\n<h3>4 &middot; Lint</h3>\n<table><tr><th>Check</th><th>Result</th></tr>'
              '\n<tr><td>Scope</td><td>' + esc(d['lint_scope'] or '?') + ' file(s), from the writer-output manifest</td></tr>'
              '\n<tr><td>Result</td><td>' + esc(d['lint_result'] or MISSING) + '</td></tr>'
              '\n<tr><td>Baseline subtraction</td><td>' + ('<span class="bad">did NOT run</span>' if d['lint_baseline_warning'] else '<span class="ok">ran</span>') + '</td></tr></table>'
            + lint_note
            + '\n<h3>5 &middot; Review &amp; self-healing</h3>\n<table><tr><th>Check</th><th>Result</th></tr>'
              '\n<tr><td>Team-lead decision</td><td>' + esc((d['review_decision'] or '?').strip()) + '</td></tr>'
              '\n<tr><td>Cycles needed</td><td>' + esc(d['review_cycle'] or MISSING) + '</td></tr>'
              '\n<tr><td>Reproducing test rejected before commit</td><td>' + str(d['test_writer_rejected']) + '</td></tr>'
              '\n<tr><td>Self-heal constraints applied</td><td>' + constraints + '</td></tr></table>'
            + '\n<footer>Generated from the run&rsquo;s own logs. Gate rows reflect what each log actually '
              'contains, including gates that produced no verdict.</footer>\n</main>')


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
    if args.prd and os.path.exists(args.prd):
        # Snapshot: the working PRD is temp state and disappears.
        import shutil
        shutil.copy(args.prd, os.path.join(args.out, 'working-prd.json'))
        print('wrote', os.path.join(args.out, 'working-prd.json'))
    with open(os.path.join(args.out, 'run-facts.json'), 'w') as f:
        json.dump({k: v for k, v in d.items() if k != 'diff'}, f, indent=2, default=str)
    print('wrote', os.path.join(args.out, 'run-facts.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
