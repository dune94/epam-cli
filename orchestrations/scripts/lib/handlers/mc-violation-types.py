import json, sys
reason = sys.stdin.read()
types = []
if 'not valid JSON' in reason:
    types.append('invalid_json')
if 'stories added' in reason:
    types.append('story_added')
if 'stories removed' in reason:
    types.append('story_removed')
if 'implementationOrder was modified' in reason:
    types.append('implementation_order_modified')
if 'changed (not an allowed model-assignment field)' in reason:
    types.append('field_out_of_scope')
print(json.dumps(types))

