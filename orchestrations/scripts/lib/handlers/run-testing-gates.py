import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    v = obj.get('verdict','')
    if v in ('pass','fail'):
        print(v); sys.exit(0)
except Exception:
    pass
m = re.search(r'"verdict"\s*:\s*"(pass|fail)"', text)
if m: print(m.group(1)); sys.exit(0)

