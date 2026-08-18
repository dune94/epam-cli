import re, sys, json
file_path, pattern, ignore_json = sys.argv[1:4]
ignore = set(json.loads(ignore_json))
with open(file_path) as f:
    text = f.read()
seen = []
for m in re.finditer(pattern, text):
    pkg = next((g for g in m.groups() if g), None)
    if not pkg or pkg in ignore or pkg in seen:
        continue
    seen.append(pkg)
for p in seen:
    print(p)
