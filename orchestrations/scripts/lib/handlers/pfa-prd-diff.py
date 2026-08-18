import json, sys

ALLOWED_FIELDS = {'agentRole', 'model', 'aiProvider', 'reasoningEffort'}

before_path, after_path, phase_id = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(before_path) as f:
        before = json.load(f)
    with open(after_path) as f:
        after = json.load(f)
except Exception as e:
    print('fail')
    print(f"VIOLATION: PRD is not valid JSON after write: {e}", file=sys.stderr)
    sys.exit(0)

phase_ids = set(before.get('implementationOrder', {}).get(phase_id, []))
before_by_id = {s['id']: s for s in before.get('stories', []) if 'id' in s}
after_by_id = {s['id']: s for s in after.get('stories', []) if 'id' in s}

violations = []
if set(before_by_id) != set(after_by_id):
    added = set(after_by_id) - set(before_by_id)
    removed = set(before_by_id) - set(after_by_id)
    if added:
        violations.append(f"stories added: {sorted(added)}")
    if removed:
        violations.append(f"stories removed: {sorted(removed)}")

for sid in phase_ids:
    b = before_by_id.get(sid)
    a = after_by_id.get(sid)
    if b is None or a is None:
        continue  # already reported above as added/removed
    all_keys = set(b.keys()) | set(a.keys())
    for key in all_keys:
        if key in ALLOWED_FIELDS:
            continue
        if b.get(key) != a.get(key):
            violations.append(f"{sid}.{key} changed (not an allowed field for pre-phase assessment)")

if violations:
    print('fail')
    for v in violations[:20]:
        print(f"VIOLATION: {v}", file=sys.stderr)
else:
    print('pass')
