import json

# Read the PRD file
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/travel-app-prd.json', 'r') as f:
    prd = json.load(f)

# Find stories that need updates
stories_to_update = []
for i, story in enumerate(prd['stories']):
    if story['id'] in ['SKY-001A', 'SKY-001B'] and story['status'] == 'pending':
        # Check if any of the required fields are missing
        if story.get('model') is None or story.get('aiProvider') is None or story.get('reasoningEffort') is None:
            stories_to_update.append((i, story['id']))

# Update stories
updated_count = 0
for idx, story_id in stories_to_update:
    story = prd['stories'][idx]
    
    # Check if story has createdFrom (split child)
    if story.get('createdFrom') is not None:
        # Inherit from parent
        parent_id = story['createdFrom']
        # Remove suffix if it's a split child
        if parent_id.endswith('-A') or parent_id.endswith('-B') or parent_id.endswith('-C'):
            parent_id = parent_id[:-2]
        
        # Find parent story
        parent_story = next((s for s in prd['stories'] if s['id'] == parent_id), None)
        if parent_story:
            story['model'] = parent_story.get('model', 'MiniMax-M3')
            story['aiProvider'] = parent_story.get('aiProvider', 'minimax')
            # Map effort to reasoningEffort
            effort = story.get('effort', 'medium')
            if effort == 'low':
                story['reasoningEffort'] = 'low'
            elif effort == 'high':
                story['reasoningEffort'] = 'high'
            else:
                story['reasoningEffort'] = 'medium'
        else:
            # Default fallback
            story['model'] = 'MiniMax-M3'
            story['aiProvider'] = 'minimax'
            effort = story.get('effort', 'medium')
            if effort == 'low':
                story['reasoningEffort'] = 'low'
            elif effort == 'high':
                story['reasoningEffort'] = 'high'
            else:
                story['reasoningEffort'] = 'medium'
    else:
        # No createdFrom, check if parent exists and has the fields
        parent_id = story['id'][:-1] if story['id'].endswith(('A', 'B')) else None
        if parent_id:
            parent_story = next((s for s in prd['stories'] if s['id'] == parent_id), None)
            if parent_story and parent_story.get('model') and parent_story.get('aiProvider'):
                story['model'] = parent_story['model']
                story['aiProvider'] = parent_story['aiProvider']
                # Map effort to reasoningEffort
                effort = story.get('effort', 'medium')
                if effort == 'low':
                    story['reasoningEffort'] = 'low'
                elif effort == 'high':
                    story['reasoningEffort'] = 'high'
                else:
                    story['reasoningEffort'] = 'medium'
                updated_count += 1
                continue
        
        # Default assignment
        story['model'] = 'MiniMax-M3'
        story['aiProvider'] = 'minimax'
        effort = story.get('effort', 'medium')
        if effort == 'low':
            story['reasoningEffort'] = 'low'
        elif effort == 'high':
            story['reasoningEffort'] = 'high'
        else:
            story['reasoningEffort'] = 'medium'
    
    updated_count += 1

# Write back to file
with open('/home/bradleyjerome/projects/ai/epam-cli/orchestrations/travel-app-prd.json', 'w') as f:
    json.dump(prd, f, indent=2)

print(f'{{"assigned_count": {updated_count}, "stories": ["SKY-001A", "SKY-001B"], "reason": "Assigned missing fields to scaffold phase stories"}}')