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
scaffold_story_records = [record for story_id, record in latest_records.items() if story_id != "scaffold"]

# For the scaffold phase, we only care about the actual implementation story (SKY-001)
sky001_record = None
for record in scaffold_story_records:
    if record.get('story_id') == 'SKY-001':
        sky001_record = record
        break

if sky001_record:
    # Get story info from JIRA
    story_info = jira_stories.get('SKY-001', {})
    
    # Check if story is completed in JIRA (source of truth)
    is_completed = story_info.get('completed', False)
    
    # If completed in JIRA, use the latest record for timing/cost
    if is_completed:
        elapsed_minutes = sky001_record.get('elapsed_minutes', 0)
        forecast_hours = sky001_record.get('forecast_hours', 0)
        task_cost_usd = sky001_record.get('task_cost_usd', 0)
        forecast_cost_usd = sky001_record.get('forecast_cost_usd', 0)
        
        actual_minutes = elapsed_minutes
        forecast_minutes = (forecast_hours * 60)
        actual_cost_usd = task_cost_usd
        forecast_cost_usd = forecast_cost_usd
        
        # Calculate variance
        variance_minutes = (elapsed_minutes - (forecast_hours * 60))
        variance_cost_usd = (task_cost_usd - forecast_cost_usd)
        
        # Check if over threshold
        if elapsed_minutes > (forecast_hours * 60):
            over_threshold = True
            
        # Add recommendations based on variance
        if variance_minutes > 0:
            agent_recommendations.append(f"Story SKY-001 (Scaffold TypeScript project with Vitest and Express) exceeded forecast by {variance_minutes:.2f} minutes")

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
    "notes": []
}

# Write assessment to JSONL file (using flock simulation with append)
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-skill-assessments.jsonl', 'w') as f:
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

if not over_threshold and variance_minutes >= 0:
    improvement_report += "No improvements needed.\n"
else:
    if agent_recommendations:
        for rec in agent_recommendations:
            improvement_report += f"- {rec}\n"
    else:
        improvement_report += "No improvements needed.\n"

# Add role analysis
improvement_report += "\n## Role Analysis\n"
improvement_report += "The scaffold phase included the following tasks:\n\n"

# Check for role mismatches in future stories
future_stories = [story for story in jira_data['stories'] if story['status'] == 'pending' and story['id'] != 'SKY-001']
role_changes = []

for story in future_stories:
    story_id = story['id']
    agent_role = story['agentRole']
    
    # Analyze if the task description matches the assigned role
    # For this project, we'll use conservative judgment:
    # - TypeScript implementation tasks should be assigned to typescript-engineer
    # - Test implementation tasks should be assigned to test-engineer
    
    description = story['description'].lower()
    is_typescript_task = any(keyword in description for keyword in ['typescript', 'tsconfig', 'package.json', 'node.js', 'express', 'vitest'])
    is_test_task = any(keyword in description for keyword in ['test', 'vitest', 'unit test', 'mock'])
    
    # Check if role assignment makes sense
    if is_typescript_task and agent_role != 'typescript-engineer':
        # This is a TypeScript implementation task but assigned to a different role
        # We'll document this for potential future correction
        role_changes.append({
            'story_id': story_id,
            'old_role': agent_role,
            'new_role': 'typescript-engineer',
            'reason': 'Task involves TypeScript implementation'
        })
        improvement_report += f"- **{story_id}**: {story['title']}\n"
        improvement_report += f"  - Assigned Role: {agent_role} (should be typescript-engineer)\n"
        improvement_report += f"  - Task involves TypeScript implementation\n\n"
    elif is_test_task and agent_role != 'test-engineer':
        # This is a test implementation task but assigned to a different role
        role_changes.append({
            'story_id': story_id,
            'old_role': agent_role,
            'new_role': 'test-engineer',
            'reason': 'Task involves test implementation'
        })
        improvement_report += f"- **{story_id}**: {story['title']}\n"
        improvement_report += f"  - Assigned Role: {agent_role} (should be test-engineer)\n"
        improvement_report += f"  - Task involves test implementation\n\n"
    else:
        improvement_report += f"- **{story_id}**: {story['title']}\n"
        improvement_report += f"  - Assigned Role: {agent_role}\n"
        improvement_report += f"  - Task type appears to match role\n\n"

# Write improvement report
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-improvements/scaffold.md', 'w') as f:
    f.write(improvement_report)

print("Final assessment and improvement report generated successfully.")