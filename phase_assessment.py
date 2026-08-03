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
role_changes = []

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
            
        # Check for role mismatch - SKY-001 is a scaffolding task that should be done by a typescript-engineer
        # Let's analyze if the task description matches the assigned role
        if story_id == "SKY-001":
            # SKY-001 is about scaffolding a TypeScript project - this is definitely a typescript-engineer task
            # The agentRole is already "typescript-engineer" which is correct
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

# Write assessment to JSONL file
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-skill-assessments.jsonl', 'a') as f:
    f.write(json.dumps(assessment) + '\n')

# Create improvement report
improvement_report = f"""# Phase Improvement Report: Scaffold

## Summary
- **Phase**: Scaffold
- **Actual Minutes**: {actual_minutes:.2f}
- **Forecast Minutes**: {forecast_minutes:.2f}
- **Variance Minutes**: {variance_minutes:.2f}
- **Actual Cost (USD)**: ${actual_cost_usd:.4f}
- **Forecast Cost (USD)**: ${forecast_cost_usd:.4f}
- **Variance Cost (USD)**: ${variance_cost_usd:.4f}
- **Over Threshold**: {over_threshold}

## Analysis
The scaffold phase was completed with {actual_minutes:.2f} minutes of actual work versus a forecast of {forecast_minutes:.2f} minutes. 
This represents a variance of {variance_minutes:+.2f} minutes ({variance_minutes/forecast_minutes*100:+.1f}%).

The actual cost was ${actual_cost_usd:.4f} versus a forecast of ${forecast_cost_usd:.4f}, 
with a variance of ${variance_cost_usd:.4f}.

## Recommendations
"""

if not over_threshold:
    improvement_report += "No improvements needed.\n"
else:
    improvement_report += "Tasks exceeded their forecast time.\n"

# Add role analysis
improvement_report += "\n## Role Analysis\n"
improvement_report += "The scaffold phase included the following tasks:\n\n"

for story_id, record in latest_records.items():
    if story_id == "scaffold":
        continue
        
    story_info = jira_stories.get(story_id, {})
    is_completed = story_info.get('completed', False)
    
    if is_completed:
        improvement_report += f"- **{story_id}**: {record.get('story_title', 'Unknown Title')}\n"
        improvement_report += f"  - Assigned Role: {story_info.get('agentRole', 'Unknown')}\n"
        improvement_report += f"  - Actual Time: {record.get('elapsed_minutes', 0):.2f} minutes\n"
        improvement_report += f"  - Forecast Time: {record.get('forecast_hours', 0) * 60:.2f} minutes\n\n"

# Write improvement report
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-improvements/scaffold.md', 'w') as f:
    f.write(improvement_report)

print("Assessment and improvement report generated successfully.")