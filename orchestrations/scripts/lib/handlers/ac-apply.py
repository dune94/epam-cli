import sys, json, os

prd_path, story_id, raw_file = sys.argv[1], sys.argv[2], sys.argv[3]
txt = open(raw_file).read()

# Robust JSON-object scan (NOT a brace-depth-free regex): the agent's own
# suggested ACs frequently embed verification snippets like
# `node -e "...{...}..."`, whose literal { } characters inside a JSON
# string value broke the old regex (`\{[^{}]*"acs_added"[^{}]*\}` requires
# ZERO braces anywhere in the match, including inside string content).
# json.JSONDecoder.raw_decode respects real JSON string escaping/nesting,
# so it finds the object regardless of what's inside its string values.
decoder = json.JSONDecoder()
payload = None
idx = 0
while True:
    start = txt.find('{', idx)
    if start == -1:
        break
    try:
        obj, end = decoder.raw_decode(txt, start)
        if isinstance(obj, dict) and 'acs' in obj:
            payload = obj
            break
        idx = end
    except json.JSONDecodeError:
        idx = start + 1

if not payload:
    print(0)
    sys.exit(0)

new_acs = payload.get('acs', [])
if not new_acs:
    print(0)
    sys.exit(0)

with open(prd_path) as f:
    prd = json.load(f)

added = 0
for s in prd.get('stories', []):
    if s.get('id') != story_id:
        continue
    existing = [a.get('text', '') if isinstance(a, dict) else str(a) for a in s.get('acceptanceCriteria', [])]
    for ac in new_acs:
        if ac and ac not in existing and len(existing) < 24:
            s.setdefault('acceptanceCriteria', []).append({'text': ac, 'status': 'pending'})
            existing.append(ac)
            added += 1

if added > 0:
    _tmp_prd_path = prd_path + '.tmp'
    with open(_tmp_prd_path, 'w') as f:
        json.dump(prd, f, indent=2)
    os.replace(_tmp_prd_path, prd_path)

print(added)
