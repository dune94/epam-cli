import json, sys
reason = sys.stdin.read()
types = []
if 'tool call itself failed' in reason:
    types.append('tool_call_failed')
if 'profiles.json content was rejected' in reason:
    types.append('profiles_content_rejected')
if 'not valid JSON' in reason:
    types.append('invalid_json')
if 'stories added' in reason:
    types.append('story_added')
if 'stories removed' in reason:
    types.append('story_removed')
if 'changed (not an allowed field' in reason:
    types.append('field_out_of_scope')
print(json.dumps(types))

