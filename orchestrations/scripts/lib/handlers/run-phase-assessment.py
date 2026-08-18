import sys,json,re
t=sys.stdin.read()
m=re.search(r'\{.*\}', t, re.DOTALL)
sys.exit(0 if m and isinstance(json.loads(m.group(0)), dict) else 1)
