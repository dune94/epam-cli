import sys, re, json
txt = sys.stdin.read()
for m in re.finditer(r'\{[^{}]*"story_id"[^{}]*\}', txt, re.DOTALL):
    try:
        obj = json.loads(m.group(0))
        sid = obj.get('story_id')
        if sid and sid != 'null':
            print(sid)
            break
    except: pass

