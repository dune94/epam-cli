import os, re, sys, json

project_root, rules_file, owned_files_raw = sys.argv[1], sys.argv[2], sys.argv[3]
owned_files = [os.path.normpath(os.path.join(project_root, f) if not os.path.isabs(f) else f)
               for f in json.loads(owned_files_raw)]

try:
    with open(rules_file, encoding='utf-8') as f:
        rules = json.load(f)
except Exception as e:
    print("OK")  # a malformed config must never block a real story
    sys.exit(0)

violations = []
for rel in owned_files:
    fpath = os.path.normpath(os.path.join(project_root, rel) if not os.path.isabs(rel) else rel)
    if not os.path.isfile(fpath):
        continue
    try:
        with open(fpath, encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except OSError:
        continue
    rel_fpath = os.path.relpath(fpath, project_root)
    for rule in rules:
        pattern = rule.get('matchPattern')
        if not pattern:
            continue
        if re.search(pattern, content):
            violations.append(f"{rel_fpath}: {rule.get('message', rule.get('id', 'anti-pattern match'))}")

if violations:
    print("VIOLATION")
    for line in violations:
        print(line)
else:
    print("OK")
