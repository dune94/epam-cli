import json
import datetime
from collections import defaultdict

# Read phase cost data
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-cost.jsonl', 'r') as f:
    cost_lines = f.readlines()

# Read JIRA PRD data
with open('/../../../../tmp/jira-orch-be-prd-491181.json', 'r') as f:
    jira_data = json.load(f)

# Parse cost data and get latest record per story
story_records = defaultdict(list)

for line in cost_lines:
    if '"phase_id":"scaffold"' in line:
        record = json.loads(line)
        story_records[record['story_id']].append(record)

# Get the most recent record for each story
latest_records = {}
for story_id, records in story_records.items():
    if records:  # Make sure there are records
        latest_record = max(records, key=lambda x: datetime.datetime.fromisoformat(x['started_at'].replace('Z', '+00:00')))
        latest_records[story_id] = latest_record

# Get story info from JIRA PRD
jira_stories = {story['id']: story for story in jira_data['stories']}

# Process scaffold phase data
actual_minutes = 0
forecast_minutes = 0
actual_cost_usd = 0
forecast_cost_usd = 0
variance_minutes = 0
variance_cost_usd = 0
over_threshold = False
agent_recommendations = []
notes = []

# Process each story in scaffold phase
for story_id, record in latest_records.items():
    if story_id == "scaffold":
        continue  # Skip the scaffold phase metadata records
        
    # Get story info from JIRA
    story_info = jira_stories.get(story_id, {})
    
    # Check if story is completed in JIRA (source of truth)
    is_completed = story_info.get('completed', False)
    
    # If completed in JIRA, use the latest record for timing/cost but treat as succeeded
    if is_completed:
        elapsed_minutes = record.get('elapsed_minutes', 0)
        forecast_hours = record.get('forecast_hours', 0)
        task_cost_usd = record.get('task_cost_usd', 0)
        forecast_cost_usd = record.get('forecast_cost_usd', 0)
        
        actual_minutes += elapsed_minutes
        forecast_minutes += (forecast_hours * 60)
        actual_cost_usd += task_cost_usd
        forecast_cost_usd += forecast_cost_usd
        
        # Calculate variance
        variance_minutes += (elapsed_minutes - (forecast_hours * 60))
        variance_cost_usd += (task_cost_usd - forecast_cost_usd)
        
        # Check if over threshold
        if elapsed_minutes > (forecast_hours * 60):
            over_threshold = True
    else:
        # If not completed in JIRA, we should not count it in our assessment
        # But we can still analyze it for recommendations
        pass

# Create assessment
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

print(json.dumps(assessment))