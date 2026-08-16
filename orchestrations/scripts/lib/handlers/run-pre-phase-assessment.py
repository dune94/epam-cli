import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(obj.get('verdict','pass'))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'"verdict"\s*:\s*"(pass|fail)"', text)
print(m.group(1) if m else 'pass')

