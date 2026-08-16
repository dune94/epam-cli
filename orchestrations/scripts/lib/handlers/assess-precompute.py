import json, os, sys
from datetime import datetime

cost_file, prd_file, phase_id, out_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None

# Dedupe: for each story_id, keep only the record with the highest started_at
# (the log accumulates records across multiple runs of the same phase).
latest = {}
with open(cost_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get('phase_id') != phase_id:
            continue
        sid = rec.get('story_id')
        if not sid:
            continue
        prev = latest.get(sid)
        if prev is None or (rec.get('started_at') or '') > (prev.get('started_at') or ''):
            latest[sid] = rec

with open(prd_file) as f:
    prd = json.load(f)

stories_by_id = {s['id']: s for s in prd.get('stories', []) if s.get('id')}

# implementationOrder is the authoritative phase->story-ids mapping (a
# story's own optional .phase field is not reliably populated) — build a
# reverse lookup and use ordering position to find phases AFTER this one,
# for the corrective-action scope.
impl_order = prd.get('implementationOrder', {}) or {}
phase_names = list(impl_order.keys())
story_to_phase = {}
for pname, ids in impl_order.items():
    for sid in (ids or []):
        story_to_phase[sid] = pname
try:
    future_phases = set(phase_names[phase_names.index(phase_id) + 1:])
except ValueError:
    future_phases = set()

# Only records whose story_id matches a REAL PRD story are per-story
# variance data — other story_ids (e.g. "core", "pipeline") are gate/
# pipeline-level cost records, not story work, and are excluded here.
per_story = []
actual_minutes_total = 0.0
forecast_minutes_total = 0.0
actual_cost_total = 0.0
forecast_cost_total = 0.0

for sid, rec in latest.items():
    story = stories_by_id.get(sid)
    if not story:
        continue
    completed = bool(story.get('completed'))
    status = 'succeeded' if completed else rec.get('status', 'unknown')
    started = parse_ts(rec.get('started_at'))
    ended = parse_ts(rec.get('ended_at'))
    elapsed_minutes = 0.0
    if started and ended:
        elapsed_minutes = max(0.0, (ended - started).total_seconds() / 60.0)
    forecast_minutes = story.get('estimatedAiMinutes')
    if forecast_minutes is None:
        forecast_minutes = (story.get('estimatedHours') or 0) * 60
    forecast_cost = story.get('estimatedCost') or 0
    actual_cost = rec.get('task_cost_usd') or 0

    actual_minutes_total += elapsed_minutes
    forecast_minutes_total += forecast_minutes
    actual_cost_total += actual_cost
    forecast_cost_total += forecast_cost

    per_story.append({
        'story_id': sid,
        'status': status,
        'elapsed_minutes': round(elapsed_minutes, 3),
        'forecast_minutes': round(forecast_minutes, 3),
        'actual_cost_usd': round(actual_cost, 4),
        'forecast_cost_usd': round(forecast_cost, 4),
        'description': story.get('description', ''),
        'agentRole': story.get('agentRole', ''),
    })

variance_minutes = actual_minutes_total - forecast_minutes_total
variance_cost_usd = actual_cost_total - forecast_cost_total
threshold_pct = float(os.environ.get('PHASE_ASSESSMENT_OVER_THRESHOLD_PCT', '20'))
over_threshold = (
    forecast_minutes_total > 0
    and actual_minutes_total > forecast_minutes_total * (1 + threshold_pct / 100.0)
)

future_pending_stories = []
for s in prd.get('stories', []):
    sid = s.get('id')
    if story_to_phase.get(sid) in future_phases and s.get('status') == 'pending' and not s.get('completed'):
        future_pending_stories.append({
            'story_id': sid,
            'description': s.get('description', ''),
            'agentRole': s.get('agentRole', ''),
            'phase': story_to_phase.get(sid),
        })

summary = {
    'phase_id': phase_id,
    'actual_minutes': round(actual_minutes_total, 3),
    'forecast_minutes': round(forecast_minutes_total, 3),
    'actual_cost_usd': round(actual_cost_total, 4),
    'forecast_cost_usd': round(forecast_cost_total, 4),
    'variance_minutes': round(variance_minutes, 3),
    'variance_cost_usd': round(variance_cost_usd, 4),
    'over_threshold': over_threshold,
    'over_threshold_pct': threshold_pct,
    'per_story': per_story,
    'future_pending_stories': future_pending_stories,
    }

with open(out_file, 'w') as f:
    json.dump(summary, f, indent=2)
