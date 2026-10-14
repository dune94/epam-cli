# gate-finding-object.py — the gate-finding-analyst's finding, as one JSON object on stdout.
#
# The analyst answers in prose with the finding embedded (verbatim log lines, then the JSON). This prints
# the first object that carries a story_id, compact, or nothing — the same object story-id.py reads the
# story from, so the story and the rest of the finding (its `work`, file, message) come from one answer.
import sys, re, json
txt = sys.stdin.read()
for m in re.finditer(r'\{[^{}]*"story_id"[^{}]*\}', txt, re.DOTALL):
    try:
        obj = json.loads(m.group(0))
    except Exception:
        continue
    sid = obj.get('story_id')
    if sid and sid != 'null':
        print(json.dumps(obj))
        break
