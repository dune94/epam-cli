import json
import datetime
from collections import defaultdict

# Read phase cost data
cost_data = []
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-cost.jsonl', 'r') as f:
    for line in f:
        if '"phase_id":"scaffold"' in line:
            try:
                data = json.loads(line.strip())
                cost_data.append(data)
            except json.JSONDecodeError:
                continue

# Get the latest record for each story_id
latest_records = {}
for record in cost_data:
    story_id = record.get('story_id')
    if story_id:
        if story_id not in latest_records or record.get('started_at') > latest_records[story_id].get('started_at'):
            latest_records[story_id] = record

# Filter to only actual implementation stories (not agent types)
implementation_stories = {k: v for k, v in latest_records.items() if k != 'scaffold' and not k.startswith('qa-gate') and not k.startswith('spec-pass') and not k.startswith('team-lead-agent')}

# Read JIRA data
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/tmp/jira-orch-be-prd-31798.json', 'r') as f:
    jira_data = json.load(f)

# Create a mapping of story IDs to their completion status
story_status = {}
for story in jira_data.get('stories', []):
    story_id = story.get('id')
    if story_id:
        story_status[story_id] = {
            'completed': story.get('completed', False),
            'agentRole': story.get('agentRole', ''),
            'status': story.get('status', 'pending')
        }

# Process the scaffold phase data
actual_minutes = 0
forecast_minutes = 0
actual_cost_usd = 0
forecast_cost_usd = 0
variance_minutes = 0
variance_cost_usd = 0
over_threshold = False
agent_recommendations = []
notes = []

# Process implementation stories
for story_id, record in implementation_stories.items():
    # Check if this story is completed in JIRA (source of truth)
    jira_story = story_status.get(story_id, {})
    is_completed = jira_story.get('completed', False)
    
    # If completed in JIRA, treat as succeeded regardless of cost log
    if is_completed:
        # Use the actual values from the cost log
        elapsed_minutes = record.get('elapsed_minutes', 0)
        forecast_hours = record.get('forecast_hours', 0)
        task_cost_usd = record.get('task_cost_usd', 0)
        forecast_cost_usd_value = record.get('forecast_cost_usd', 0)
        
        actual_minutes += elapsed_minutes
        forecast_minutes += (forecast_hours * 60)
        actual_cost_usd += task_cost_usd
        forecast_cost_usd += forecast_cost_usd_value
        
        # Calculate variance
        variance_minutes += (elapsed_minutes - (forecast_hours * 60))
        variance_cost_usd += (task_cost_usd - forecast_cost_usd_value)
        
        # Check if variance exceeds threshold (let's say 10%)
        if forecast_hours > 0:
            variance_percent = abs(elapsed_minutes - (forecast_hours * 60)) / (forecast_hours * 60) * 100
            if variance_percent > 10:
                over_threshold = True
                agent_recommendations.append(f"Story {story_id} variance ({variance_percent:.1f}%) exceeds 10% threshold")
    else:
        # For pending stories, we don't include them in the assessment
        pass

# Write assessment to JSONL file
assessment = {
    "phase_id": "scaffold",
    "phase_name": "scaffold",
    "actual_minutes": actual_minutes,
    "forecast_minutes": forecast_minutes,
    "actual_cost_usd": actual_cost_usd,
    "forecast_cost_usd": forecast_cost_usd,
    "variance_minutes": variance_minutes,
    "variance_cost_usd": variance_cost_usd,
    "over_threshold": over_threshold,
    "agent_recommendations": agent_recommendations,
    "notes": notes
}

# Write to assessment file
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-skill-assessments.jsonl', 'a') as f:
    f.write(json.dumps(assessment) + '\n')

# Generate improvement report
improvement_report = f"""# Scaffold Phase Improvement Report

## Summary
- **Actual Minutes**: {actual_minutes:.2f}
- **Forecast Minutes**: {forecast_minutes:.2f}
- **Variance Minutes**: {variance_minutes:.2f}
- **Actual Cost (USD)**: ${actual_cost_usd:.4f}
- **Forecast Cost (USD)**: ${forecast_cost_usd:.4f}
- **Variance Cost (USD)**: ${variance_cost_usd:.4f}
- **Over Threshold**: {over_threshold}

## Analysis

The scaffold phase had {len(implementation_stories)} implementation stories. Based on the JIRA data, only SKY-001 was completed, so we're assessing that story.

## Task Analysis

### SKY-001: Scaffold TypeScript project with Vitest and Express
- **Forecast Hours**: {implementation_stories.get('SKY-001', {}).get('forecast_hours', 0)}
- **Actual Minutes**: {implementation_stories.get('SKY-001', {}).get('elapsed_minutes', 0)}
- **Forecast Cost**: ${implementation_stories.get('SKY-001', {}).get('forecast_cost_usd', 0):.4f}
- **Actual Cost**: ${implementation_stories.get('SKY-001', {}).get('task_cost_usd', 0):.4f}

## Recommendations

"""

if not agent_recommendations:
    improvement_report += "No improvements needed.\n"
else:
    improvement_report += "\n".join(agent_recommendations) + "\n"

# Write improvement report
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-improvements/scaffold.md', 'w') as f:
    f.write(improvement_report)

print("Analysis complete. Assessment written to phase-skill-assessments.jsonl")
print("Improvement report written to phase-improvements/scaffold.md")