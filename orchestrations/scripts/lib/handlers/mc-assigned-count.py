import sys, re, json
txt = sys.stdin.read()
for m in re.finditer(r'\{[^{}]*"assigned_count"[^{}]*\}', txt, re.DOTALL):
    try:
        obj = json.loads(m.group(0))
        print(obj.get('assigned_count', 0))
        break
    except: pass
else: print(0)

