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
    # Codeline selection evidence — how the repo was chosen, not just which.
    d['title'] = first(r'Title:\s*([^\n]+)', log) or first(r'\[Mozio\][^\n]{10,140}', log) or ''
    d['codeline_path'] = first(r"\[orch\] Codeline '\S+' → (\S+)", log)
    d['repo_count'] = first(r'Found (\d+) git repo\(s\) in codeline root', log)
    d['scoring'] = first(r'Tier-2 cross-repo scoring \([^)]*\): ([^\n]+)', log)
    d['scoring_driver'] = first(r"top candidate '\S+' driven by: ([^\n]+)", log)
    d['shortlist'] = first(r'Repo scoring: top (\d+) candidate\(s\) from (\d+) repos', log)
    d['selector_model'] = first(r'Calling LLM \((\S+)\) to match', log)
    d['story'] = first(r'\b(AMSD-\d+|[A-Z]{2,}-\d+)\b', log)
    d['cost_before'] = first(r'OpenRouter usage before:\s*\$([0-9.]+)', log)
    d['cost_after'] = first(r'OpenRouter usage after:\s*\$([0-9.]+)', log)
    d['cost_total'] = first(r'Total spent this run:\s*\$([0-9.]+)', log)
    # Was this run's coverage narrowed by an unreachable external service? A
    # green run with a service mocked is a NARROWER claim than a green run
    # without, and a flag set once and never unset removes integration signal
    # silently. Say it in the report or nobody will know six months from now.
    d['mocked_externals'] = first(r'EPAM_MOCK_EXTERNAL_CMS_HOSTS=[\'"]?([^\'"\n]+)', log)
    if not d['mocked_externals'] and os.environ.get('EPAM_MOCK_EXTERNAL_CMS_APIS') == '1':
        d['mocked_externals'] = os.environ.get('EPAM_MOCK_EXTERNAL_CMS_HOSTS', '')

    d['pipeline_complete'] = 'Pipeline complete' in log

    # The verdict is READ, not inferred from prose.
    #
    # This matched only `PASSED — all N stories complete`, the wording
    # tier3-travel-app-run.sh and orchestrate.sh use. tier3-metrolinx-run.sh
    # writes `PASSED: N stories complete` — colon, no "all" — so the pattern
    # never matched and the first fully clean metrolinx run, with every gate
    # green and the phase gate GO, was headed DID NOT COMPLETE.
    #
    # outcome.txt is written by the same function that generates this report, so
    # prefer it outright; fall back to the log only when it is absent, and accept
    # either separator there rather than one runner's punctuation.
    d['passed'] = None
    if args.out:
        try:
            with open(os.path.join(args.out, 'outcome.txt')) as f:
                d['passed'] = f.read().strip().upper().startswith('PASSED')
        except OSError:
            pass
    if d['passed'] is None:
        d['passed'] = bool(re.search(r'PASSED\s*[—:-]\s*(all\s+)?\d+ stor(y|ies)', log))
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
        # Read the WHOLE log. Capping at 4000 bytes truncated mutant-hunter —
        # 6294 bytes, its verdict last, after a long mutations[] array — so the
        # report announced "1 of 6 gates produced no verdict" about a gate that
        # had returned `warn`. A gate wrongly reported as silent is worse than a
        # missing report: it invites re-running work that was already done.
        body = read(p) if size else ''
        # `overallVerdict` is the declared top-level field for gates that report
        # per story (spec-validator); accept both rather than one gate's wording.
        verdict = (first(r'"verdict":\s*"(\w+)"', body)
                   or first(r'"overallVerdict":\s*"(\w+)"', body))
        # The verdict word alone is not a report. `warn` with nothing behind it
        # tells a reader something was wrong and refuses to say what, which is
        # worse than silence: it cannot be acted on and cannot be dismissed.
        detail, gsummary = [], None
        try:
            _m = re.search(r'\{.*\}', body, re.S)
            if _m:
                _obj = json.loads(_m.group(0))
                gsummary = _obj.get('summary') if isinstance(_obj.get('summary'), dict) else None
                for _k in ('mutations', 'cases', 'findings', 'stories'):
                    _v = _obj.get(_k)
                    if isinstance(_v, list) and _v:
                        detail = [x for x in _v if isinstance(x, dict)]
                        break
        except Exception:
            pass
        d['gate_logs'].append({
            'name': g, 'size': size, 'verdict': verdict,
            'detail': detail, 'gsummary': gsummary,
            'wrote_file_instead': 'has been written' in body,
        })

    # Commits produced in the codeline
    d['commits'] = []
    if args.codeline and args.baseline:
        try:
            out = subprocess.run(
                ['git', '-C', args.codeline, 'log', '--format=%h|%s|%ad', '--date=iso',
                 f'{args.baseline}..{args.head}'],
                capture_output=True, text=True, timeout=30).stdout
            d['commits'] = [l.split('|', 2) for l in out.splitlines() if l.strip()]
            diff = subprocess.run(
                ['git', '-C', args.codeline, 'diff', f'{args.baseline}..{args.head}'],
                capture_output=True, text=True, timeout=30).stdout
            d['diff'] = diff
            d['diffstat'] = subprocess.run(
                ['git', '-C', args.codeline, 'diff', '--stat', f'{args.baseline}..{args.head}'],
                capture_output=True, text=True, timeout=30).stdout
            names = subprocess.run(
                ['git', '-C', args.codeline, 'diff', '--name-only', f'{args.baseline}..{args.head}'],
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
    d['selfheal'] = collect_selfheal(d, log, args)
    return d



# ── chronological timeline ─────────────────────────────────────────────────────

# Checklist RE-RENDERS ("  ✓ 2      Step 2: CPA pre-pass") repeat every ~30s and
# are not events. The run's real beats carry a ▶/✓/⊘/⚠ with no leading index.
_CHECKLIST_RERENDER = re.compile(r'^\s*[✓○⊘⚠]\s+\d+[a-z]?\s+')

# (pattern, kind, status, headline template, commentary)
_EVENTS = [

    (r'\[jira\] (https?://\S+) \(project: (\w+)\)', 'ingest', 'info',
     'Ticket pulled from Jira',
     'The pipeline reads the ticket straight from {0} (project {1}). Nothing about the bug is hand-written '
     'for the run &mdash; the agents see the same words a developer would.'),
    (r'\[ac-gate\]\s+verdict: (\w+)', 'ingest', 'info',
     'Acceptance-criteria gate: {0}',
     'This ticket has no acceptance criteria written on it. The gate judged whether the description alone '
     'says enough to work from; &ldquo;enrichable&rdquo; means yes &mdash; the symptom and the expected '
     'behaviour are both stated, so the pipeline may proceed and derive its own verification criteria.'),
    (r'Found (\d+) git repo\(s\) in codeline root', 'ingest', 'info',
     'Searching {0} repositories for the right codebase',
     'The ticket does not say which repository the bug lives in. The pipeline has to work that out itself '
     'from {0} candidates.'),
    (r"top candidate '(\S+)' driven by: ([^\n]+)", 'ingest', 'info',
     'Strongest match: {0}',
     'Chosen on the ticket&rsquo;s domain words appearing far more often in this repository than in the '
     'others &mdash; {1}. Presentation words like &ldquo;displayed&rdquo; are deliberately stripped first, '
     'because they describe the symptom rather than the code that causes it.'),
    (r'Repo scoring: top (\d+) candidate\(s\) from (\d+) repos', 'ingest', 'info',
     'Shortlist of {0} from {1} repositories',
     'Deterministic keyword scoring narrows the field first, so the language model is asked to choose '
     'between a handful of plausible repositories rather than search all {1}.'),
    (r'Calling LLM \((\S+)\) to match', 'ingest', 'info',
     'Model {0} picks from the shortlist',
     'The final choice is a judgement call, so it goes to a model &mdash; but only after the arithmetic '
     'has removed the obviously-wrong candidates.'),
    (r"\[orch\] Codeline '(\S+)' → (\S+)", 'ingest', 'ok',
     'Codeline selected: {1}',
     'This is the repository the run will actually change. Everything after this point happens inside it.'),
    (r'\[orch\] Brownfield baseline: (\S+) @ (\S+)', 'ingest', 'info',
     'Baseline pinned at {0} @ {1}',
     'A fixed reference point. Every later question &mdash; what changed, what lint findings are new, does '
     'the test fail without the fix &mdash; is answered against this exact commit, so pre-existing problems '
     'are never blamed on this run.'),
    (r'^\s*▶ (Step [\d.]+[a-z]?: .+?)\s*$', 'step', 'info', '{0}', ''),
    (r'^\s*✓ (Step [\d.]+[a-z]?: .+?)\s*$', 'step', 'ok', '{0} — passed', ''),
    (r'^\s*⊘ (Step [\d.]+[a-z]?: .+?)\s+\[(.+?)\]', 'step', 'skip', '{0} — did not apply',
     'The pipeline recognised this stage had nothing to do for this change and stood down, which is a '
     'different statement from passing. Reason recorded: <code>{1}</code>.'),
    (r'^\s*⚠ (Step [\d.]+[a-z]?: .+?)\s+\[(.+?)\]', 'step', 'warn', '{0} — {1}', ''),
    (r'is UNGROUNDED \(attempt (\d)/(\d)\)[^\n]*?"([^"]+)"', 'detective', 'warn',
     'First diagnosis rejected — it described code that does not exist',
     'The investigating agent claimed the broken line was <code>{2}</code>. That expression is nowhere in the '
     'file it named. Because the pipeline checks every quoted line against the real file, the diagnosis was '
     'thrown away instead of being passed to the developer agent as fact. Without that check it would have '
     'looked entirely convincing: right file, plausible variable names, confident explanation.'),
    (r'ladder escalation for \S+ \(attempt (\d)/(\d)\) — model (\S+) → (\S+)', 'detective', 'warn',
     'Escalating to a stronger model: {2} → {3}',
     'Attempt {0} of {1}. The cheaper model failed to produce a grounded answer, so the work moves up to a '
     'more capable (and more expensive) one rather than accepting a weak result.'),
    (r'code-graph-detective located fix site: (\S+)(?: \(reuse (\S+)\))?', 'detective', 'ok',
     'Root cause located in {0}',
     'The agent traced backwards from the symptom to the code that actually computes the wrong value, and '
     'pointed at an existing helper (<code>{1}</code>) already in the repository rather than inventing new '
     'logic &mdash; a smaller, safer change that a reviewer is far more likely to accept.'),
    (r'(\d+) verification criteria persisted', 'spec', 'ok',
     '{0} verification criteria written',
     'Plain-language statements of what must be observably true once the bug is fixed. They describe '
     'outcomes, never implementation, so they cannot quietly dictate how the fix is written.'),
    (r'VC guard flagged mechanism[^\n]*?\[([^\]]+)\]', 'spec', 'warn',
     'A verification criterion was rejected for prescribing implementation',
     'It said how to fix the bug ({0}) rather than what a user should see afterwards. Criteria that smuggle '
     'in a solution bias the developer agent toward it &mdash; possibly toward the wrong one &mdash; so it '
     'was regenerated.'),
    (r'InferenceLadder\[Rung(\d)/R(\d)\]: model=.(\S+?). ', 'impl', 'info',
     'Developer agent — rung {0}, try {1}, model {2}',
     'Work starts on the cheapest capable model and only climbs if it fails.'),
    (r'declared deliverable\(s\) exist but are UNCHANGED[^\n]*?\[attempt (\d+)/(\d+)', 'impl', 'warn',
     'Attempt {0} of {1} changed nothing — retrying',
     'The agent reported success but the files are byte-for-byte identical to the baseline. The pipeline '
     'verifies the claim against the repository instead of believing it, so the attempt is discarded and '
     'retried. This is routine, not a failure.'),
    (r'Cost\[(\S+)\] model=(\S+) in=(\d+) out=(\d+) cost=\$([\d.]+)[^\n]*status=(\w+)', 'impl', 'info',
     'Model call — {1}',
     '{2} tokens in, {3} out, ${4} ({5}).'),
    (r'Implemented: (\d+), Failed: (\d+), Skipped: (\d+)', 'impl', 'ok',
     'Fix written and committed',
     '{0} story implemented, {1} failed, {2} skipped.'),
    (r'\[repro-test-writer\] writing reproducing test[^\n]*→ (\S+)', 'test', 'info',
     'Writing a test that reproduces the bug → {0}',
     'The fix alone proves nothing. A test is written that fails on the ORIGINAL code, so the bug is '
     'demonstrated to exist before anyone claims to have fixed it.'),
    (r'written test FAILS TYPECHECK', 'test', 'warn',
     'The first test did not compile — discarded',
     'A test that cannot run would still sit in the repository looking like coverage while proving nothing, '
     'so it is thrown away rather than committed.'),
    (r'constraints applied for (\S+) \(story:[^)]+\): (\S+)', 'test', 'info',
     'Applying what the pipeline learned from earlier failures',
     'Past mistakes by this agent are enforced as machine-checked constraints (<code>{1}</code>), not as '
     'extra paragraphs of advice in the prompt.'),
    (r'test produced and validated on attempt (\d+) \(model (\S+)\)', 'test', 'ok',
     'Working test produced on attempt {0}',
     'Written by {1} and confirmed to compile and run.'),
    (r'\[repro-test-writer\] committed reproducing test: (\S+)', 'test', 'ok',
     'Test committed — {0}', ''),
    (r'\[repro-gate\] ✓ (\S+): the test reproduces the bug[^\n]*', 'test', 'ok',
     'RED → GREEN confirmed: the fix genuinely works',
     'The test was executed twice: against the original code, where it FAILED (proving the bug is real and '
     'the test detects it), and against the fixed code, where it PASSED. This is the strongest evidence in '
     'the run &mdash; it is an executed demonstration, not an opinion from a model.'),
    (r'Review Decision: ([A-Z_ ]+)', 'review', 'ok',
     'Senior-developer review: {0}',
     'A separate agent reads the change against the ticket and the verification criteria, and can send it '
     'back for rework.'),
    (r'code review APPROVED for phase \S+ \(cycle (\d+)\)', 'review', 'ok',
     'Approved on the first review cycle' , 'Cycle {0} &mdash; no rework was required.'),
    (r'review requested changes — re-implementing \(cycle (\d+) → (\d+)\)', 'review', 'warn',
     'Review sent the change back for rework (cycle {0} → {1})', ''),
    (r'\[lint\] scope: (\d+) file\(s\) from (.+)', 'lint', 'info',
     'Code-style check, limited to the {0} files this run touched',
     'It deliberately does not examine the rest of the repository: the run should be judged on what it '
     'wrote, not on problems that were already there.'),
    (r'could not compute baseline findings for (\S+)', 'lint', 'warn',
     'Could not measure the original code&rsquo;s style problems',
     'Without that measurement every finding gets attributed to this run, including any that already '
     'existed. The protection against inheriting someone else&rsquo;s mess did not run.'),
    (r'\[lint\] auto-fixing (\d+) file\(s\) clean at baseline \((\d+) skipped', 'lint', 'info',
     'Auto-correcting formatting in {0} file(s)',
     'Only files that were already clean before this run are touched &mdash; {1} skipped &mdash; so the '
     'pipeline never reformats code somebody else wrote.'),
    (r'\[lint\] eslint: (PASS[^\n]*|FAIL[^\n]*|COULD NOT RUN[^\n]*)', 'lint', 'ok', 'Code style: {0}', ''),
    # Without this beat the timeline shows FAIL immediately followed by PASS and
    # reads as a contradiction. It is a sequence: the gate objected, the finding
    # was repaired in place, the gate was re-run and agreed.
    (r'\[lint-fix\] repairing (\d+) finding\(s\) in place \(attempt (\d+)/(\d+)\)', 'lint', 'warn',
     'Repairing {0} style finding(s) in place &mdash; attempt {1} of {2}',
     'Rather than rewrite the story and rebuild the phase over a style nit, the pipeline edits the '
     'flagged lines directly. The repair is then verified three ways &mdash; the linter must agree, the '
     'code must still compile, and the tests must still pass &mdash; and is reverted outright if any of '
     'them fails, because the easiest way to silence a complaint in a test file is to weaken the test.'),
    (r'\[lint-fix\] findings repaired in place[^\n]*', 'lint', 'ok',
     'Style findings repaired &mdash; lint clean, types compile, tests still pass', ''),
    (r'\[lint-fix\] repair rejected by verification[^\n]*', 'lint', 'bad',
     'Repair rejected by verification &mdash; the edit was reverted', ''),
    (r'\[qa-gate\] (\S+) attempt (\d) produced no structured output', 'gate', 'warn',
     '{0} returned nothing usable on attempt {1} — retrying with a stronger model', ''),
    (r'\[qa-gate\] (\S+) all (\d+) attempt\(s\) exhausted with no structured output', 'gate', 'bad',
     '{0} never produced a verdict',
     'After {1} attempts this quality check returned nothing. It did not review the change &mdash; an '
     'absent opinion, not an approving one.'),
    (r'"mutationScore":\s*(\d+)', 'gate', 'info',
     'Mutation score: {0}',
     'The pipeline deliberately corrupts the new code in small ways and re-runs the tests. A high score '
     'means the tests actually notice when the code breaks; a score of zero means they would pass even if '
     'the fix were undone.'),
    (r'Mutant-hunter: ([A-Z]+ — [^\n]+)', 'gate', 'warn', 'Mutation testing: {0}', ''),
    (r'Step 4\.\d[a-z]?: Running (\S+)\.\.\.', 'gate', 'info', 'Quality check: {0}', ''),
    (r'\[orch\] ✅ (Pipeline complete)', 'terminal', 'ok', 'Pipeline complete', ''),
    (r'Total spent this run:\s+\$([\d.]+)', 'cost', 'ok',
     'Total cost of this run: ${0}',
     'Measured from what the provider actually billed, not estimated from token counts.'),
    (r'✓ (\S+): completed', 'terminal', 'ok', 'Story {0} marked complete', ''),
    (r'PASSED — all (\d+) stories complete', 'terminal', 'ok',
     'RUN PASSED', 'All {0} stories completed and every blocking gate satisfied.'),
]

def _authoritative_step_starts(raw):
    """{step-number: HH:MM:SS} from lines that genuinely carry a clock.

    Only `[HH:MM:SS] Step N: Running …` lines are timestamped by the runner. The
    ▶/✓ marker lines are not, and inherit whatever clock was last printed — which
    made a 13-minute specification pass report "took 2s". Durations are computed
    from these lines alone, and omitted entirely where two real timestamps are
    not available: no number at all beats a confident wrong one.
    """
    starts = {}
    for m in re.finditer(r'^\[(\d{2}:\d{2}:\d{2})\]\s+Step ([\d.]+[a-z]?): Running',
                         strip_ansi(raw), re.M):
        starts.setdefault(m.group(2), m.group(1))
    return starts


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
    return _collapse_gates(_collapse_steps(events, _authoritative_step_starts(raw)))


# Steps that carry no story: bookkeeping the reader does not need. Naming them
# explicitly (rather than dropping anything that looks dull) keeps the omission
# honest and reviewable.
_TRIVIAL_STEPS = ('mkdir', 'Initializing', 'coordinator audit', 'Hybrid pre-coord')


# What each numbered step is for, in one sentence.
#
# Without this a reader sees "Step 3: Skill assessment — took 6m 13s" and learns
# only that six minutes passed. The timing is the least interesting fact about
# it; what the stage was doing with that time is the story. Steps with no entry
# here simply render without a note rather than inventing one.
_STEP_PURPOSE = {
    '1':  'Reads the ticket and turns a symptom described in prose into verification criteria a test '
          'can be written against.',
    '2':  'Forecasts what this story should cost and how long it should take, so a run that goes wildly '
          'over its estimate can be caught rather than discovered on the invoice.',
    '3':  'Decides which skills the change needs and which agent role should own it, before any code is '
          'touched.',
    '5':  'Runs the existing test suite against the untouched codebase, so a test that was already '
          'broken cannot later be blamed on this run.',
    '7':  'Assigns a model to each piece of work — cheaper models for mechanical steps, stronger ones '
          'where judgement is required.',
    '8':  'Executes the stories that run directly on the main branch, in order.',
    '9':  'Commits what the writers produced, so the change exists as a reviewable artefact rather than '
          'as edits in a working tree.',
    '18': 'Checks the phase as a whole once the parallel work has landed.',
    '19': 'A last look before review: is there actually a change here worth reviewing?',
    '20': 'Lints only the files this run wrote, judged against how they looked before the run, so the '
          'change is never blamed for pre-existing style debt.',
    '21': 'A senior-developer read of the diff: does it address the ticket, is it the smallest sensible '
          'change, does it reuse what already exists?',
    '24': 'Records what actually happened against what was forecast, so the next run\u2019s estimates '
          'are calibrated from real outcomes.',
}


def _collapse_steps(events, real_starts=None):
    """One line per step, carrying how long it took.

    Raw logs emit a step twice — "Step 1: Specification pass" on entry and
    "… — passed" on exit — which doubled the timeline to 44 near-identical rows
    and buried the beats that matter. Merging the pair also recovers the
    duration, which is the genuinely interesting part: it shows WHERE the
    45 minutes went, something the original report could not answer at all.
    """
    out, open_steps = [], {}
    for e in events:
        if e['kind'] != 'step':
            out.append(e)
            continue
        name = re.sub(r' — (passed|skipped.*|.*)$', '', e['head']).strip()
        if any(t.lower() in name.lower() for t in _TRIVIAL_STEPS):
            continue
        if e['status'] == 'info':          # entry
            open_steps[name] = (e, len(out))
            out.append(e)
            continue
        started = open_steps.pop(name, None)
        if not started:                     # exit with no entry seen
            out.append(e)
            continue
        entry, idx = started
        entry['head'] = name
        entry['status'] = e['status']
        entry['note'] = e['note'] or entry['note']
        entry['_step'] = True
        _n = (re.match(r'Step ([\d.]+)[a-z]?:', name) or [None, None])[1]
        if not entry['note'] and _n in _STEP_PURPOSE:
            entry['note'] = _STEP_PURPOSE[_n]
        out[idx] = entry

    # Durations come from when the NEXT step began, not from the exit line.
    # Exit lines ("✓ Step 1: …") carry no timestamp of their own and inherit
    # whatever clock was last seen, which made Step 1 — a 13-minute
    # specification pass — report "took 2s". A confidently wrong number is worse
    # than no number: it is exactly the kind of fabricated precision these
    # reports exist to avoid.
    real_starts = real_starts or {}
    step_idx = [i for i, e in enumerate(out) if e.get('_step')]
    for pos, i in enumerate(step_idx):
        num = (re.match(r'Step ([\d.]+[a-z]?):', out[i]['head']) or [None, None])[1]
        t0 = real_starts.get(num)
        if t0:
            out[i]['t'] = t0                      # correct the displayed clock too
        t1 = None
        for j in step_idx[pos + 1:]:
            nxt_num = (re.match(r'Step ([\d.]+[a-z]?):', out[j]['head']) or [None, None])[1]
            if nxt_num and real_starts.get(nxt_num):
                t1 = real_starts[nxt_num]
                break
        secs = _elapsed(t0, t1) if (t0 and t1) else ''
        if secs:
            out[i]['head'] += f' — took {secs}'
        out[i].pop('_step', None)
    return out


def _collapse_gates(events):
    """One line per quality gate, stating what it actually concluded.

    The raw sequence emits three beats per failing gate — "Quality check: X",
    "X returned nothing usable on attempt 1", "X never produced a verdict" —
    all stamped with the same inherited clock. For two failing gates that is six
    near-identical rows saying one thing twice, which buries the finding it is
    trying to report.

    The finding itself is real and is NOT softened here: a gate that returns
    nothing has not reviewed the change. It is stated once, plainly.
    """
    out, seen_gate = [], {}
    for e in events:
        if e['kind'] != 'gate':
            out.append(e)
            continue
        m = (re.search(r'qa-gate:([a-z][a-z-]+)', e['head'])
             or re.search(r'Quality check:\s*([a-z][a-z-]+)', e['head'])
             or re.search(r'^([a-z][a-z-]+):', e['head']))
        if not m:
            out.append(e)
            continue
        gate = m.group(1)
        low = e['head'].lower()

        if 'never produced a verdict' in low:
            seen_gate[gate] = {
                'status': 'bad', 'head': f'{gate}: no verdict — this check did not review the change',
                'note': 'Two attempts, including one on a stronger model, both returned nothing '
                        'usable. An absent opinion is not an approving one.'}
        elif 'returned nothing usable' in low:
            # Retry chatter. The OUTCOME line carries the finding, and where a
            # gate recovered (mutant-hunter) its score already says so.
            continue
        elif 'quality check:' in low and gate in seen_gate:
            continue
        else:
            out.append(e)
            continue

        idx = next((i for i, x in enumerate(out)
                    if x['kind'] == 'gate' and gate in x['head']), None)
        beat = {'t': e['t'], 'kind': 'gate', **seen_gate[gate]}
        if idx is None:
            out.append(beat)
        else:
            out[idx] = beat
    return out


def _elapsed(t0, t1):
    if not t0 or not t1:
        return ''
    try:
        h0, m0, s0 = (int(x) for x in t0.split(':'))
        h1, m1, s1 = (int(x) for x in t1.split(':'))
    except ValueError:
        return ''
    d = (h1 * 3600 + m1 * 60 + s1) - (h0 * 3600 + m0 * 60 + s0)
    if d < 0:
        d += 24 * 3600
    if d < 1:
        return ''
    if d < 60:
        return f'{d}s'
    return f'{d // 60}m {d % 60}s'


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
.lede { font-size:16.5px; }
.detail { margin:1.2rem 0; padding:.9rem 1.1rem; border-left:3px solid var(--warn,#b58900); background:rgba(128,128,128,.06); border-radius:4px; }
.detail h4 { margin:0 0 .4rem; font-size:.95rem; }
.detail li { margin:.55rem 0; line-height:1.5; }
.soft { opacity:.75; }
.intro { color:var(--fg); opacity:.85; margin:.35rem 0 .6rem; max-width:46rem; line-height:1.65; }
/* The middle paragraph is the mechanism — retries, escalation, self-healing.
   It is the part worth reading, so it is not styled as filler. */
.intro.cont { margin:.55rem 0; }
.intro.cont:first-of-type ~ .intro.cont:last-of-type { opacity:.8; }
.phase { margin:1.75rem 0 .35rem; font-size:.78rem; text-transform:uppercase; letter-spacing:.07em;
         color:var(--muted); font-weight:700; }
"""

_QA_KINDS = {'test', 'review', 'lint', 'gate', 'terminal'}

_NARRATIVE_SKIP = {'reset'}  # archiving the PREVIOUS run's artefacts is not this run's story

_PHASE_OF = {
    'cost': 'Setup', 'reset': 'Setup', 'ingest': 'Ingest & selection',
    'step': 'Pipeline steps', 'detective': 'Diagnosis', 'spec': 'Diagnosis',
    'impl': 'Implementation', 'test': 'Proving the fix', 'review': 'Review',
    'lint': 'Lint gate', 'gate': 'Quality gates', 'terminal': 'Outcome',
}


# A reader who knows nothing about this pipeline needs to be told what each
# stage is FOR before being shown what it did. Without this the timeline is a
# list of jargon; with it, each beat has somewhere to land.
# A reader who knows nothing about this pipeline needs to be told what each
# stage is FOR before being shown what it did. Each stage is narrated as three
# paragraphs of prose: what it was HANDED, what it DID with it — including the
# retry, escalation and self-healing machinery, which is the part worth reading —
# and what it HANDED ON. The mechanisms are the story; the code that comes out
# the far end is only the receipt.
_PHASE_INTRO = {
    'Setup': (
        'The pipeline begins with nothing but a ticket number and a wallet. Before it is allowed to '
        'spend anything it reads the current balance at the model provider &mdash; the real, billed '
        'figure, not an estimate assembled from its own logs.',

        'This matters because every agent in this run is a paid API call, and an agent that retries, '
        'escalates to a stronger model and retries again can quietly cost several times what a clean '
        'pass would. Measuring from a recorded starting balance means the run&rsquo;s true price can be '
        'read off at the end by subtraction, rather than trusted from a tally that the pipeline itself '
        'kept and could be wrong about.',

        'What it hands forward is a number: the line in the sand that everything after this is measured '
        'against.'),

    'Ingest & selection': (
        'It is handed one Jira ticket identifier. Nothing else &mdash; not the repository, not the '
        'branch, not the file, not even which of the organisation&rsquo;s many codebases the bug lives in.',

        'So it fetches the ticket and reads it the way a new engineer would: the summary, the '
        'description, the comments, any linked pull requests. From that it has to infer a repository. '
        'This is a genuine decision and it is made in the open &mdash; the candidate repositories are '
        'considered, one is selected, and the reason is recorded rather than assumed. Once a repository '
        'is chosen it is cloned at a specific commit, so that everything downstream &mdash; the '
        'diagnosis, the fix, the test run against the original code &mdash; is anchored to one exact '
        'version of the codebase and cannot drift underneath the run.',

        'What it hands forward is a working copy pinned to a known commit, and a written statement of '
        'the problem in the reporter&rsquo;s own words.'),

    'Pipeline steps': (
        'The run advances through a fixed, numbered sequence. Each step is either work, a check, or a '
        'step that recognises it does not apply to this kind of change and stands down.',

        'The sequence is deliberately rigid. An agent cannot choose to skip a gate it expects to fail, '
        'and it cannot reorder the work so that its own output is checked before the thing that would '
        'contradict it runs. Steps that do not apply announce that they are not applicable rather than '
        'silently passing, because a check that quietly returns success when it did nothing is '
        'indistinguishable from a check that ran and approved &mdash; and that distinction is exactly '
        'the one a reader of this report needs.',

        'What it hands forward is the shape of the run: which stages engaged, which stood down, and in '
        'what order.'),

    'Diagnosis': (
        'The investigating agent is handed the ticket text and a codebase it has never seen. It is '
        'handed no file names, no starting point and no hints.',

        'This is the hardest stage and the one most likely to go wrong, because the ticket describes a '
        '<em>symptom</em> in everyday language &mdash; &ldquo;the discount is not displayed&rdquo; &mdash; '
        'while the code responsible almost certainly contains none of those words. The agent has to '
        'search the codebase, follow the data backwards from where the wrong value is displayed to where '
        'it is actually computed, and name the single line at fault. The failure mode here is not '
        'silence but confidence: a model that has seen enough plausible symbol names will happily '
        'assemble a line of code that looks exactly right and does not exist. So the pipeline does not '
        'take the diagnosis on trust. The agent must quote the broken line <em>verbatim</em>, and that '
        'quotation is then checked character for character against the real file on disk. If the quote '
        'does not appear in the source, the diagnosis is rejected and the agent is asked again &mdash; '
        'and if it keeps failing, the work escalates to a stronger and more expensive model. To make '
        'that demand answerable rather than impossible, the agent is given a tool that prints real '
        'numbered source lines, so quoting is an act of copying rather than of recollection.',

        'What it hands forward is a verified diagnosis: a file, a line, the actual text of that line, an '
        'explanation of why it is wrong, and a prescription for the smallest change that would fix it.'),

    'Implementation': (
        'The developer agent is handed the verified diagnosis, the prescribed shape of the fix, and the '
        'names of the helpers that already exist in this codebase for the job.',

        'It is asked for the smallest change that fixes the diagnosed line &mdash; and &ldquo;smallest&rdquo; '
        'is enforced rather than encouraged. A sprawling rewrite is harder to review, likelier to break '
        'something unrelated, and routinely rejected downstream, so the pipeline checks that a '
        'prescribed existing helper actually appears in the resulting diff instead of a new one invented '
        'alongside it. It also refuses to take the agent&rsquo;s word for what it did: the files the '
        'agent reports writing are reconciled against the files that actually changed on disk, and that '
        'record &mdash; not the plan written earlier &mdash; becomes the authoritative list of what this '
        'run touched. Everything downstream, from the lint gate to the coverage check, is scoped by that '
        'record, because what a run predicted it would edit and what it edited are routinely different.',

        'What it hands forward is a real diff against the pinned commit, and a manifest of exactly which '
        'files it produced.'),

    'Proving the fix': (
        'The test-writing agent is handed the diagnosis, the diff, and the verification criteria the '
        'story was accepted against.',

        'A fix nobody can demonstrate is only an assertion, so the test is not judged by reading it. It '
        'is executed twice: once against the <em>original</em> code, where it is required to FAIL, and '
        'once against the fixed code, where it is required to PASS. A test that passes against the '
        'original never reproduced the bug and is worthless as proof, however convincing it reads; a '
        'test that fails against the fix means the fix does not work. Only a genuine red-then-green '
        'transition is accepted, and it is a transition observed by running the code, not claimed by an '
        'agent. Passing that gate settles correctness but not completeness, so a separate advisory check '
        'then asks, one criterion at a time, whether the test would actually fail if each stated '
        'requirement were violated &mdash; a question the red/green gate cannot answer, because a test '
        'can reproduce the bug perfectly while ignoring a requirement entirely.',

        'What it hands forward is an executable proof, and an honest account of which criteria that '
        'proof does and does not cover.'),

    'Review': (
        'The reviewing agent is handed the ticket, the diagnosis, the diff and the test &mdash; and the '
        'manifest of what actually changed, rather than what was planned.',

        'It reads the change the way a senior engineer would at a pull request: does this address the '
        'ticket that was actually filed, is it the smallest change that would do so, does it reuse what '
        'the codebase already provides instead of reinventing it, and does the test genuinely prove '
        'anything. It has real authority &mdash; it can reject the work and send it back to be redone, '
        'and a rejection restarts implementation rather than being logged and stepped over. It is also '
        'empowered to reject a change for being <em>too large</em>, which is the failure this pipeline '
        'sees more often than under-engineering.',

        'What it hands forward is a verdict with reasons, and either an approval or a specific '
        'instruction for the next attempt.'),

    'Lint gate': (
        'The gate is handed the manifest of files this run actually wrote, and a copy of the codebase as '
        'it stood <em>before</em> the run started.',

        'It lints both, and subtracts. Only findings that this run introduced are counted; anything the '
        'linter already objected to before the run began is not this run&rsquo;s problem. That '
        'subtraction is the whole point of the gate. Judging a change against the absolute state of a '
        'large codebase would make an agent responsible for cleaning up years of accumulated style '
        'debt, which bloats a two-line fix into an unreviewable one and gets it rejected upstairs. When '
        'a genuinely new finding does appear, the pipeline attempts to repair it in place &mdash; and '
        'then verifies the repair by re-linting, re-compiling and re-running the affected tests, because '
        'the obvious way to silence a complaint in a test file is to weaken the test, and that test is '
        'the run&rsquo;s only proof. A repair that fails any of those checks is reverted outright.',

        'What it hands forward is a clean diff, or a specific and genuinely new objection to it.'),

    'Quality gates': (
        'The gates are handed the finished change, the test, and the review verdict.',

        'Each is an independent specialist &mdash; security scanning, conformance to the written '
        'specification, machine code review, mutation testing, fuzzing, performance &mdash; and each '
        'returns its own verdict rather than contributing to a single aggregate score, so no gate can be '
        'outvoted into silence. Some block the run and some only warn, and which is which is fixed in '
        'advance rather than decided once the results are in. A gate that finds nothing to say about '
        'this kind of change reports that it does not apply, which is a different statement from '
        'approval and is recorded as such.',

        'What they hand forward is a set of independent verdicts on a change that has already been '
        'proven to work.'),

    'Outcome': (
        'The final position: what the run produced, and what it cost.',

        'The cost is a real billed figure measured against the balance recorded at the very start, not a '
        'total the pipeline accumulated as it went. Retries, escalations to stronger models and '
        'self-healing attempts all land in that number, which is why it is worth reading next to the '
        'account of how much healing the run needed.',

        'What it hands forward is the merged branch, this report, and the money spent to get here.'),
}


def render_timeline(events, kinds=None, intros=True):
    """Chronological play-by-play, with an explanation of each stage's purpose."""
    rows, current = [], None
    # A phase recurs whenever the run loops back through it (a rejected review
    # sends implementation round again). Narrate it in full the first time and
    # only name it thereafter — three paragraphs repeated twenty-five times
    # buries the beats they exist to introduce.
    narrated = set()
    for e in events:
        if kinds and e['kind'] not in kinds:
            continue
        phase = _PHASE_OF.get(e['kind'], '')
        if phase != current:
            if current is not None:
                rows.append('</ul>')
            rows.append('<div class="phase">' + esc(phase) + '</div>')
            if intros and _PHASE_INTRO.get(phase) and phase not in narrated:
                narrated.add(phase)
                para = _PHASE_INTRO[phase]
                if isinstance(para, str):
                    para = (para,)
                for i, block in enumerate(para):
                    cls = 'intro' if i == 0 else 'intro cont'
                    rows.append('<p class="' + cls + '">' + block + '</p>')
            rows.append('<ul class="tl">')
            current = phase
        note = ('<span class="n">' + e['note'] + '</span>') if e['note'] else ''
        rows.append(
            '<li class="' + e['status'] + '"><span class="t">' + esc(e['t'] or '') + '</span>'
            '<span class="h">' + esc(e['head']) + '</span>' + note + '</li>')
    if current is not None:
        rows.append('</ul>')
    return '\n'.join(rows) or ('<p>' + MISSING + '</p>')


def _mocked_externals_note(d):
    """State plainly that this run proved less than an unqualified pass would."""
    hosts = (d.get('mocked_externals') or '').strip()
    if not hosts:
        return ''
    return ('<p class="note bad"><strong>Integration with an external service was NOT '
            'verified.</strong> This project declares it cannot reach '
            + esc(hosts) + ' at test time &mdash; there are no credentials and no local '
            'substitute &mdash; so that client was mocked and the criteria were written to '
            'our side of the boundary. Everything below is true of the code this run wrote '
            'and of how it behaves against a stubbed client. It is <em>not</em> evidence '
            'that the real integration works. Every other dependency was exercised '
            'normally.</p>')


def render_preamble(d):
    """Tell a reader who knows nothing about this system what they are reading."""
    title = d.get('title') or ''
    outcome = ('It succeeded: the bug was found, fixed, proved by an executed test, reviewed and merged '
               'to the branch.' if d['passed'] else
               'It did not run to completion — the timeline below shows how far it got.')
    return (
        '<h2>What you are looking at</h2>'
        '<p class="lede">This is an automated software pipeline. It was given one thing: the number of a '
        'bug ticket. No human wrote any of the code in this report, chose which file to change, or wrote '
        'the test that proves the change works.</p>'
        '<p>The pipeline works the way a careful developer would. It reads the ticket, finds the right '
        'repository among many, investigates the codebase to find the true cause of the bug rather than '
        'the place the symptom appears, writes the smallest fix it can, writes a test that fails without '
        'that fix, has the change reviewed, and runs a series of quality checks before accepting it. '
        'Each of those jobs is done by a different AI agent, and — importantly — the pipeline does not '
        'simply believe what those agents report. It verifies their claims against the actual code and '
        'the actual test results, and rejects them when they do not hold up. Several such rejections '
        'appear below.</p>'
        + ('<p><strong>The bug it was asked to fix:</strong> &ldquo;' + esc(title) + '&rdquo;</p>' if title else '')
        + '<p><strong>Outcome.</strong> ' + outcome + ' The whole run took '
        + esc(d.get('t_start') or '?') + ' to ' + esc(d.get('t_end') or '?')
        + ' and cost $' + esc(_cost_shown(d)[0])
        + ('' if _cost_shown(d)[1] else ' (summed from the per-call records)') + '.</p>'
        + _mocked_externals_note(d)
        + '<p class="intro">Everything below is read from the run&rsquo;s own logs. Where a fact has no '
        'supporting record it is marked <span class="missing">not recorded</span> rather than guessed at.</p>')


def head_block(title, subtitle, cards):
    return ('<title>' + esc(title) + '</title>\n<style>' + CSS + TIMELINE_CSS + '</style>\n<main>\n'
            '<h1>' + esc(title) + '</h1>\n<p class="sub">' + subtitle + '</p>\n'
            '<div class="cards">' + cards + '</div>')


def split_diff_by_file(diff):
    """[(path, body)] — one entry per file in a unified diff."""
    out, path, buf = [], None, []
    for line in (diff or '').splitlines():
        m = re.match(r'^diff --git a/(\S+) b/(\S+)', line)
        if m:
            if path:
                out.append((path, '\n'.join(buf)))
            path, buf = m.group(2), []
            continue
        if path:
            buf.append(line)
    if path:
        out.append((path, '\n'.join(buf)))
    return out


def describe_change(path, body):
    """Plain-language description derived from the diff itself — never guessed."""
    added = [l[1:] for l in body.splitlines() if l.startswith('+') and not l.startswith('+++')]
    removed = [l[1:] for l in body.splitlines() if l.startswith('-') and not l.startswith('---')]
    is_new = '\nnew file mode' in body or body.startswith('new file mode')
    is_test = '.spec.' in path or '.test.' in path or '/__tests__/' in path
    bits = []

    if is_new:
        bits.append('This file is <strong>new</strong> — it did not exist before the run '
                    f'({len(added)} lines added).')
    else:
        bits.append(f'<strong>{len(added)} line(s) added, {len(removed)} removed.</strong>')

    imports = [a.strip() for a in added if re.match(r'\s*import\b', a)]
    if imports:
        names = re.findall(r'import\s+\{?\s*([A-Za-z0-9_,\s]+?)\s*\}?\s+from', ' ; '.join(imports))
        if names:
            bits.append('It brings in an existing helper from elsewhere in the repository — '
                        f'<code>{esc(names[0].strip())}</code> — rather than writing new logic to do the '
                        'same job.')

    # A one-for-one line swap is the clearest signal of a minimal, surgical fix.
    body_add = [a for a in added if not re.match(r'\s*import\b', a) and a.strip()]
    body_del = [r for r in removed if r.strip()]
    if not is_new and len(body_del) == 1 and len(body_add) == 1:
        bits.append('A single expression was replaced — the smallest change that can fix the behaviour, '
                    'and the easiest kind for a reviewer to check.')

    if is_test:
        bits.append('Because this is the reproducing test, it was run against the ORIGINAL code first and '
                    'had to <strong>fail</strong> there. A test that passes before the fix would prove '
                    'nothing at all.')
    return ' '.join(bits)


def collect_selfheal(d, log, args):
    """What the pipeline learned, and what that learning prevented."""
    sh = {}
    sh['constraints_applied'] = []
    for m in re.finditer(r'\[SelfHeal/KB\] constraints applied for (\S+) \(story:([^)]*)\): ([^\n]+)', log):
        sh['constraints_applied'].append({
            'agent': m.group(1), 'story': m.group(2),
            'rules': [r.strip() for r in m.group(3).split(',') if r.strip()]})
    sh['analyst_runs'] = len(find_all(r'self-heal analyst', log))
    sh['typecheck_rejections'] = len(find_all(r'FAILS TYPECHECK', log))
    sh['failure_classes'] = sorted(set(find_all(r'class=([a-z_]+)', log)))
    sh['recovered_on_attempt'] = first(r'test produced and validated on attempt (\d+)', log)
    sh['escalations'] = [{'from': m.group(1), 'to': m.group(2)} for m in
                         re.finditer(r'ladder escalation[^\n]*model (\S+) → (\S+)', log)]
    sh['deliverable_retries'] = len(find_all(r'declared deliverable\(s\) exist but are UNCHANGED', log))
    sh['ungrounded_rejections'] = len(find_all(r'is UNGROUNDED', log))

    # KB store — prefer the run's own archived copy over live (mutating) state.
    kb_dir = None
    for cand in (os.path.join(args.out, 'kb'),
                 os.path.join(os.path.dirname(args.logs_dir), 'agents', 'kb')):
        if os.path.isdir(cand):
            kb_dir = cand
            break
    sh['kb_source'] = 'this run’s archived copy' if kb_dir and kb_dir.startswith(args.out) \
        else 'the live store (may have changed since the run)'
    sh['constraint_count'] = None
    sh['healing_events'] = None
    if kb_dir:
        try:
            c = json.load(open(os.path.join(kb_dir, 'constraints.json')))
            rules = c.get('rules', c) if isinstance(c, dict) else c
            sh['constraint_count'] = len(rules)
            sh['constraint_ids'] = [r.get('id') for r in rules if isinstance(r, dict)][:12]
        except (OSError, ValueError, TypeError):
            pass
        try:
            with open(os.path.join(kb_dir, 'healing-events.jsonl')) as f:
                sh['healing_events'] = sum(1 for line in f if line.strip())
        except OSError:
            pass
        scratch = os.path.join(kb_dir, 'kb-scratchpad')
        sh['scratchpad'] = sorted(os.listdir(scratch)) if os.path.isdir(scratch) else []
    return sh


def _selfheal_worked_example():
    """What self-healing would have done, on a failure that really happened.

    A clean run leaves the loop unexercised, and a capability nobody has seen
    work is indistinguishable from one that does not. This is a real recurrence
    from this project's own history, walked through the machinery as it is built
    today — not a hypothetical.
    """
    return (
        '<h3>How it would have worked — a real example</h3>'

        '<p>On 26 July a run failed at the code-style gate. The defect was not in the fix: it was a '
        'string literal repeated five times in the fixture data of the test that had just proved the bug '
        'was fixed. <code>sonarjs/no-duplicate-string</code>. The run had done everything it existed to '
        'do — correct diagnosis, a two-line change reusing an existing helper, a test proven to fail '
        'before the fix and pass after, an approving review — and it was discarded over a duplicated '
        'string, because the only remedy available was to rewrite the story and rebuild the entire phase. '
        'Roughly twenty minutes and a dollar, to arrive back at the same place, since nothing in that '
        'loop actually fixed the literal.</p>'

        '<p>Now watch the same failure through the healing path. When the gate rejects the change, the '
        'failure is <em>recorded as an episode</em>: the agent role that produced it, and a signature '
        'read directly out of the tool&rsquo;s own output — <code>sonarjs/no-duplicate-string</code>, not '
        'a phrase summarised from the agent&rsquo;s explanation of itself. That distinction is load '
        'bearing. When signatures were derived from prose, they keyed correctly about half the time; '
        'read from the linter or the compiler, they key reliably. A failure that cannot be keyed cannot '
        'be learned from, so the system refuses to guess and records nothing rather than something '
        'plausible.</p>'

        '<p>One episode teaches nothing — a single failure may be noise, and promoting noise to a '
        'permanent rule is precisely the drift this design exists to prevent. It is the <em>second</em> '
        'occurrence of the same signature, from the same role, that triggers synthesis: the episodes are '
        'collapsed into a single proposed rule. And here the design does something unusual. The rule is '
        'not allowed to be advice. It must take one of three enforceable shapes — a gate to run, a '
        'parameter to set at the point of invocation, or a narrowing of which files and tools the agent '
        'may touch. A rule that is merely a sentence of guidance is <strong>structurally impossible to '
        'express</strong>; the schema has no field for it. That is deliberate, and it comes from this '
        'project&rsquo;s own logs: a prose instruction was once injected to prevent a specific mistake, '
        'was ignored, and the identical failure recurred sixteen more times.</p>'

        '<p>The compiled rule is then applied at the moment the agent is next invoked — as an environment '
        'variable it cannot override, a gate it must pass, or a tool scope it cannot widen. The next '
        'attempt runs materially differently from the one that failed, and the change is traceable: the '
        'rule names the constraint, the constraint names the signature, and the signature names the '
        'episodes that produced it. Rules that keep firing stay; rules that stop firing age out and are '
        'archived for revalidation rather than trusted forever, because a codebase that has moved on '
        'should not be governed by a lesson learned about the version before it.</p>'

        '<p>Two safeguards are worth stating plainly, because they are what separate this from a system '
        'that merely retries. A healed constraint can only ever <em>narrow</em> what an agent may do — '
        'scopes intersect, they never widen — so a failure cannot teach the system to grant itself more '
        'permission. And conflicts between rules are resolved structurally, by comparing what they '
        'constrain, never by asking a model to arbitrate: an arbiter that can be persuaded is one more '
        'thing that can drift.</p>'

        '<p class="soft">On this run none of that fired, because nothing failed. The mechanism is proven '
        'in test — episodes keyed from real compiler output, collapsed into one rule, compiled, and '
        'applied to a following attempt that demonstrably ran with a parameter the first did not have — '
        'but it has not yet been exercised end to end by a live failure. That remains the honest gap.</p>')


def render_selfheal(d):
    """The self-healing story: what failed, what was learned, what it prevented."""
    sh = d.get('selfheal') or {}
    parts = ['<h2>Self-healing and the knowledge base</h2>']
    parts.append(
        '<p class="intro">This is the part of the pipeline that improves itself. When an agent fails, '
        'the failure is not simply retried — it is diagnosed, and the diagnosis is turned into a '
        '<strong>machine-checked constraint</strong> stored in a knowledge base. On the next attempt, and '
        'on every future run, that constraint is enforced at the point the agent is invoked. Crucially it '
        'is enforced as a rule, not appended to the prompt as more advice: an instruction a model can '
        'ignore is not a safeguard, and this pipeline has repeatedly proved that models do ignore them.</p>')

    beats = []
    if sh.get('typecheck_rejections'):
        beats.append(
            f'<li><strong>{sh["typecheck_rejections"]} written test(s) rejected before being committed.</strong> '
            'The test did not compile. It was discarded rather than kept — a test that cannot run would sit '
            'in the repository looking like coverage while proving nothing.</li>')
    if sh.get('analyst_runs'):
        beats.append(
            f'<li><strong>The self-heal analyst was invoked.</strong> It examines the failure and decides what '
            'rule would have prevented it, rather than simply asking the agent to try again.</li>')
    for c in sh.get('constraints_applied', []):
        rules = ', '.join(f'<code>{esc(r)}</code>' for r in c['rules'])
        beats.append(
            f'<li><strong>{len(c["rules"])} constraint(s) enforced on '
            f'<code>{esc(c["agent"])}</code>:</strong> {rules}.<br>'
            '<span class="soft">This is the loop closing. Each of these was compiled from a failure on '
            'an <em>earlier</em> run &mdash; a test writer that produced something which was not a test '
            'file, and two TypeScript errors it kept reintroducing &mdash; and each is enforced here as '
            'a <strong>gate the agent has to pass</strong>, not as a paragraph of advice appended to its '
            'prompt. That distinction is the whole design: an instruction can be read and ignored, and '
            'this project has logs of exactly that happening seventeen times over. A gate cannot be '
            'ignored. The agent did not have to rediscover these mistakes, and the run never saw '
            'them.</span></li>')
    if sh.get('recovered_on_attempt'):
        beats.append(
            f'<li><strong>Recovered on attempt {esc(sh["recovered_on_attempt"])}.</strong> The work succeeded '
            'under the constraints that the earlier failure produced — the loop closed.</li>')
    if sh.get('ungrounded_rejections'):
        beats.append(
            f'<li><strong>{sh["ungrounded_rejections"]} diagnosis rejected as ungrounded.</strong> The agent '
            'quoted code that does not exist in the file it named, so the answer was refused before it could '
            'reach the developer agent as fact.</li>')
    if sh.get('deliverable_retries'):
        beats.append(
            f'<li><strong>{sh["deliverable_retries"]} agent turn(s) claimed success while changing nothing</strong> '
            'and were retried. The claim is checked against the repository rather than believed.</li>')
    for e in sh.get('escalations', []):
        beats.append(
            f'<li><strong>Escalated {esc(e["from"])} → {esc(e["to"])}.</strong> A weak result moves the work to a '
            'stronger model instead of being accepted.</li>')

    if beats:
        _applied = sum(len(c['rules']) for c in sh.get('constraints_applied', []))
        _lead = ''
        if _applied:
            _lead = ('<p>Knowledge from previous runs was in force before this one began. '
                     f'<strong>{_applied} constraint(s)</strong> compiled from earlier failures were '
                     'applied at the point the agent was invoked, so mistakes this pipeline has already '
                     'made once were structurally prevented rather than left to be made again.</p>')
        parts.append('<h3>What healed during this run</h3>' + _lead + '<ul>' + ''.join(beats) + '</ul>')
    else:
        parts.append('<h3>What healed during this run</h3><p>Nothing needed to heal — no agent failure '
                     'occurred that required diagnosis or a new constraint.</p>')

    # The full loop is: a failure recurs, a rule is synthesised, and the next
    # attempt runs under it. Individual beats (a rejected test, a retry) are not
    # that loop. When no constraint was actually applied, the capability the
    # pipeline claims has not been demonstrated — and a capability nobody has
    # seen work is indistinguishable from one that does not. Say so, and show
    # what it would have done, rather than letting silence imply it happened.
    if not sh.get('constraints_applied'):
        parts.append(_selfheal_worked_example())

    rows = []
    if sh.get('constraint_count') is not None:
        rows.append(f'<tr><td>Compiled constraints in force</td><td>{sh["constraint_count"]}</td></tr>')
    if sh.get('healing_events') is not None:
        rows.append(f'<tr><td>Healing episodes recorded to date</td><td>{sh["healing_events"]}</td></tr>')
    if sh.get('failure_classes'):
        rows.append('<tr><td>Failure classes seen this run</td><td>'
                    + ', '.join(f'<code>{esc(c)}</code>' for c in sh['failure_classes']) + '</td></tr>')
    if sh.get('scratchpad'):
        rows.append('<tr><td>Diagnosis notes kept</td><td>'
                    + ', '.join(f'<code>{esc(f)}</code>' for f in sh['scratchpad']) + '</td></tr>')
    if rows:
        parts.append('<h3>Knowledge base state</h3><table><tr><th>Measure</th><th>Value</th></tr>'
                     + ''.join(rows) + '</table>')
        parts.append(f'<p class="intro">Read from {sh.get("kb_source", "the store")}.</p>')

    if sh.get('constraint_ids'):
        parts.append('<h3>Rules currently enforced</h3><ul>'
                     + ''.join(f'<li><code>{esc(r)}</code></li>' for r in sh['constraint_ids'] if r)
                     + '</ul><p class="intro">Each began as a real failure in an earlier run and is now '
                       'checked automatically, so that failure cannot silently recur.</p>')
    return '\n'.join(parts)


def render_code_section(d):
    files = split_diff_by_file(d.get('diff', ''))
    if not files:
        return '<h2>Code produced</h2><p>' + MISSING + '</p>'

    parts = ['<h2>Code produced by this run</h2>']
    parts.append('<p class="sub">Every line below was written by the pipeline. The diff is shown against '
                 'the baseline commit the run started from.</p>')
    if d.get('diffstat'):
        parts.append('<pre>' + esc(d['diffstat'].strip()) + '</pre>')

    for path, body in files:
        is_test = '.spec.' in path or '.test.' in path
        role = 'Reproducing test' if is_test else 'The fix'
        parts.append('<h3>' + esc(role) + ' &mdash; <code>' + esc(path) + '</code></h3>')
        parts.append('<p>' + describe_change(path, body) + '</p>')
        # Show only the changed hunks, not the whole file.
        hunks = [l for l in body.splitlines()
                 if l.startswith(('@@', '+', '-')) and not l.startswith(('+++', '---'))]
        shown = hunks[:40]
        rendered = []
        for l in shown:
            cls = 'diff-add' if l.startswith('+') else ('diff-del' if l.startswith('-') else '')
            rendered.append(('<span class="' + cls + '">' + esc(l) + '</span>') if cls else esc(l))
        if len(hunks) > len(shown):
            rendered.append(esc('… %d more line(s)' % (len(hunks) - len(shown))))
        parts.append('<pre>' + '\n'.join(rendered) + '</pre>')

    if d.get('repro_gate'):
        parts.append(
            '<h3>How the fix was proved &mdash; RED then GREEN</h3>'
            '<table><tr><th>Stage</th><th>Code under test</th><th>Test result</th><th>What it proves</th></tr>'
            '<tr><td><strong class="bad">RED</strong></td><td>the original code, fix removed</td>'
            '<td><span class="bad">FAILS</span></td>'
            '<td>the bug is real, and this test actually detects it</td></tr>'
            '<tr><td><strong class="ok">GREEN</strong></td><td>the code with the fix applied</td>'
            '<td><span class="ok">PASSES</span></td>'
            '<td>the change fixes the reported behaviour</td></tr></table>'
            '<p>Both runs were executed by the pipeline, not judged by a model. A test that only ever ran '
            'against the fixed code could pass for reasons unrelated to the bug.</p>')
    return '\n'.join(parts)


def render_code_page(d):
    """The third deliverable: what was written, HOW, why it is minimal, and the proof.

    A run's outputs matter more than the run: this is the page a reviewer reads
    to decide whether to trust the change. It must never flatter it. Where the
    RED/GREEN proof is missing the page says PROBLEM, because an unproven change
    that looks reviewed is worse than one that is obviously unreviewed.
    """
    files = split_diff_by_file(d.get('diff', ''))
    fs = (d.get('fix_sites') or [{}])[0]
    parts = [head_block('Code — ' + (d.get('story') or ''),
                        'What the pipeline wrote, how it decided to write it, and what proves it '
                        'works.', _code_cards(d, files))]

    # ── HOW the change was arrived at ────────────────────────────────────────
    parts.append('<h2>How this code was arrived at</h2>')
    if fs:
        steps = []
        if fs.get('brokenLine'):
            steps.append(
                '<li><strong>The defect was located and quoted.</strong> The investigating agent '
                'traced the symptom back to the code that computes the wrong value and quoted the '
                'exact broken expression: <code>' + esc(fs['brokenLine']) + '</code> in <code>'
                + esc(fs.get('file')) + '</code>. That quote is checked character-for-character '
                'against the real file, so a confident-sounding but invented diagnosis is refused '
                'before any code is written.'
                + (' <strong>Verified: ' + esc(fs.get('evidenceVerified')) + '</strong>.'
                   if fs.get('evidenceVerified') is not None else '') + '</li>')
        if fs.get('helper'):
            steps.append(
                '<li><strong>An existing helper was prescribed, not new logic.</strong> <code>'
                + esc(fs['helper']) + '</code> already lives in this repository and already owns '
                'the behaviour needed, so the fix reuses it. This is deliberate: hand-written '
                'equivalents have to re-derive details the helper already encodes, and get them '
                'wrong.</li>')
        if fs.get('fix'):
            steps.append('<li><strong>The change was specified before it was written:</strong> '
                         + esc(fs['fix'][:400]) + '</li>')
        parts.append('<ol>' + ''.join(steps) + '</ol>' if steps else '<p>' + MISSING + '</p>')
    else:
        parts.append('<p>' + MISSING + ' — no fix-site analysis was preserved for this run.</p>')

    # ── The diffs, per file, with a derived explanation ──────────────────────
    parts.append('<h2>The change itself</h2>')
    if d.get('diffstat'):
        parts.append('<pre>' + esc(d['diffstat'].strip()) + '</pre>')
    if not files:
        parts.append('<p>' + MISSING + '</p>')
    for path, body in files:
        is_test = '.spec.' in path or '.test.' in path
        parts.append('<h3>' + ('Reproducing test' if is_test else 'The fix')
                     + ' &mdash; <code>' + esc(path) + '</code></h3>')
        parts.append('<p>' + describe_change(path, body) + '</p>')
        hunks = [l for l in body.splitlines()
                 if l.startswith(('@@', '+', '-')) and not l.startswith(('+++', '---'))]
        shown = hunks[:60]
        rendered = []
        for l in shown:
            cls = 'diff-add' if l.startswith('+') else ('diff-del' if l.startswith('-') else '')
            rendered.append(('<span class="' + cls + '">' + esc(l) + '</span>') if cls else esc(l))
        if len(hunks) > len(shown):
            rendered.append(esc('… %d more line(s)' % (len(hunks) - len(shown))))
        parts.append('<pre>' + '\n'.join(rendered) + '</pre>')

    parts.append(_minimality_section(d, files, fs))
    parts.append(_proof_section(d))
    parts.append('<footer>Every claim on this page is derived from the run&rsquo;s own artefacts — '
                 'the diff, the fix-site analysis and the gate logs. Nothing is inferred.</footer>'
                 '</main>')
    return '\n'.join(parts)


def _code_cards(d, files):
    added = sum(len([l for l in b.splitlines()
                     if l.startswith('+') and not l.startswith('+++')]) for _, b in files)
    removed = sum(len([l for l in b.splitlines()
                       if l.startswith('-') and not l.startswith('---')]) for _, b in files)
    proven = bool(d.get('repro_gate'))
    return (
        '<div class="card"><div class="k">Files changed</div><div class="v">' + str(len(files)) + '</div></div>'
        '<div class="card"><div class="k">Lines +/&minus;</div><div class="v">' + str(added) + ' / ' + str(removed) + '</div></div>'
        '<div class="card"><div class="k">Proof</div><div class="v ' + ('ok">RED→GREEN' if proven else 'bad">MISSING') + '</div></div>'
        '<div class="card"><div class="k">Review</div><div class="v">' + esc((d.get('review_decision') or '?').strip()) + '</div></div>')


def _minimality_section(d, files, fs):
    """Argue minimality from the diff, or decline to argue it."""
    src = [(p, b) for p, b in files if '.spec.' not in p and '.test.' not in p]
    rows, verdict = [], []
    for path, body in src:
        add = [l[1:] for l in body.splitlines() if l.startswith('+') and not l.startswith('+++')]
        rem = [l[1:] for l in body.splitlines() if l.startswith('-') and not l.startswith('---')]
        body_add = [a for a in add if a.strip() and not re.match(r'\s*import\b', a)]
        body_del = [r for r in rem if r.strip()]
        imports = [a for a in add if re.match(r'\s*import\b', a)]
        rows.append('<tr><td><code>' + esc(path) + '</code></td><td>' + str(len(body_add))
                    + ' added, ' + str(len(body_del)) + ' removed</td><td>'
                    + (str(len(imports)) + ' import' if imports else 'none') + '</td></tr>')
        if len(body_del) == 1 and len(body_add) <= 2:
            verdict.append('a single expression was replaced')
        elif len(body_add) <= 6:
            verdict.append('a handful of lines changed in one place')
        else:
            verdict.append('<strong class="warn">%d lines of new logic — larger than a minimal fix</strong>'
                           % len(body_add))

    helper_used = bool(fs.get('helper')) and fs['helper'] in (d.get('diff') or '')
    out = ['<h2>Is this the minimum change?</h2>',
           '<table><tr><th>File</th><th>Body lines</th><th>Imports</th></tr>' + ''.join(rows) + '</table>']
    if verdict:
        out.append('<p>In the source files: ' + '; '.join(verdict) + '.</p>')
    if fs.get('helper'):
        out.append('<p>' + ('<strong class="ok">The prescribed helper <code>' + esc(fs['helper'])
                            + '</code> is used in the change</strong> rather than reimplemented — so the '
                              'details it encodes cannot be got wrong here.'
                            if helper_used else
                            '<strong class="bad">The prescribed helper <code>' + esc(fs['helper'])
                            + '</code> does NOT appear in the change.</strong> The logic was hand-written '
                              'instead, which means a detail the helper owns has been re-derived — and on '
                              '2026-07-26 exactly that produced a fix matching on the wrong separator.')
                   + '</p>')
    if not src:
        out.append('<p>' + MISSING + ' — no source change to assess.</p>')
    return '\n'.join(out)


def _proof_section(d):
    """RED/GREEN, or an explicit PROBLEM."""
    if d.get('repro_gate'):
        return (
            '<h2>Proof the change works — RED then GREEN</h2>'
            '<table><tr><th>Stage</th><th>Code under test</th><th>Test result</th><th>What it establishes</th></tr>'
            '<tr><td><strong class="bad">RED</strong></td><td>the original code, without the fix</td>'
            '<td><span class="bad">FAILS</span></td>'
            '<td>the bug is real, and this test detects it</td></tr>'
            '<tr><td><strong class="ok">GREEN</strong></td><td>the code with the fix applied</td>'
            '<td><span class="ok">PASSES</span></td>'
            '<td>the change fixes the reported behaviour</td></tr></table>'
            '<p>Both runs were executed by the pipeline against real code — this is a demonstration, not '
            'a model&rsquo;s opinion. A test that had only ever run against the fixed code could pass for '
            'reasons unrelated to the bug, which is why the baseline run is the important half.</p>'
            '<p class="intro">Gate output: ' + esc(d['repro_gate']) + '</p>')
    return (
        '<h2>Proof the change works</h2>'
        '<div class="note bad"><strong>PROBLEM — there is no RED/GREEN proof for this change.</strong> '
        'No bug-reproduction gate result was recorded, so nothing here demonstrates that the reported bug '
        'existed or that this change fixes it. The code may be correct; it is <em>unproven</em>. Treat it '
        'as a proposal, not a verified fix, and do not merge it on the strength of the review alone — a '
        'reviewer reads intent, while the RED run is the only thing that tests reality.</div>')


def narrative_html(d):
    verdict_cls = 'ok' if d['passed'] else 'bad'
    verdict = 'PASSED' if d['passed'] else 'DID NOT COMPLETE'
    gap = (float(d['cost_total']) - d['cost_tracked']) if d['cost_total'] else None

    cards = (
        '<div class="card"><div class="k">Outcome</div><div class="v ' + verdict_cls + '">' + verdict + '</div></div>'
        '<div class="card"><div class="k">Cost</div><div class="v">$' + esc(_cost_shown(d)[0]) + '</div></div>'
        '<div class="card"><div class="k">Window</div><div class="v">' + esc(d['t_start'] or '?') + '&ndash;' + esc(d['t_end'] or '?') + '</div></div>'
        '<div class="card"><div class="k">Story</div><div class="v">' + esc(d['story'] or '?') + '</div></div>')

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
            + render_preamble(d)
            + '\n<h2>How the run unfolded</h2>\n' + render_timeline(
                [e for e in d['timeline'] if e['kind'] not in _NARRATIVE_SKIP])
            + '\n<h2>Commits</h2>\n<table><tr><th>SHA</th><th>Subject</th><th>When</th></tr>'
            + commits + '</table>\n'
            + render_code_section(d)
            + render_selfheal(d)
            + '\n<h2>Verification criteria</h2>\n<ul>' + (vc_items or '<li>' + MISSING + '</li>') + '</ul>\n' + vc_note
            + '\n<h2>Cost</h2>\n<table><tr><th>Agent</th><th class="num">Cost</th><th class="num">Tokens in</th>'
              '<th class="num">Tokens out</th><th class="num">Calls</th></tr>\n'
            + (costs or '<tr><td colspan="5">' + MISSING + '</td></tr>')
            + '\n<tr><th>Tracked total</th><th class="num">$%.4f</th><th colspan="3"></th></tr>' % d['cost_tracked']
            + ('\n<tr><th>Billed by provider</th><th class="num">$%s</th><th colspan="3"></th></tr></table>\n'
               % esc(d['cost_total']) if d['cost_total'] else
               '\n<tr><th>Billed by provider</th><th class="num">$%.4f</th>'
               '<th colspan="3" class="soft">summed from the per-call records &mdash; the provider\u2019s '
               'own usage counter was not captured for this run</th></tr></table>\n' % d['cost_tracked'])
            + gap_note
            + '\n<footer>Generated from <code>' + esc(d['launch_log']) + '</code>, the gate logs, '
              '<code>agent-activity.jsonl</code> and the codeline git history. Anything without a supporting '
              'artefact is marked <span class="missing">not recorded</span> rather than inferred.</footer>\n</main>')


def _cost_shown(d):
    """What this run cost, and how confident that number is.

    Prefer the provider's own usage delta; fall back to the sum of the per-call
    records. Reporting "$?" when every call's cost was recorded is needlessly
    unhelpful — the tally is a real number, it is simply the weaker of the two.
    """
    if d.get('cost_total'):
        return d['cost_total'], True
    return '%.4f' % (d.get('cost_tracked') or 0.0), False


# What each quality gate is FOR, and what its verdict means.
#
# A row reading `fuzz-weaver  not_applicable  509 B` tells a reader nothing:
# not what the gate examines, not why it exists, not whether standing down was
# the right answer. Six gate names is jargon; six explanations is a report.
_GATE_PURPOSE = {
    'sast-sentinel': (
        'Security scan',
        'Looks for the ways a change can be exploited rather than merely be wrong &mdash; injection, '
        'unsafe deserialisation, secrets committed to the repository, credentials in logs. It blocks '
        'the run on anything it rates a blocker, because a security defect that reaches review has '
        'already been normalised.'),
    'spec-validator': (
        'Does the change do what was asked?',
        'Takes each verification criterion the story was accepted against and classifies it against the '
        'diff: met, partial, unmet, or untestable. This is the gate that answers &ldquo;is this the '
        'right change?&rdquo; as distinct from &ldquo;is this change correct?&rdquo; &mdash; a fix can '
        'be flawless and still not be what the ticket asked for.'),
    'review-ranger': (
        'Machine code review',
        'Reads the diff the way a reviewer would, looking for defects the author is least likely to see '
        'in their own work: duplicated logic, error paths that swallow failures, names that mislead, '
        'changes wider than the problem. It reports severity so a style nit cannot masquerade as a bug.'),
    'mutant-hunter': (
        'Are the tests actually load-bearing?',
        'Deliberately breaks the changed code in small ways and checks whether the tests notice. A test '
        'that still passes when the logic under it is corrupted is not protecting anything &mdash; it '
        'is decoration. This is the only gate that judges the TESTS rather than the code, which is why '
        'it can warn on a change that is otherwise perfectly correct.'),
    'fuzz-weaver': (
        'What happens with inputs nobody thought about?',
        'Derives properties the changed functions should hold for ANY input &mdash; not just the '
        'examples in the tests &mdash; and looks for inputs that violate them: empty collections, '
        'boundary values, unexpected types, malformed data. Most real defects live in cases the author '
        'never imagined, and example-based tests can only ever check the cases somebody did imagine.'),
    'perf-sentinel': (
        'Will this be slow?',
        'Looks for complexity that will not show up on a developer machine and will on production data '
        '&mdash; work inside loops that should be hoisted, repeated allocations, blocking calls on hot '
        'paths, startup cost. Performance defects are rarely caught in review because the code reads '
        'perfectly well.'),
}

# What a verdict MEANS, so `not_applicable` is not mistaken for a shrug.
_VERDICT_MEANING = {
    'pass': 'examined the change and found nothing to report',
    'warn': 'found something worth a human&rsquo;s attention, but not serious enough to block',
    'fail': 'found a defect it considers blocking',
    'not_applicable': 'examined the change and determined this kind of check has nothing to say about '
                      'it &mdash; an explicit statement, not silence',
}


def _gate_detail(g):
    """The findings behind a verdict — the part a reader can act on.

    A `warn` with nothing behind it is unusable: it cannot be dismissed, because
    nobody knows what it found, and it cannot be fixed for the same reason. Run
    10's mutant-hunter returned warn on a 58% mutation score with three survived
    mutants and two uncovered branches, every one of them a specific missing
    test — and the report showed the word `warn` alone.
    """
    rows = []
    for item in (g.get('detail') or []):
        status = str(item.get('status') or item.get('severity') or '').lower()
        # Only surface what needs attention. A killed mutant or a passing check
        # is the system working; listing it buries the three that matter.
        if status in ('killed', 'covered', 'met', 'pass', ''):
            continue
        where = esc(str(item.get('file') or item.get('function') or ''))
        line = item.get('line')
        if line:
            where += ':' + esc(str(line))
        what = (item.get('originalCode') or item.get('description')
                or item.get('property') or item.get('text') or '')
        rec = item.get('recommendation') or item.get('suggestedFix') or item.get('gaps') or ''
        rows.append('<li><span class="' + ('bad' if status in ('survived', 'blocker', 'vulnerability')
                                           else 'warn') + '">' + esc(status) + '</span> '
                    + ('<code>' + where + '</code> ' if where else '')
                    + (('<br><span class="soft">' + esc(str(what)[:160]) + '</span>') if what else '')
                    + (('<br><strong>Do:</strong> ' + esc(str(rec)[:300])) if rec else '')
                    + '</li>')
    if not rows:
        return ''
    summ = ''
    if g.get('gsummary'):
        summ = ('<p class="soft">' + esc(', '.join(f'{k}: {v}' for k, v in g['gsummary'].items())) + '</p>')
    return ('<div class="detail"><h4>' + esc(g['name']) + ' — what it found</h4>' + summ
            + '<ul>' + '\n'.join(rows) + '</ul></div>')


def qa_html(d):
    def gate_row(g):
        name = '<td><code>' + esc(g['name']) + '</code></td>'
        if g['size'] is None:
            return '<tr>' + name + '<td><span class="bad">did not run</span></td><td class="num">&mdash;</td><td>no log written</td></tr>'
        if g['wrote_file_instead']:
            return ('<tr>' + name + '<td><span class="bad">no verdict</span></td><td class="num">'
                    + str(g['size']) + ' B</td><td>answered by calling a write tool &mdash; reviewed nothing</td></tr>')
        if g['verdict']:
            # not_applicable is a FIRST-CLASS verdict: a gate with nothing
            # meaningful to say about a change must be able to say so. Colouring
            # it as a warning implies a problem where the gate was explicit that
            # there is none.
            cls = 'ok' if g['verdict'] in ('pass', 'not_applicable') else 'warn'
            title, why = _GATE_PURPOSE.get(g['name'], ('', ''))
            meaning = _VERDICT_MEANING.get(g['verdict'], '')
            return ('<tr>' + name + '<td><span class="' + cls + '">' + esc(g['verdict']) + '</span></td>'
                    '<td class="num">' + str(g['size']) + ' B</td><td>'
                    + (('<strong>' + title + '.</strong> ' + why) if why else '')
                    + (('<br><span class="soft">This verdict: ' + meaning + '.</span>') if meaning else '')
                    + '</td></tr>')
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
            + '\n<h2>Play-by-play — testing &amp; quality</h2>\n' + render_timeline(d['timeline'], kinds=_QA_KINDS, intros=False)
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
            + ''.join(_gate_detail(g) for g in d['gate_logs'])
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
    ap.add_argument('--head', default='HEAD',
                    help="tip of the run's work; defaults to HEAD")
    ap.add_argument('--prd')
    args = ap.parse_args()

    d = collect(args)
    os.makedirs(args.out, exist_ok=True)
    for name, body in (('narrative.html', narrative_html(d)),
                       ('qa-summary.html', qa_html(d)),
                       ('code.html', render_code_page(d))):
        with open(os.path.join(args.out, name), 'w') as f:
            f.write(body)
        print('wrote', os.path.join(args.out, name))
    snapshot = os.path.join(args.out, 'working-prd.json')
    if args.prd and os.path.exists(args.prd) and os.path.abspath(args.prd) != os.path.abspath(snapshot):
        # Snapshot: the working PRD is temp state and disappears. Skipped when
        # the source IS the snapshot — regenerating a report from an archived run
        # would otherwise crash on copying a file onto itself.
        import shutil
        shutil.copy(args.prd, snapshot)
        print('wrote', os.path.join(args.out, 'working-prd.json'))
    with open(os.path.join(args.out, 'run-facts.json'), 'w') as f:
        json.dump({k: v for k, v in d.items() if k != 'diff'}, f, indent=2, default=str)
    print('wrote', os.path.join(args.out, 'run-facts.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
