#!/usr/bin/env python3
"""
BUILD THE QA REPORT FROM A RUN'S OWN ARTIFACTS.

Reads the log, the PRD and the run's log directory, and writes the QA summary for the run.

Lifted out of its calling script on 2026-08-16, where it was a quoted heredoc. The program is
byte-for-byte unchanged — it already took its inputs as arguments; it just had no name and no
home of its own. Generic: nothing here is project- or stack-specific.

    argv[1]  the run log
    argv[2]  the report to write
    argv[3]  the run's log directory
    argv[4]  the PRD
"""
import sys
import re
import json
import os
from datetime import datetime
from pathlib import Path
from html import escape as he

LOG_FILE = sys.argv[1]
OUT_FILE = sys.argv[2]
LOG_DIR  = Path(sys.argv[3])
PRD_FILE = Path(sys.argv[4])

# ── Helpers ────────────────────────────────────────────────────────────────────

def strip_ansi(text):
    return re.sub(r'\x1b\[[0-9;]*m', '', text)

def load_json_safe(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None

def load_jsonl_safe(path):
    records = []
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return records

def load_text_safe(path):
    try:
        return Path(path).read_text()
    except Exception:
        return ""

# ── Parse run log ─────────────────────────────────────────────────────────────

raw = Path(LOG_FILE).read_text()
clean = strip_ansi(raw)
lines = clean.splitlines()

log_name = Path(LOG_FILE).name
ts_match = re.search(r'(\d{8}T\d{6})', log_name)
run_ts_raw = ts_match.group(1) if ts_match else "unknown"
try:
    run_ts_fmt = datetime.strptime(run_ts_raw, "%Y%m%dT%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
except Exception:
    run_ts_fmt = run_ts_raw

# Extract overall pass/fail from phase gates
phase_gates = re.findall(r'Phase gate:\s*(GO|STOP|NO-GO)', clean)
overall_pass = len(phase_gates) > 0 and all(g == "GO" for g in phase_gates)

# Extract duration (first/last timestamp)
ts_all = re.findall(r'\[(\d{2}:\d{2}:\d{2})\]', clean)
run_start_ts = ts_all[0] if ts_all else "?"
run_end_ts   = ts_all[-1] if ts_all else "?"

def hms_to_sec(ts):
    try:
        h, m, s = map(int, ts.split(":"))
        return h * 3600 + m * 60 + s
    except Exception:
        return 0

start_sec = hms_to_sec(run_start_ts)
end_sec   = hms_to_sec(run_end_ts)
diff_sec  = end_sec - start_sec
if diff_sec < 0:
    diff_sec += 86400
run_duration = f"{diff_sec // 60}m {diff_sec % 60}s"

# Cost delta
openrouter_before_m = re.search(r'OpenRouter usage before:\s*\$([0-9.]+)', clean)
openrouter_after_m  = re.search(r'OpenRouter usage after:\s*\$([0-9.]+)', clean)
cost_lines = re.findall(r'Cost\[(\S+)\]\s+model=(\S+)\s+in=(\d+)\s+out=(\d+)\s+cost=\$([0-9.]+)', clean)

if openrouter_before_m and openrouter_after_m:
    before = float(openrouter_before_m.group(1))
    after  = float(openrouter_after_m.group(1))
    cost_delta_str = f"${after - before:.4f} (OpenRouter: ${before:.4f} → ${after:.4f})"
elif cost_lines:
    total = sum(float(r[4]) for r in cost_lines)
    cost_delta_str = f"${total:.4f} (from agent cost records)"
else:
    cost_delta_str = "unavailable"

# Detect phases
phases_in_log = list(dict.fromkeys(
    re.findall(r'━+\s*Phase:\s*(\w+)\s*━+', clean)
))

# ── Load data files ────────────────────────────────────────────────────────────

# Auto-detect available phases from log files
all_phases = phases_in_log[:]
for f in LOG_DIR.glob("vitest-oracle-*.json"):
    ph = f.stem.replace("vitest-oracle-", "")
    if ph not in all_phases:
        all_phases.append(ph)

# Vitest results per phase
vitest_by_phase = {}
for phase in all_phases:
    d = load_json_safe(LOG_DIR / f"vitest-oracle-{phase}.json")
    if d:
        vitest_by_phase[phase] = d

# TC facts per phase
tc_by_phase = {}
for phase in all_phases:
    d = load_json_safe(LOG_DIR / f"tc-{phase}.json")
    if d:
        tc_by_phase[phase] = d

# NPM audit per phase
npm_by_phase = {}
for phase in all_phases:
    d = load_json_safe(LOG_DIR / f"npm-audit-oracle-{phase}.json")
    if d:
        npm_by_phase[phase] = d

# Gate logs — look for *.log files with gate names
gate_files = {}
gate_names = ["fuzz-weaver", "review-ranger", "sast-sentinel", "mutant-hunter"]
for gname in gate_names:
    for f in LOG_DIR.glob(f"{gname}-*.log"):
        phase = f.stem.replace(f"{gname}-", "")
        gate_files.setdefault(gname, {})[phase] = load_text_safe(f)

# PRD
prd = load_json_safe(PRD_FILE)

# Healing events
healing = load_jsonl_safe(LOG_DIR / "healing-events.jsonl")

# ── Compute summary stats ─────────────────────────────────────────────────────

grand_total_tests  = sum(v.get("numTotalTests", 0)  for v in vitest_by_phase.values())
grand_passed_tests = sum(v.get("numPassedTests", 0) for v in vitest_by_phase.values())
grand_failed_tests = sum(v.get("numFailedTests", 0) for v in vitest_by_phase.values())

total_vulns = 0
for npm in npm_by_phase.values():
    total_vulns += len(npm.get("vulnerabilities", {}))

overall_badge = "PASS" if overall_pass else "FAIL"
overall_color = "#a3e635" if overall_pass else "#ef4444"

# ── HTML generation ────────────────────────────────────────────────────────────

CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #080808;
  color: #f0f0f0;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.6;
  padding: 24px;
}
h1 { font-size: 22px; color: #a3e635; margin-bottom: 4px; }
h2 { font-size: 16px; color: #a3e635; margin: 32px 0 12px; border-bottom: 1px solid #222; padding-bottom: 6px; }
h3 { font-size: 14px; color: #86efac; margin: 20px 0 8px; }
a { color: #60a5fa; }
code { background: #111; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
pre { background: #111; border: 1px solid #222; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }

/* Summary header */
.run-header { background: #0f0f0f; border: 1px solid #1e1e1e; border-radius: 8px; padding: 20px 24px; margin-bottom: 28px; }
.run-header .meta { color: #888; font-size: 12px; margin-top: 4px; }
.run-header .badges { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; }
.badge-pass  { background: #1a2e0a; color: #a3e635; border: 1px solid #a3e635; }
.badge-fail  { background: #2e0a0a; color: #ef4444; border: 1px solid #ef4444; }
.badge-warn  { background: #2e200a; color: #f59e0b; border: 1px solid #f59e0b; }
.badge-info  { background: #0a1a2e; color: #60a5fa; border: 1px solid #60a5fa; }
.badge-skip  { background: #1a1a1a; color: #888;    border: 1px solid #333; }
.stat-row    { display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap; }
.stat-tile   { background: #111; border: 1px solid #222; border-radius: 6px; padding: 10px 16px; min-width: 100px; text-align: center; }
.stat-tile .val { font-size: 22px; font-weight: 700; color: #a3e635; }
.stat-tile .lbl { font-size: 11px; color: #888; margin-top: 2px; }
.stat-tile.fail .val { color: #ef4444; }
.stat-tile.warn .val { color: #f59e0b; }
.stat-tile.info .val { color: #60a5fa; }

/* Tables */
table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
th { background: #111; color: #a3e635; text-align: left; padding: 8px 10px; border-bottom: 1px solid #222; font-size: 12px; font-weight: 600; white-space: nowrap; }
td { padding: 7px 10px; border-bottom: 1px solid #1a1a1a; vertical-align: top; font-size: 12px; }
tr:hover td { background: #0f0f0f; }
.mono { font-family: inherit; }

/* Status indicators */
.s-pass   { color: #a3e635; }
.s-fail   { color: #ef4444; }
.s-skip   { color: #888; }
.s-warn   { color: #f59e0b; }
.s-info   { color: #60a5fa; }

/* Failure message block */
.failure-msg { background: #1a0a0a; border-left: 3px solid #ef4444; padding: 8px 10px; margin-top: 6px; font-size: 11px; color: #fca5a5; white-space: pre-wrap; word-break: break-word; }

/* Phase header */
.phase-label { display: inline-block; background: #1a2e0a; color: #a3e635; border: 1px solid #2e4a12; border-radius: 4px; padding: 2px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-right: 8px; }

/* Section separator */
.section-sep { border: none; border-top: 1px solid #1a1a1a; margin: 32px 0; }

/* Severity badges */
.sev-critical { color: #7f1d1d; background: #fca5a5; border-radius: 3px; padding: 1px 6px; font-size: 11px; }
.sev-high     { color: #7c2d12; background: #fdba74; border-radius: 3px; padding: 1px 6px; font-size: 11px; }
.sev-moderate { color: #78350f; background: #fde68a; border-radius: 3px; padding: 1px 6px; font-size: 11px; }
.sev-low      { color: #1e3a5f; background: #93c5fd; border-radius: 3px; padding: 1px 6px; font-size: 11px; }
.sev-info     { color: #374151; background: #d1d5db; border-radius: 3px; padding: 1px 6px; font-size: 11px; }

/* Gate verdict block */
.gate-block { background: #0f0f0f; border: 1px solid #1e1e1e; border-radius: 6px; padding: 14px 16px; margin-bottom: 14px; }
.gate-block .gate-title { font-size: 13px; font-weight: 700; color: #f0f0f0; margin-bottom: 8px; }
.gate-block .gate-verdict { font-size: 12px; margin-bottom: 8px; }
.gate-block pre { font-size: 11px; max-height: 280px; overflow-y: auto; }

/* AC table */
.ac-addressed { color: #a3e635; }
.ac-unknown   { color: #888; }

/* Scrollable wrapper */
.tbl-wrap { overflow-x: auto; }

/* No-data placeholder */
.no-data { color: #555; font-style: italic; padding: 8px 0; font-size: 12px; }
"""

# ── Helper builders ────────────────────────────────────────────────────────────

def badge(label, cls="info"):
    return f'<span class="badge badge-{cls}">{he(label)}</span>'

def status_cell(status):
    if status == "passed":
        return '<td class="s-pass">✓ passed</td>'
    elif status == "failed":
        return '<td class="s-fail">✗ failed</td>'
    elif status in ("skipped", "pending", "todo"):
        return '<td class="s-skip">⊘ {}</td>'.format(status)
    else:
        return f'<td class="s-warn">{he(status)}</td>'

def sev_badge(sev):
    sev_lower = sev.lower()
    cls = {"critical": "sev-critical", "high": "sev-high",
           "moderate": "sev-moderate", "low": "sev-low"}.get(sev_lower, "sev-info")
    return f'<span class="{cls}">{he(sev)}</span>'

def gate_verdict_badge(verdict):
    v = str(verdict).lower()
    if v in ("pass", "go", "true"):
        return badge("PASS", "pass")
    elif v in ("fail", "no-go", "stop", "false"):
        return badge("FAIL", "fail")
    elif v == "warn":
        return badge("WARN", "warn")
    else:
        return badge(verdict or "unknown", "skip")

# ── Section 1: Run summary header ─────────────────────────────────────────────

run_pass_cls  = "pass" if overall_pass else "fail"
run_pass_text = "PASS" if overall_pass else "FAIL"
phases_gated  = ", ".join(phase_gates) if phase_gates else "none"
n_phases_done = len(phase_gates)

header_html = f"""
<div class="run-header">
  <h1>QA &amp; Test Report</h1>
  <div class="meta">Log: {he(log_name)} &nbsp;|&nbsp; Generated: {he(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))}</div>
  <div class="badges" style="margin-top:14px;">
    <span class="badge badge-{run_pass_cls}">{he(run_pass_text)}</span>
    {badge(run_ts_fmt, 'info')}
    {badge(f'Duration: {run_duration}', 'info')}
    {badge(f'Cost delta: {cost_delta_str}', 'info')}
  </div>
  <div class="stat-row">
    <div class="stat-tile{'' if grand_passed_tests == grand_total_tests else ' fail'}">
      <div class="val">{grand_total_tests}</div><div class="lbl">Total Tests</div>
    </div>
    <div class="stat-tile">
      <div class="val" style="color:#a3e635">{grand_passed_tests}</div><div class="lbl">Passed</div>
    </div>
    <div class="stat-tile{' fail' if grand_failed_tests > 0 else ''}">
      <div class="val" style="color:{'#ef4444' if grand_failed_tests > 0 else '#555'}">{grand_failed_tests}</div><div class="lbl">Failed</div>
    </div>
    <div class="stat-tile{' warn' if total_vulns > 0 else ''}">
      <div class="val" style="color:{'#f59e0b' if total_vulns > 0 else '#555'}">{total_vulns}</div><div class="lbl">NPM Vulns</div>
    </div>
    <div class="stat-tile info">
      <div class="val" style="color:#60a5fa">{n_phases_done}</div><div class="lbl">Phases Gated</div>
    </div>
    <div class="stat-tile">
      <div class="val" style="color:#a3e635">{len(healing)}</div><div class="lbl">Heal Events</div>
    </div>
  </div>
</div>
"""

# ── Section 2: Vitest results ─────────────────────────────────────────────────

def build_vitest_section():
    parts = ['<h2>Vitest Test Results</h2>']

    if not vitest_by_phase:
        parts.append('<p class="no-data">No vitest-oracle-*.json files found in log directory.</p>')
        return "\n".join(parts)

    for phase, vdata in sorted(vitest_by_phase.items()):
        n_total  = vdata.get("numTotalTests", 0)
        n_passed = vdata.get("numPassedTests", 0)
        n_failed = vdata.get("numFailedTests", 0)
        n_skip   = vdata.get("numPendingTests", 0) + vdata.get("numTodoTests", 0)
        success  = vdata.get("success", False)
        start_ts = vdata.get("startTime", 0)
        try:
            phase_ts_fmt = datetime.fromtimestamp(start_ts / 1000).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            phase_ts_fmt = "?"

        phase_badge_cls = "pass" if success else "fail"

        parts.append(f"""
<h3><span class="phase-label">{he(phase)}</span>
  {badge(f'{n_total} tests', 'info')}
  {badge(f'{n_passed} passed', 'pass' if n_passed == n_total else 'info')}
  {''.join([badge(f'{n_failed} failed', 'fail')]) if n_failed else ''}
  {''.join([badge(f'{n_skip} skipped', 'skip')]) if n_skip else ''}
  {gate_verdict_badge('pass' if success else 'fail')}
  <span style="color:#555;font-size:11px;margin-left:8px;">{he(phase_ts_fmt)}</span>
</h3>
""")

        test_results = vdata.get("testResults", [])
        if not test_results:
            parts.append('<p class="no-data">No test result details available.</p>')
            continue

        parts.append('<div class="tbl-wrap"><table>')
        parts.append('<thead><tr><th style="width:50%">Test Name</th><th style="width:30%">File</th><th>Status</th><th>Duration</th></tr></thead>')
        parts.append('<tbody>')

        for suite in test_results:
            suite_file = suite.get("testFilePath", suite.get("name", ""))
            # Shorten path
            suite_file_short = re.sub(r'^.+/(test|src)/', '\\1/', suite_file) if suite_file else ""

            for ar in suite.get("assertionResults", []):
                full_name   = ar.get("fullName", ar.get("title", ""))
                status      = ar.get("status", "unknown")
                duration_ms = ar.get("duration", None)
                fail_msgs   = ar.get("failureMessages", [])

                dur_str = f"{duration_ms}ms" if duration_ms is not None else "—"

                fail_html = ""
                if fail_msgs:
                    msg_text = "\n\n".join(fail_msgs)
                    # Trim very long messages
                    if len(msg_text) > 2000:
                        msg_text = msg_text[:2000] + "\n... (truncated)"
                    fail_html = f'<div class="failure-msg">{he(msg_text)}</div>'

                name_cell = f'<td class="mono">{he(full_name)}{fail_html}</td>'
                file_cell = f'<td class="mono" style="color:#555;font-size:11px;">{he(suite_file_short)}</td>'

                parts.append(f'<tr>{name_cell}{file_cell}{status_cell(status)}<td style="color:#888">{he(dur_str)}</td></tr>')

        parts.append('</tbody></table></div>')

    return "\n".join(parts)

# ── Section 3: TC verification ────────────────────────────────────────────────

def build_tc_section():
    parts = ['<h2>Test Criteria Verification</h2>']

    if not tc_by_phase:
        parts.append('<p class="no-data">No tc-*.json files found in log directory.</p>')
        return "\n".join(parts)

    for phase, tc_data in sorted(tc_by_phase.items()):
        parts.append(f'<h3><span class="phase-label">{he(phase)}</span></h3>')
        parts.append('<div class="tbl-wrap"><table>')
        parts.append('<thead><tr><th>Story</th><th style="width:55%">Verified Fact</th><th>Source Files</th></tr></thead>')
        parts.append('<tbody>')

        story_count = 0
        for story_id, story_data in tc_data.items():
            facts   = story_data.get("facts", [])
            sources = story_data.get("sourceFiles", [])
            verified_at = story_data.get("verifiedAt", "")

            if not facts:
                parts.append(f'<tr><td class="mono">{he(story_id)}</td><td class="no-data">No facts recorded</td><td>—</td></tr>')
                continue

            sources_html = "<br>".join(
                f'<code>{he(re.sub(r"^.+/(src|test)/", "\\1/", s))}</code>'
                for s in sources[:5]
            )
            if len(sources) > 5:
                sources_html += f'<br><span style="color:#555">+{len(sources)-5} more</span>'

            first_row = True
            for fact in facts:
                sid_cell = ""
                if first_row:
                    sid_cell = f'<td class="mono" rowspan="{len(facts)}" style="vertical-align:top;color:#60a5fa">{he(story_id)}</td>'
                    src_cell = f'<td rowspan="{len(facts)}" style="vertical-align:top;font-size:11px">{sources_html}</td>'
                    if verified_at:
                        sid_cell = f'<td class="mono" rowspan="{len(facts)}" style="vertical-align:top;color:#60a5fa">{he(story_id)}<br><span style="color:#555;font-size:10px">{he(verified_at[:10])}</span></td>'
                    first_row = False
                    parts.append(f'<tr>{sid_cell}<td style="font-size:11px">{he(fact)}</td>{src_cell}</tr>')
                else:
                    parts.append(f'<tr><td style="font-size:11px">{he(fact)}</td></tr>')

            story_count += 1

        parts.append('</tbody></table></div>')
        if story_count == 0:
            parts.append('<p class="no-data">No stories with facts in this phase.</p>')

    return "\n".join(parts)

# ── Section 4: Gate verdicts ──────────────────────────────────────────────────

def build_gate_section():
    parts = ['<h2>Gate Verdicts</h2>']

    # Also parse gate results from main log
    log_gate_verdicts = {}  # gate_name -> [{phase, verdict, detail}]
    gate_patterns = {
        "SAST sentinel":   re.compile(r'\[(?:SUCCESS|FAIL)\]\s+SAST sentinel:\s*(PASS|FAIL)\s*\((.+?)\)'),
        "Spec validator":  re.compile(r'\[(?:SUCCESS|FAIL)\]\s+Spec validator:\s*(PASS|FAIL)'),
        "Review ranger":   re.compile(r'\[(?:SUCCESS|FAIL)\]\s+Review-ranger:\s*(PASS|FAIL)'),
        "Mutant hunter":   re.compile(r'\[(?:SUCCESS|FAIL)\]\s+Mutant.hunter:\s*(PASS|FAIL)'),
        "Fuzz-weaver":     re.compile(r'\[(?:SUCCESS|FAIL)\]\s+Fuzz-weaver:\s*(PASS|FAIL)'),
        "Perf sentinel":   re.compile(r'\[(?:SUCCESS|FAIL)\]\s+Perf.sentinel:\s*(PASS|FAIL)'),
        "Vitest":          re.compile(r'\[(?:SUCCESS|FAIL)\]\s+vitest:\s*(PASS|FAIL)'),
        "TypeScript (tsc)":re.compile(r'\[(?:SUCCESS|FAIL)\]\s+tsc:\s*(PASS|FAIL|SKIP)'),
    }

    for line in clean.splitlines():
        for gate_name, pat in gate_patterns.items():
            m = pat.search(line)
            if m:
                verdict = m.group(1)
                detail  = m.group(2) if m.lastindex and m.lastindex >= 2 else ""
                if gate_name not in log_gate_verdicts:
                    log_gate_verdicts[gate_name] = []
                log_gate_verdicts[gate_name].append({"verdict": verdict, "detail": detail})

    if not gate_files and not log_gate_verdicts:
        parts.append('<p class="no-data">No gate log files found and no gate verdicts extracted from run log.</p>')
        return "\n".join(parts)

    # From log-derived verdicts
    if log_gate_verdicts:
        parts.append('<h3>Extracted from run log</h3>')
        parts.append('<div class="tbl-wrap"><table>')
        parts.append('<thead><tr><th>Gate</th><th>Verdict</th><th>Detail</th></tr></thead>')
        parts.append('<tbody>')
        for gname, records in log_gate_verdicts.items():
            for rec in records:
                v = rec["verdict"]
                d = rec.get("detail", "")
                badge_html = gate_verdict_badge(v)
                parts.append(f'<tr><td class="mono">{he(gname)}</td><td>{badge_html}</td><td style="font-size:11px;color:#888">{he(d)}</td></tr>')
        parts.append('</tbody></table></div>')

    # From gate log files
    if gate_files:
        parts.append('<h3>Gate log files</h3>')
        for gname, phases in sorted(gate_files.items()):
            for phase, text in sorted(phases.items()):
                # Try to find verdict in the text
                verdict_m = re.search(r'"verdict"\s*:\s*"([^"]+)"', text)
                findings_m = re.search(r'"(?:findings|blockerCount|findingCount)"\s*:\s*(\d+)', text)
                verdict = verdict_m.group(1) if verdict_m else "unknown"
                findings_count = findings_m.group(1) if findings_m else "?"

                verdict_badge = gate_verdict_badge(verdict)
                parts.append(f"""
<div class="gate-block">
  <div class="gate-title">
    <span class="phase-label">{he(phase)}</span>{he(gname)}
    &nbsp; {verdict_badge}
    &nbsp; <span style="color:#888;font-size:11px">findings: {he(str(findings_count))}</span>
  </div>
  <div class="gate-verdict">&nbsp;</div>
  <pre>{he(text[:3000])}{'...(truncated)' if len(text) > 3000 else ''}</pre>
</div>
""")

    return "\n".join(parts)

# ── Section 5: NPM security audit ─────────────────────────────────────────────

def build_npm_section():
    parts = ['<h2>NPM Security Audit</h2>']

    if not npm_by_phase:
        parts.append('<p class="no-data">No npm-audit-oracle-*.json files found in log directory.</p>')
        return "\n".join(parts)

    for phase, npm_data in sorted(npm_by_phase.items()):
        vulns = npm_data.get("vulnerabilities", {})
        meta  = npm_data.get("metadata", {})

        sev_counts = {}
        for v in vulns.values():
            sev = v.get("severity", "info")
            sev_counts[sev] = sev_counts.get(sev, 0) + 1

        parts.append(f'<h3><span class="phase-label">{he(phase)}</span>'
                     + " ".join(f'{sev_badge(s)} &times;{c}' for s, c in sorted(sev_counts.items()))
                     + ('&nbsp;<span class="no-data" style="padding:0">No vulnerabilities</span>' if not vulns else '')
                     + '</h3>')

        if not vulns:
            continue

        parts.append('<div class="tbl-wrap"><table>')
        parts.append('<thead><tr><th>Package</th><th>Severity</th><th>Vulnerability</th><th>CVE / Advisory</th><th>Fix Available</th></tr></thead>')
        parts.append('<tbody>')

        for pkg_name, vuln in sorted(vulns.items(), key=lambda x: ["critical","high","moderate","low","info"].index(x[1].get("severity","info").lower()) if x[1].get("severity","info").lower() in ["critical","high","moderate","low","info"] else 99):
            severity = vuln.get("severity", "info")
            via = vuln.get("via", [])
            fix  = vuln.get("fixAvailable", False)

            if isinstance(fix, dict):
                fix_str = f'{fix.get("name","?")} {fix.get("version","?")} ({"major" if fix.get("isSemVerMajor") else "minor"})'
            elif fix:
                fix_str = "Yes"
            else:
                fix_str = '<span style="color:#888">No</span>'

            if isinstance(via, list) and via:
                for item in via:
                    if isinstance(item, dict):
                        title = item.get("title", "")
                        url   = item.get("url", "")
                        cvss  = item.get("cvss", {})
                        score = cvss.get("score", 0) if cvss else 0
                        cwe   = ", ".join(item.get("cwe", []))
                        advisory_html = f'<a href="{he(url)}">{he(url.split("/")[-1] if url else "")}</a>' if url else "—"
                        score_html = f'CVSS {score:.1f}' if score else ""
                        title_html = he(title) + (f' <span style="color:#888;font-size:10px">{he(cwe)} {he(score_html)}</span>' if cwe or score_html else "")
                        parts.append(f'<tr><td class="mono">{he(pkg_name)}</td><td>{sev_badge(severity)}</td><td style="font-size:11px">{title_html}</td><td style="font-size:11px">{advisory_html}</td><td style="font-size:11px">{fix_str}</td></tr>')
                    else:
                        parts.append(f'<tr><td class="mono">{he(pkg_name)}</td><td>{sev_badge(severity)}</td><td style="font-size:11px">{he(str(item))}</td><td>—</td><td style="font-size:11px">{fix_str}</td></tr>')
            else:
                parts.append(f'<tr><td class="mono">{he(pkg_name)}</td><td>{sev_badge(severity)}</td><td style="font-size:11px">—</td><td>—</td><td style="font-size:11px">{fix_str}</td></tr>')

        parts.append('</tbody></table></div>')

    return "\n".join(parts)

# ── Section 6: Acceptance criteria coverage ───────────────────────────────────

def build_ac_section():
    parts = ['<h2>Acceptance Criteria Coverage</h2>']

    if not prd:
        parts.append('<p class="no-data">PRD file not found or invalid JSON.</p>')
        return "\n".join(parts)

    stories = prd.get("stories", [])
    if not stories:
        parts.append('<p class="no-data">No stories found in PRD.</p>')
        return "\n".join(parts)

    # Build a flat set of all verified facts across all phases for matching
    all_facts_lower = set()
    for tc_data in tc_by_phase.values():
        for story_id, sd in tc_data.items():
            for fact in sd.get("facts", []):
                all_facts_lower.add(fact.lower()[:80])

    for story in stories:
        sid    = story.get("id", "?")
        title  = story.get("title", "")
        status = story.get("status", "pending")
        acs    = story.get("acceptanceCriteria", [])

        # Check if this story has TC facts
        story_tc = None
        for tc_data in tc_by_phase.values():
            if sid in tc_data:
                story_tc = tc_data[sid]
                break

        status_badge = badge("completed", "pass") if story.get("completed") or status == "completed" else badge(status, "warn" if status != "pending" else "skip")

        parts.append(f'<h3>{he(sid)}: {he(title)} &nbsp; {status_badge}</h3>')

        if not acs:
            parts.append('<p class="no-data">No acceptance criteria defined.</p>')
            continue

        parts.append('<div class="tbl-wrap"><table>')
        parts.append('<thead><tr><th style="width:75%">Acceptance Criterion</th><th>Coverage</th></tr></thead>')
        parts.append('<tbody>')

        for ac in acs:
            # Fuzzy match: check if any fact overlaps with first 60 chars of AC
            ac_snippet = ac.lower()[:60]
            covered = any(
                ac_snippet[:40] in f or f[:40] in ac_snippet
                for f in all_facts_lower
            )
            # Also check if story TC facts exist at all
            if story_tc and story_tc.get("facts"):
                covered_by_facts = covered
            else:
                covered_by_facts = None  # unknown

            if covered_by_facts is True:
                cov_html = '<span class="ac-addressed">✓ verified</span>'
            elif covered_by_facts is False:
                cov_html = '<span class="ac-unknown">? unverified</span>'
            else:
                cov_html = '<span class="ac-unknown">— no TC data</span>'

            parts.append(f'<tr><td style="font-size:11px">{he(ac)}</td><td style="white-space:nowrap">{cov_html}</td></tr>')

        parts.append('</tbody></table></div>')

    return "\n".join(parts)

# ── Assemble HTML ──────────────────────────────────────────────────────────────

vitest_html   = build_vitest_section()
tc_html       = build_tc_section()
gate_html     = build_gate_section()
npm_html      = build_npm_section()
ac_html       = build_ac_section()

now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Report — {he(run_ts_fmt)}</title>
  <style>
{CSS}
  </style>
</head>
<body>
{header_html}
<hr class="section-sep">
{vitest_html}
<hr class="section-sep">
{tc_html}
<hr class="section-sep">
{gate_html}
<hr class="section-sep">
{npm_html}
<hr class="section-sep">
{ac_html}
<hr class="section-sep">
<p style="color:#333;font-size:11px;text-align:center;padding:16px 0;">
  Generated {he(now_str)} by generate-qa-report.sh &nbsp;|&nbsp; epam-cli orchestration pipeline
</p>
</body>
</html>
"""

# Write output
Path(OUT_FILE).write_text(html, encoding="utf-8")
print(f"[qa-report] ✓ Wrote {len(html):,} bytes to {OUT_FILE}", file=sys.stderr)
