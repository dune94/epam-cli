#!/usr/bin/env python3

import json
import datetime
from collections import defaultdict

def analyze_scaffold_phase():
    # Read the phase cost log
    cost_log_path = '/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-cost.jsonl'
    prd_path = '/tmp/jira-orch-be-prd-491181.json'
    assessment_path = '/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-skill-assessments.jsonl'
    improvement_path = '/home/bradleyjerome/projects/ai/epam-cli/orchestrations/logs/phase-improvements/scaffold.md'

    # Read and parse the PRD file
    with open(prd_path, 'r') as f:
        prd_data = json.load(f)

    # Create a mapping of story IDs to their completion status from PRD
    story_completion = {}
    for story in prd_data['stories']:
        story_completion[story['id']] = {
            'completed': story.get('completed', False),
            'agentRole': story.get('agentRole', ''),
            'title': story.get('title', '')
        }

    # Parse the cost log to get the most recent record for each story
    story_records = defaultdict(list)

    with open(cost_log_path, 'r') as f:
        for line in f:
            try:
                record = json.loads(line.strip())
                if record.get('phase_id') == 'scaffold':
                    story_records[record['story_id']].append(record)
            except json.JSONDecodeError:
                continue

    # For each story, keep only the most recent record (highest started_at timestamp)
    latest_records = {}
    for story_id, records in story_records.items():
        if records:
            # Sort by started_at timestamp descending
            latest_record = max(records, key=lambda x: x['started_at'])
            latest_records[story_id] = latest_record

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

    # Process each story in the scaffold phase
    processed_stories = []
    
    for story_id, record in latest_records.items():
        # Skip the "scaffold" story_id which is not a real story
        if story_id == "scaffold":
            continue
            
        # Check if the story is completed according to PRD (source of truth)
        is_completed = story_completion.get(story_id, {}).get('completed', False)
        
        # Get the story details from PRD
        story_details = story_completion.get(story_id, {})
        story_title = story_details.get('title', record.get('story_title', ''))
        
        # If completed according to PRD, use the actual values
        if is_completed:
            elapsed_minutes = record.get('elapsed_minutes', 0)
            forecast_hours = record.get('forecast_hours', 0)
            task_cost_usd = record.get('task_cost_usd', 0)
            forecast_cost_usd_val = record.get('forecast_cost_usd', 0)
            
            # Add to totals
            actual_minutes += elapsed_minutes
            forecast_minutes += (forecast_hours * 60)
            actual_cost_usd += task_cost_usd
            forecast_cost_usd += forecast_cost_usd_val
            
            # Calculate variance
            variance = elapsed_minutes - (forecast_hours * 60)
            variance_minutes += variance
            variance_cost_usd += (task_cost_usd - forecast_cost_usd_val)
            
            # Track processed stories
            processed_stories.append({
                'story_id': story_id,
                'title': story_title,
                'elapsed_minutes': elapsed_minutes,
                'forecast_minutes': forecast_hours * 60,
                'variance': variance
            })
            
            # Check if variance exceeds threshold (10% as a reasonable threshold)
            if abs(variance) > (forecast_hours * 60 * 0.1) and forecast_hours > 0:
                over_threshold = True
                agent_recommendations.append(f"Story {story_id} ({story_title}) exceeded forecast by {abs(variance):.2f} minutes")
        else:
            # If not completed, we don't include in the assessment
            continue

    # Check if any tasks were over the forecast
    if variance_minutes > 0:
        over_threshold = True

    # Generate assessment JSON
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

    # Write assessment to JSONL file
    with open(assessment_path, 'a') as f:
        f.write(json.dumps(assessment) + '\n')

    # Generate improvement report
    improvement_report = f"""# Scaffold Phase Improvement Report

## Summary
- **Actual Minutes**: {actual_minutes:.2f}
- **Forecast Minutes**: {forecast_minutes:.2f}
- **Variance Minutes**: {variance_minutes:.2f}
- **Actual Cost USD**: ${actual_cost_usd:.4f}
- **Forecast Cost USD**: ${forecast_cost_usd:.4f}
- **Variance Cost USD**: ${variance_cost_usd:.4f}
- **Over Threshold**: {'Yes' if over_threshold else 'No'}

## Analysis

"""
    
    if not agent_recommendations:
        improvement_report += "## No Improvements Needed\n\nNo tasks exceeded their forecast by more than 10%.\n"
    else:
        improvement_report += "## Recommendations\n\n"
        for rec in agent_recommendations:
            improvement_report += f"- {rec}\n"

    # Write improvement report
    with open(improvement_path, 'w') as f:
        f.write(improvement_report)

    print("Analysis complete.")
    print(f"Processed {len(processed_stories)} stories")
    for story in processed_stories:
        print(f"  - {story['story_id']}: {story['elapsed_minutes']:.2f} min vs {story['forecast_minutes']:.2f} min (variance: {story['variance']:.2f} min)")

if __name__ == "__main__":
    analyze_scaffold_phase()