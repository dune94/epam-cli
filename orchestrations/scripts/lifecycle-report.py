#!/usr/bin/env python3
"""
lifecycle-report.py — Full lifecycle metrics report for a single story run.

Reads from all orchestration log files and produces a unified JSON report
and an HTML summary showing per-stage metrics, SDK vs CLI comparison,
and quality scores across the full spec → estimate → implement → review pipeline.

Usage:
  python3 lifecycle-report.py --story SDK-TEST-001 --phase sdk_lifecycle_test
  python3 lifecycle-report.py --story SDK-TEST-001 --phase sdk_lifecycle_test --html report.html
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent
AUTOMATION_DIR = SCRIPT_DIR.parent
LOG_DIR = AUTOMATION_DIR / "logs"
PRD_FILE = AUTOMATION_DIR / "prd.json"


def load_jsonl(path):
    """Parse a file containing one or more JSON objects (single-line JSONL or pretty-printed)."""
    records = []
    try:
        with open(path) as f:
            content = f.read()
    except FileNotFoundError:
        return records

    # First try: single-line JSONL
    for line in content.splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    if records:
        return records

    # Second try: concatenated multi-line JSON objects using raw_decode
    decoder = json.JSONDecoder()
    pos = 0
    content = content.strip()
    while pos < len(content):
        # Skip whitespace
        while pos < len(content) and content[pos] in ' \t\n\r':
            pos += 1
        if pos >= len(content):
            break
        try:
            obj, end = decoder.raw_decode(content, pos)
            records.append(obj)
            pos = end
        except json.JSONDecodeError:
            break

    return records


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def get_story(prd, story_id):
    return next((s for s in prd.get("stories", []) if s["id"] == story_id), None)


# ── Stage collectors ──────────────────────────────────────────────────────────

def collect_spec(story_id):
    records = load_jsonl(LOG_DIR / "spec-phase.jsonl")
    story_records = [r for r in records if r.get("story_id") == story_id]
    if not story_records:
        return None

    agents = []
    ac_before = ac_after = None
    for r in story_records:
        agent = r.get("agent", "unknown")
        before = r.get("before", {})
        after = r.get("after", {})
        ac_b = before.get("acceptanceCriteria", [])
        ac_a = after.get("acceptanceCriteria", [])
        if ac_before is None:
            ac_before = ac_b
        ac_after = ac_a
        agents.append({
            "agent": agent,
            "ac_before": len(ac_b),
            "ac_after": len(ac_a),
            "ac_added": [x for x in ac_a if x not in ac_b],
            "ac_removed": [x for x in ac_b if x not in ac_a],
            "splits": len(r.get("splitStories", [])),
            "notes": r.get("notes", ""),
            "timestamp": r.get("timestamp"),
        })

    # Coordinator quality score (look in spec-runs logs)
    quality_score = None
    run_dirs = sorted((LOG_DIR / "spec-runs").glob("*/")) if (LOG_DIR / "spec-runs").exists() else []
    for run_dir in reversed(run_dirs):
        summary_file = run_dir / "summary.json"
        if summary_file.exists():
            summary = load_json(summary_file)
            for s in summary.get("stories", []):
                if s.get("storyId") == story_id:
                    quality_score = s.get("qualityScore")
                    break

    return {
        "stage": "spec",
        "agents_run": [a["agent"] for a in agents],
        "agent_details": agents,
        "ac_count_before": len(ac_before) if ac_before else 0,
        "ac_count_after": len(ac_after) if ac_after else 0,
        "ac_net_added": len(ac_after) - len(ac_before) if ac_before and ac_after else 0,
        "quality_score": quality_score,
        "run_count": len(story_records),
    }


def collect_cpa(story_id):
    records = load_jsonl(LOG_DIR / "cpa-review.jsonl")
    matches = [r for r in records if r.get("storyId") == story_id]
    if not matches:
        return None

    latest = matches[-1]
    blended = latest.get("blendedEstimate", {})
    formula = latest.get("formulaEstimate", {})
    cpa = latest.get("cpaEstimate", {})

    return {
        "stage": "cpa",
        "confidence": latest.get("confidence"),
        "gate": latest.get("gate"),
        "complexity_adjustment": latest.get("complexityAdjustment"),
        "risk_flags": latest.get("riskFlags", []),
        "missing_kb_coverage": latest.get("missingKbCoverage", []),
        "formula_minutes": formula.get("aiMinutes", 0),
        "cpa_minutes": cpa.get("aiMinutes", 0) if cpa else None,
        "blended_minutes": blended.get("aiMinutes", 0),
        "formula_cost": formula.get("cost", 0),
        "blended_cost": blended.get("cost", 0),
        "formula_tokens": formula.get("tokens", 0),
        "blended_tokens": blended.get("tokens", 0),
        "kb_chunks_used": latest.get("kbChunksUsed", 0),
        "timestamp": latest.get("timestamp"),
    }


def collect_implementation(story_id):
    records = load_jsonl(LOG_DIR / "phase-cost.jsonl")
    matches = [r for r in records if r.get("story_id") == story_id]
    if not matches:
        return None

    latest = matches[-1]
    return {
        "stage": "implementation",
        "status": latest.get("status"),
        "started_at": latest.get("started_at"),
        "ended_at": latest.get("ended_at"),
        "elapsed_minutes": latest.get("elapsed_minutes", 0),
        "tokens_in": latest.get("task_tokens_in", 0),
        "tokens_out": latest.get("task_tokens_out", 0),
        "cache_create_tokens": latest.get("cache_create_tokens", 0),
        "cache_read_tokens": latest.get("cache_read_tokens", 0),
        "cost_usd": latest.get("task_cost_usd", 0),
        "turns": latest.get("task_turns", 0),
        "model": latest.get("resolvedModel", ""),
        "forecast_hours": latest.get("forecast_hours", 0),
        "attempt_count": len(matches),
    }


def collect_review(story_id, phase_id):
    records = load_jsonl(LOG_DIR / "code-reviews.jsonl")
    # Match by story_id field, phase_id field, or story_id appearing in stories_reviewed list
    matches = [r for r in records if
               r.get("story_id") == story_id or
               r.get("phase_id") == phase_id or
               (isinstance(r.get("stories_reviewed"), list) and story_id in r.get("stories_reviewed", []))]
    if not matches:
        return None

    latest = matches[-1]
    findings = latest.get("findings", [])
    blockers = [f for f in findings if f.get("severity") == "blocker"]
    majors = [f for f in findings if f.get("severity") == "major"]
    minors = [f for f in findings if f.get("severity") == "minor"]

    # Support both review_status and verdict field names
    raw_verdict = (latest.get("verdict")
                   or latest.get("overallVerdict")
                   or latest.get("review_status")
                   or "unknown")

    return {
        "stage": "review",
        "verdict": raw_verdict,
        "iteration": latest.get("iteration", 1),
        "blockers": len(blockers),
        "majors": len(majors),
        "minors": len(minors),
        "findings": findings[:10],
        "issues_found": latest.get("issues_found", 0),
        "timestamp": latest.get("timestamp"),
    }


def collect_gate(phase_id):
    records = load_jsonl(LOG_DIR / "phase-gates.jsonl")
    matches = [r for r in records if r.get("phase_id") == phase_id]
    if not matches:
        return None

    latest = matches[-1]
    criteria = latest.get("criteria", latest.get("checks", {}))
    # Normalize boolean criteria to pass/fail labels
    checks = {k: v for k, v in criteria.items() if isinstance(v, bool)}
    return {
        "stage": "gate",
        "verdict": latest.get("verdict") or latest.get("decision"),
        "checks": checks,
        "cost_variance_pct": criteria.get("cost_variance_pct"),
        "notes": latest.get("notes"),
        "timestamp": latest.get("timestamp"),
    }


# ── SDK metrics extraction ────────────────────────────────────────────────────

def collect_sdk_metrics(story_id):
    """Read invoke.py result files from claude_outputs dir."""
    outputs_dir = LOG_DIR / "claude_outputs"
    if not outputs_dir.exists():
        return None

    result_files = sorted(outputs_dir.glob(f"{story_id}_*_result.json"))
    if not result_files:
        return None

    results = []
    for rf in result_files:
        data = load_json(rf)
        if data:
            results.append({
                "file": rf.name,
                "input_tokens": data.get("usage", {}).get("input_tokens", 0),
                "output_tokens": data.get("usage", {}).get("output_tokens", 0),
                "cache_creation_tokens": data.get("usage", {}).get("cache_creation_input_tokens", 0),
                "cache_read_tokens": data.get("usage", {}).get("cache_read_input_tokens", 0),
                "num_turns": data.get("num_turns", 0),
            })

    return results if results else None


# ── Report assembly ───────────────────────────────────────────────────────────

def build_report(story_id, phase_id, prd):
    story = get_story(prd, story_id)
    if not story:
        print(f"ERROR: Story {story_id} not found in prd.json", file=sys.stderr)
        sys.exit(1)

    spec = collect_spec(story_id)
    cpa = collect_cpa(story_id)
    impl = collect_implementation(story_id)
    review = collect_review(story_id, phase_id)
    gate = collect_gate(phase_id)
    sdk_metrics = collect_sdk_metrics(story_id)

    stages_run = [s for s in [spec, cpa, impl, review, gate] if s is not None]
    stages_missing = []
    for name in ["spec", "cpa", "implementation", "review", "gate"]:
        if not any(s.get("stage") == name for s in stages_run):
            stages_missing.append(name)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "story_id": story_id,
        "phase_id": phase_id,
        "story": {
            "title": story.get("title"),
            "effort": story.get("effort"),
            "estimated_hours": story.get("estimatedHours"),
            "ac_count_original": len(story.get("acceptanceCriteria", [])),
            "agent_role": story.get("agentRole"),
        },
        "sdk_invoke_active": bool(sdk_metrics),
        "stages": {
            "spec": spec,
            "cpa": cpa,
            "implementation": impl,
            "review": review,
            "gate": gate,
        },
        "sdk_raw_metrics": sdk_metrics,
        "stages_run": [s["stage"] for s in stages_run],
        "stages_missing": stages_missing,
        "summary": build_summary(spec, cpa, impl, review, gate),
    }
    return report


def build_summary(spec, cpa, impl, review, gate):
    total_tokens = 0
    total_cost = 0.0
    if impl:
        total_tokens = impl.get("tokens_in", 0) + impl.get("tokens_out", 0)
        total_cost = impl.get("cost_usd", 0)

    forecast_min = cpa.get("blended_minutes", 0) if cpa else 0
    actual_min = impl.get("elapsed_minutes", 0) if impl else 0
    variance_pct = None
    if forecast_min and actual_min:
        variance_pct = round(((actual_min - forecast_min) / forecast_min) * 100, 1)

    return {
        "overall_verdict": gate.get("verdict") if gate else (review.get("verdict") if review else "incomplete"),
        "ac_count_original": spec.get("ac_count_before") if spec else None,
        "ac_count_final": spec.get("ac_count_after") if spec else None,
        "cpa_confidence": cpa.get("confidence") if cpa else None,
        "cpa_gate": cpa.get("gate") if cpa else None,
        "total_tokens": total_tokens,
        "total_cost_usd": total_cost,
        "elapsed_minutes": actual_min,
        "forecast_minutes": forecast_min,
        "forecast_vs_actual_pct": variance_pct,
        "review_verdict": review.get("verdict") if review else None,
        "review_blockers": review.get("blockers", 0) if review else 0,
    }


# ── HTML report ───────────────────────────────────────────────────────────────

def render_html(report):
    story = report["story"]
    summary = report["summary"]
    stages = report["stages"]
    sdk_active = report["sdk_invoke_active"]
    generated = report["generated_at"]

    def badge(text, color):
        colors = {
            "green": "#16a34a", "red": "#dc2626", "yellow": "#d97706",
            "blue": "#2563eb", "grey": "#6b7280", "purple": "#7c3aed"
        }
        c = colors.get(color, "#6b7280")
        return f'<span style="background:{c};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">{text}</span>'

    def verdict_badge(v):
        if not v:
            return badge("MISSING", "grey")
        v = str(v).lower()
        if v in ("pass", "approved", "go"):
            return badge(v.upper(), "green")
        if v in ("fail", "block", "failed"):
            return badge(v.upper(), "red")
        if v in ("warn", "review", "changes_requested"):
            return badge(v.upper(), "yellow")
        return badge(v.upper(), "grey")

    spec = stages.get("spec") or {}
    cpa = stages.get("cpa") or {}
    impl = stages.get("implementation") or {}
    review = stages.get("review") or {}
    gate = stages.get("gate") or {}

    sdk_badge = badge("SDK ACTIVE", "purple") if sdk_active else badge("CLI MODE", "grey")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Lifecycle Report — {report['story_id']}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }}
  h1 {{ font-size: 22px; margin-bottom: 4px; }}
  .meta {{ color: #64748b; font-size: 12px; margin-bottom: 24px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }}
  .card {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }}
  .card h3 {{ font-size: 11px; text-transform: uppercase; color: #64748b; margin: 0 0 8px; }}
  .card .val {{ font-size: 24px; font-weight: 700; }}
  .card .sub {{ font-size: 11px; color: #64748b; margin-top: 4px; }}
  .stage {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 16px; }}
  .stage h2 {{ font-size: 15px; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th {{ text-align: left; color: #64748b; font-size: 11px; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }}
  td {{ padding: 6px 8px; border-bottom: 1px solid #f1f5f9; }}
  .missing {{ color: #94a3b8; font-style: italic; }}
  .ac-list {{ font-size: 12px; line-height: 1.6; padding-left: 16px; }}
  .sdk-box {{ background: #f5f3ff; border: 1px solid #c4b5fd; border-radius: 8px; padding: 16px; margin-bottom: 16px; }}
  .sdk-box h2 {{ font-size: 15px; color: #7c3aed; margin: 0 0 12px; }}
</style>
</head>
<body>

<h1>Lifecycle Report — {report['story_id']}</h1>
<div class="meta">
  {story['title']} &nbsp;·&nbsp;
  {badge(story['effort'].upper(), 'blue')} &nbsp;
  {sdk_badge} &nbsp;
  Generated: {generated}
</div>

<!-- Summary Cards -->
<div class="grid">
  <div class="card">
    <h3>Overall Verdict</h3>
    <div class="val">{verdict_badge(summary.get('overall_verdict'))}</div>
  </div>
  <div class="card">
    <h3>Total Tokens</h3>
    <div class="val">{summary.get('total_tokens', 0):,}</div>
    <div class="sub">in + out</div>
  </div>
  <div class="card">
    <h3>Total Cost</h3>
    <div class="val">${summary.get('total_cost_usd', 0):.4f}</div>
  </div>
  <div class="card">
    <h3>AC Coverage</h3>
    <div class="val">{summary.get('ac_count_original', '?')} → {summary.get('ac_count_final', '?')}</div>
    <div class="sub">before → after spec</div>
  </div>
  <div class="card">
    <h3>CPA Confidence</h3>
    <div class="val">{f"{summary.get('cpa_confidence', 0):.0%}" if summary.get('cpa_confidence') else 'N/A'}</div>
    <div class="sub">{summary.get('cpa_gate', '')}</div>
  </div>
  <div class="card">
    <h3>Elapsed vs Forecast</h3>
    <div class="val">{summary.get('elapsed_minutes', 0):.1f}m</div>
    <div class="sub">Forecast: {summary.get('forecast_minutes', 0):.1f}m
      {"  (" + (("+" if summary.get('forecast_vs_actual_pct', 0) > 0 else "") + str(summary.get('forecast_vs_actual_pct')) + "%)") if summary.get('forecast_vs_actual_pct') is not None else ""}
    </div>
  </div>
</div>

<!-- Stage 0: Spec -->
<div class="stage">
  <h2>Stage 0 — Spec &nbsp; {verdict_badge('pass' if spec else None)}</h2>
  {"<p class='missing'>No spec data found in spec-phase.jsonl</p>" if not spec else f'''
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Agents run</td><td>{", ".join(spec.get("agents_run", []))}</td></tr>
    <tr><td>AC before</td><td>{spec.get("ac_count_before", 0)}</td></tr>
    <tr><td>AC after</td><td>{spec.get("ac_count_after", 0)}</td></tr>
    <tr><td>Net AC added</td><td>{spec.get("ac_net_added", 0):+d}</td></tr>
    <tr><td>Quality score</td><td>{spec.get("quality_score", "N/A")}</td></tr>
  </table>
  {"".join(f"""
  <div style="margin-top:12px;font-size:12px;color:#64748b;font-weight:600">{a['agent']} contribution:</div>
  {"<ul class='ac-list'>" + "".join(f"<li>+ {x}</li>" for x in a.get("ac_added",[])) + "</ul>" if a.get("ac_added") else "<div style='font-size:12px;color:#94a3b8;padding-left:8px'>No AC changes</div>"}
  """ for a in spec.get("agent_details", []))}
  '''}
</div>

<!-- Stage 0.1: CPA -->
<div class="stage">
  <h2>Stage 0.1 — CPA Estimate &nbsp; {verdict_badge(cpa.get('gate')) if cpa else verdict_badge(None)}</h2>
  {"<p class='missing'>No CPA data found in cpa-review.jsonl</p>" if not cpa else f'''
  <table>
    <tr><th>Metric</th><th>Formula</th><th>CPA Blended</th></tr>
    <tr><td>Minutes</td><td>{cpa.get("formula_minutes", 0):.1f}</td><td>{cpa.get("blended_minutes", 0):.1f}</td></tr>
    <tr><td>Cost (USD)</td><td>${cpa.get("formula_cost", 0):.4f}</td><td>${cpa.get("blended_cost", 0):.4f}</td></tr>
    <tr><td>Tokens</td><td>{cpa.get("formula_tokens", 0):,}</td><td>{cpa.get("blended_tokens", 0):,}</td></tr>
    <tr><td>Confidence</td><td colspan="2">{cpa.get("confidence", 0):.2f}</td></tr>
    <tr><td>Gate</td><td colspan="2">{verdict_badge(cpa.get("gate"))}</td></tr>
  </table>
  {"<div style='margin-top:12px;font-size:12px'><b>Risk flags:</b><ul class='ac-list'>" + "".join(f"<li>{f}</li>" for f in cpa.get("risk_flags",[])) + "</ul></div>" if cpa.get("risk_flags") else ""}
  '''}
</div>

<!-- Stage 1: Implementation -->
<div class="stage">
  <h2>Stage 1 — Implementation &nbsp; {verdict_badge('pass' if impl and impl.get('status')=='completed' else ('fail' if impl else None))}</h2>
  {"<p class='missing'>No implementation data found in phase-cost.jsonl</p>" if not impl else f'''
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Status</td><td>{impl.get("status","")}</td></tr>
    <tr><td>Model</td><td>{impl.get("model","")}</td></tr>
    <tr><td>Elapsed</td><td>{impl.get("elapsed_minutes",0):.2f} min</td></tr>
    <tr><td>Turns</td><td>{impl.get("turns",0)}</td></tr>
    <tr><td>Input tokens</td><td>{impl.get("tokens_in",0):,}</td></tr>
    <tr><td>Output tokens</td><td>{impl.get("tokens_out",0):,}</td></tr>
    <tr><td>Cache create tokens</td><td>{impl.get("cache_create_tokens",0):,}</td></tr>
    <tr><td>Cache read tokens</td><td>{impl.get("cache_read_tokens",0):,}</td></tr>
    <tr><td>Cost (USD)</td><td>${impl.get("cost_usd",0):.6f}</td></tr>
    <tr><td>Attempts</td><td>{impl.get("attempt_count",1)}</td></tr>
  </table>
  '''}
</div>

<!-- Stage 2: Review -->
<div class="stage">
  <h2>Stage 2 — Code Review &nbsp; {verdict_badge(review.get('verdict')) if review else verdict_badge(None)}</h2>
  {"<p class='missing'>No review data found in code-reviews.jsonl</p>" if not review else f'''
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Verdict</td><td>{verdict_badge(review.get("verdict"))}</td></tr>
    <tr><td>Iterations</td><td>{review.get("iteration",1)}</td></tr>
    <tr><td>Blockers</td><td>{review.get("blockers",0)}</td></tr>
    <tr><td>Majors</td><td>{review.get("majors",0)}</td></tr>
    <tr><td>Minors</td><td>{review.get("minors",0)}</td></tr>
  </table>
  '''}
</div>

<!-- Stage 3: Phase Gate -->
<div class="stage">
  <h2>Stage 3 — Phase Gate &nbsp; {verdict_badge(gate.get('verdict')) if gate else verdict_badge(None)}</h2>
  {"<p class='missing'>No gate data found in phase-gates.jsonl</p>" if not gate else f'''
  <table>
    <tr><th>Check</th><th>Result</th></tr>
    {"".join(f"<tr><td>{k}</td><td>{verdict_badge('pass' if v else 'fail')}</td></tr>" for k,v in gate.get("checks",{}).items())}
  </table>
  '''}
</div>

<!-- Raw JSON -->
<details style="margin-top:24px">
  <summary style="cursor:pointer;font-size:13px;color:#64748b">Raw JSON report</summary>
  <pre style="background:#1e293b;color:#e2e8f0;padding:16px;border-radius:8px;font-size:11px;overflow:auto;margin-top:8px">{json.dumps(report, indent=2, default=str)}</pre>
</details>

</body>
</html>"""
    return html


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--story", required=True)
    p.add_argument("--phase", required=True)
    p.add_argument("--html", help="Write HTML report to this path")
    p.add_argument("--json-out", help="Write JSON report to this path")
    args = p.parse_args()

    prd = load_json(PRD_FILE)
    report = build_report(args.story, args.phase, prd)

    json_str = json.dumps(report, indent=2, default=str)

    if args.json_out:
        Path(args.json_out).write_text(json_str)
        print(f"JSON report: {args.json_out}")
    else:
        print(json_str)

    if args.html:
        html = render_html(report)
        Path(args.html).write_text(html)
        print(f"HTML report: {args.html}")


if __name__ == "__main__":
    main()
