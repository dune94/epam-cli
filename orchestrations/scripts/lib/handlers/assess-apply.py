import json, re, sys, os
from datetime import datetime, timezone

summary_file, raw_file, assessment_file, report_file, prd_file = sys.argv[1:6]

with open(summary_file) as f:
    summary = json.load(f)
raw = open(raw_file).read()

decoder = json.JSONDecoder()
payload = {}
idx = 0
while True:
    start = raw.find('{', idx)
    if start == -1:
        break
    try:
        obj, end = decoder.raw_decode(raw, start)
        if isinstance(obj, dict) and ('notes' in obj or 'agent_recommendations' in obj or 'role_reassignments' in obj):
            payload = obj
            break
        idx = end
    except json.JSONDecodeError:
        idx = start + 1

notes = payload.get('notes') or ('No improvements needed.' if not summary['over_threshold'] and not summary['future_pending_stories'] else '')
recommendations = payload.get('agent_recommendations') or []
reassignments = payload.get('role_reassignments') or []

record = {
    'phase_id': summary['phase_id'],
    'phase_name': summary['phase_id'],
    'actual_minutes': summary['actual_minutes'],
    'forecast_minutes': summary['forecast_minutes'],
    'actual_cost_usd': summary['actual_cost_usd'],
    'forecast_cost_usd': summary['forecast_cost_usd'],
    'variance_minutes': summary['variance_minutes'],
    'variance_cost_usd': summary['variance_cost_usd'],
    'over_threshold': summary['over_threshold'],
    'agent_recommendations': recommendations,
    'notes': notes,
    }
with open(assessment_file, 'a') as f:
    f.write(json.dumps(record) + '\n')

# Re-validate reassignments against the SAME future_pending_stories set the
# LLM was given — never trust a story_id/role pair from the model's own
# text without re-checking it against real, deterministically-computed
# eligibility (pending, not completed, phase strictly after this one).
eligible = {s['story_id']: s for s in summary['future_pending_stories']}
applied = []
if reassignments:
    with open(prd_file) as f:
        prd = json.load(f)
    stories_by_id = {s['id']: s for s in prd.get('stories', []) if s.get('id')}
    changed = False
    for r in reassignments:
        sid = r.get('story_id')
        new_role = r.get('newAgentRole')
        if not sid or not new_role or sid not in eligible:
            continue
        story = stories_by_id.get(sid)
        if not story or story.get('status') != 'pending' or story.get('completed'):
            continue
        if story.get('agentRole') == new_role:
            continue
        if 'originalAgentRole' not in story:
            story['originalAgentRole'] = story.get('agentRole')
        story['agentRole'] = new_role
        applied.append({'story_id': sid, 'newAgentRole': new_role, 'reason': r.get('reason', '')})
        changed = True
    if changed:
        tmp_path = prd_file + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(prd, f, indent=2)
        os.replace(tmp_path, prd_file)

ts = datetime.now(timezone.utc).isoformat()
lines = [
    f"# Phase Improvement Report: {summary['phase_id']}",
    f"_Generated: {ts}_",
    "",
    f"- Actual: {summary['actual_minutes']} min / ${summary['actual_cost_usd']}",
    f"- Forecast: {summary['forecast_minutes']} min / ${summary['forecast_cost_usd']}",
    f"- Variance: {summary['variance_minutes']} min / ${summary['variance_cost_usd']}",
    f"- Over threshold ({summary['over_threshold_pct']}%): {summary['over_threshold']}",
    "",
    "## Notes",
    notes,
]
if recommendations:
    lines += ["", "## Recommendations"] + [f"- {r}" for r in recommendations]
if applied:
    lines += ["", "## Role reassignments applied"] + [
        f"- {a['story_id']}: -> {a['newAgentRole']} ({a['reason']})" for a in applied
    ]
with open(report_file, 'w') as f:
    f.write("\n".join(lines) + "\n")

print(f"assessment record written; {len(applied)} role reassignment(s) applied")
