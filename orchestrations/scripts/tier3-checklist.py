#!/usr/bin/env python3
"""tier3-checklist — live checklist view for tier3 orchestration runs.

Usage:
  python3 orchestrations/scripts/tier3-checklist.py [logfile]
  watch -n5 python3 orchestrations/scripts/tier3-checklist.py [logfile]

With no argument, reads the most-recently-modified /tmp/tier3-run*.log.
"""

import sys, re, os, glob
from datetime import datetime

ANSI = re.compile(r'\x1b\[[0-9;]*m')
def strip(s): return ANSI.sub('', s)

PHASE_ORDER   = ['scaffold', 'core', 'ui_and_review']
PHASE_LABELS  = {'scaffold': 'SCAFFOLD', 'core': 'CORE', 'ui_and_review': 'UI & REVIEW'}

STEP_ORDER = [
    '0', '0.1', '0.5', '0.6', '0.7', '0.8',
    '1', '1.5', '1.6',
    '2', '3a', '3b', '3.1', '3.2', '3.5', '3.6', '3.7', '3.8',
    '4', '4.2a', '4.2b', '4.3a', '4.3b', '4.4a', '4.4b', '4.6',
]

# Canonical descriptions — overridden by what the log reports
STEP_DESC = {
    '0':    'Specification pass',
    '0.1':  'CPA pre-pass',
    '0.5':  'Skill assessment',
    '0.6':  'Hybrid pre-coord',
    '0.7':  'Regression guard',
    '0.8':  'mkdir src/ dirs',
    '1':    'Main-branch stories',
    '1.5':  'Auto-commit',
    '1.6':  'TC writer gate',
    '2':    'Worktrees',
    '3a':   'Primary agent',
    '3b':   'Independent agent',
    '3.1':  'Worktree health',
    '3.2':  'Worktree merge-back',
    '3.5':  'Post-parallel assess',
    '3.6':  'Team Lead review',
    '3.7':  'Pre-review gate',
    '3.8':  'Lint gate',
    '4':    'Review stories',
    '4.2a': 'SAST sentinel',
    '4.2b': 'Spec validator',
    '4.3a': 'Review ranger',
    '4.3b': 'Mutant hunter',
    '4.4a': 'Fuzz-weaver',
    '4.4b': 'Perf sentinel',
    '4.6':  'Browser E2E',
}

ICON_MAP = {
    'done':    '✓',
    'skip':    '⊘',
    'running': '▶',
    'warn':    '⚠',
    'fail':    '✗',
    'pending': '○',
}

CHAR_STATUS = {
    '✓': 'done', '⊘': 'skip', '▶': 'running',
    '⚠': 'warn', '✗': 'fail', '×': 'fail', '○': 'pending',
}


def find_latest_log():
    candidates = glob.glob('/tmp/tier3-run*.log') + glob.glob('/tmp/tier3-travel-app-run-*.log')
    return max(candidates, key=os.path.getmtime) if candidates else None


def parse(path):
    """Return (phase_data, stories, run_meta).

    phase_data: {phase: {step_id: {'status': str, 'note': str}}}
    stories:    {story_id: {'status': str, 'phase': str}}
    run_meta:   {'log': str, 'start_time': str, 'end_time': str}
    """
    phase_data = {}   # phase -> {step_id -> {status, note}}
    stories    = {}   # story_id -> {status, phase}
    meta       = {'log': path, 'start_time': '', 'end_time': ''}

    current_phase = None
    in_status_table = False
    in_checklist_table = False

    with open(path, errors='replace') as f:
        lines = [strip(l.rstrip()) for l in f]

    for line in lines:
        # ── Phase banner ────────────────────────────────────────────
        m = re.search(r'━+\s*Phase:\s*(\S+)\s*━+', line)
        if m:
            current_phase = m.group(1).strip()
            if current_phase not in phase_data:
                phase_data[current_phase] = {}
            in_status_table = False
            in_checklist_table = False
            continue

        # Fallback: detect phase from "for phase 'X'" text
        if current_phase is None:
            m = re.search(r"for phase '(\w+)'", line)
            if m:
                current_phase = m.group(1)
                if current_phase not in phase_data:
                    phase_data[current_phase] = {}

        if current_phase is None:
            current_phase = 'scaffold'
            phase_data.setdefault(current_phase, {})

        # ── Run timestamps ───────────────────────────────────────────
        m = re.search(r'\[(\d{2}:\d{2}:\d{2})\]', line)
        if m:
            t = m.group(1)
            if not meta['start_time']:
                meta['start_time'] = t
            meta['end_time'] = t

        # ── Pipeline Step Checklist table (planned state) ────────────
        if '━━━ Pipeline Step Checklist' in line:
            in_checklist_table = True
            in_status_table = False
            continue
        if in_checklist_table:
            # e.g. "  0.6    Hybrid pre-coord                 SKIP (reason)"
            m = re.match(r'\s{2}(\S+)\s{2,}(.+?)\s{2,}(ACTIVE|SKIP|COND)(?:\s+\(([^)]+)\))?', line)
            if m:
                sid, desc, planned, reason = m.group(1), m.group(2).strip(), m.group(3), m.group(4) or ''
                if sid in STEP_ORDER:
                    steps = phase_data[current_phase]
                    if sid not in steps:
                        note = reason if planned == 'SKIP' else ''
                        status = 'skip' if planned == 'SKIP' else 'pending'
                        steps[sid] = {'status': status, 'note': note}
            if line.strip().startswith('SKIP bypass') or (line.strip() == '' and in_checklist_table):
                in_checklist_table = False
            continue

        # ── Step Status table (periodic snapshot) ────────────────────
        if re.match(r'━+\s*Step Status @', line):
            in_status_table = True
            continue
        if in_status_table:
            if re.match(r'━{10,}', line):
                in_status_table = False
                continue
            # e.g. "  ✓ 0      Step 0: Specification pass"
            # or   "  ○ 1      1"
            m = re.match(r'\s+([✓⊘▶⚠✗×○])\s+(\S+)\s+', line)
            if m:
                icon, sid = m.group(1), m.group(2)
                status = CHAR_STATUS.get(icon, 'pending')
                steps = phase_data.setdefault(current_phase, {})
                existing = steps.get(sid, {})
                # Only overwrite if the table is more authoritative (it's a snapshot)
                # Prefer 'done'/'fail'/'warn' over 'pending'; always update 'running'
                cur_status = existing.get('status', 'pending')
                if cur_status in ('pending', 'running') or status in ('done', 'fail', 'warn', 'skip'):
                    steps[sid] = {'status': status, 'note': existing.get('note', '')}
            continue

        # ── Inline step lines ─────────────────────────────────────────
        # e.g. "  ▶ Step 4.2a: SAST sentinel"
        # e.g. "  ✓ Step 3.7: Pre-review gate"
        # e.g. "  ⚠ Step 4.2b: Spec validator [no story data]"
        # e.g. "  ⊘ Step 0.6: Hybrid pre-coord [ORCH_MODE=bash]"
        m = re.match(r'\s*([✓⊘▶⚠✗×])\s+Step\s+([0-9a-z.]+)[:\s]+(.*)', line)
        if m:
            icon, sid, rest = m.group(1), m.group(2), m.group(3).strip()
            status = CHAR_STATUS.get(icon, 'pending')
            note_m = re.search(r'\[([^\]]+)\]', rest)
            note = note_m.group(1) if note_m else ''
            steps = phase_data.setdefault(current_phase, {})
            existing_note = steps.get(sid, {}).get('note', '')
            steps[sid] = {'status': status, 'note': note or existing_note}
            continue

        # ── Step 3.6 (Team Lead review) — non-standard completion marker ──
        if re.search(r'\[PASS\] Team Lead code review completed', line) or \
           re.search(r'\[SUCCESS\] Team Lead code review completed', line):
            steps = phase_data.setdefault(current_phase, {})
            steps['3.6'] = {'status': 'done', 'note': ''}
            continue
        if re.search(r'Step 3\.6: Running Team Lead', line):
            steps = phase_data.setdefault(current_phase, {})
            steps.setdefault('3.6', {'status': 'running', 'note': ''})
            continue

        # ── Story completions ─────────────────────────────────────────
        m = re.search(r'Story (SKY-[\w-]+) marked as (completed|failed)', line)
        if m:
            stories[m.group(1)] = {'status': m.group(2), 'phase': current_phase}
            continue
        m = re.search(r'Cost\[(SKY-[\w-]+)\].*status=(completed|failed)', line)
        if m and m.group(1) not in stories:
            stories[m.group(1)] = {'status': m.group(2), 'phase': current_phase}

    return phase_data, stories, meta


def render(phase_data, stories, meta):
    log_name = os.path.basename(meta['log'])
    t_range = f"{meta['start_time']}–{meta['end_time']}" if meta['end_time'] else meta['start_time']

    print(f"**Run 83 — tier3 checklist · {t_range}**")
    print(f"*{log_name}*")

    seen_phases = set(phase_data.keys())
    phase_idx = {p: i for i, p in enumerate(PHASE_ORDER)}
    last_seen_idx = max((phase_idx[p] for p in seen_phases if p in phase_idx), default=-1)

    for phase in PHASE_ORDER:
        label = PHASE_LABELS.get(phase, phase.upper())
        steps = phase_data.get(phase, {})
        this_idx = phase_idx.get(phase, 0)
        superseded = this_idx < last_seen_idx

        any_running = any(s.get('status') == 'running' for s in steps.values())
        any_fail    = any(s.get('status') == 'fail'    for s in steps.values())
        all_resolved = all(
            steps.get(sid, {}).get('status') in ('done', 'skip', 'warn')
            for sid in STEP_ORDER if steps.get(sid)
        )

        if phase not in seen_phases:
            phase_status = 'PENDING'
        elif any_fail:
            phase_status = 'FAILED'
        elif superseded or (all_resolved and steps):
            phase_status = 'COMPLETE'
        elif any_running:
            phase_status = 'RUNNING'
        else:
            phase_status = 'IN PROGRESS'

        # Find the active step for IN PROGRESS label
        active_step = ''
        if phase_status in ('IN PROGRESS', 'RUNNING'):
            for sid in STEP_ORDER:
                if steps.get(sid, {}).get('status') == 'running':
                    active_step = f' (Step {sid})'
                    break
            if not active_step:
                # Find first pending step
                for sid in STEP_ORDER:
                    if steps.get(sid, {}).get('status') == 'pending' or sid not in steps:
                        active_step = f' (Step {sid})'
                        break

        print(f"\n**{label} — {phase_status}{active_step}**\n")

        if phase not in seen_phases:
            print("| | Step | Name |")
            print("|---|---|---|")
            print("| ○ | — | pending |")
            continue

        phase_stories = {sid: info for sid, info in stories.items() if info['phase'] == phase}

        print("| | Step | Name |")
        print("|---|---|---|")

        for sid in STEP_ORDER:
            info = steps.get(sid)
            desc = STEP_DESC.get(sid, sid)

            if info is None:
                if phase_status == 'PENDING':
                    continue
                elif phase_status == 'COMPLETE':
                    print(f"| ⊘ | {sid} | {desc} *(n/a)* |")
                else:
                    print(f"| ○ | {sid} | {desc} |")
                continue

            status = info['status']
            note   = info['note']

            if status == 'pending' and phase_status == 'COMPLETE':
                status = 'skip'
                note   = 'n/a'

            icon = ICON_MAP.get(status, '?')
            note_str = f' *({note})*' if note else ''

            # Build story list for step 1
            story_str = ''
            if sid == '1' and phase_stories:
                parts = []
                for story_id in sorted(phase_stories):
                    s_icon = '✓' if phase_stories[story_id]['status'] == 'completed' else '✗'
                    parts.append(f"{s_icon} {story_id}")
                story_str = ' — ' + ' '.join(parts)
                if status == 'pending':
                    story_str += ' — *still running*'

            print(f"| {icon} | {sid} | {desc}{story_str}{note_str} |")

        print("|---|---|---|")


def main():
    log = sys.argv[1] if len(sys.argv) > 1 else find_latest_log()
    if not log:
        print("No tier3 log found. Pass a log file path as argument.", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(log):
        print(f"Log not found: {log}", file=sys.stderr)
        sys.exit(1)

    phase_data, stories, meta = parse(log)
    render(phase_data, stories, meta)


if __name__ == '__main__':
    main()
