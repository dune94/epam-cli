import json, sys, re, os

log_file, project_root = sys.argv[1], sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"mutant-hunter".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

summary = data.get("summary") or {}
mutations = data.get("mutations", [])
survived = [m for m in mutations if str(m.get("status", "")).lower() == "survived"]

# Self-consistency: the aggregate score must agree with the model's own detail.
if summary.get("survived", -1) != len(survived):
    print("0"); sys.exit(0)

grounded = 0
for m in survived:
    file_rel = m.get("file", "")
    snippet = (m.get("originalCode") or "").strip()
    if not file_rel or not snippet:
        continue
    file_path = file_rel if os.path.isabs(file_rel) else os.path.join(project_root, file_rel)
    try:
        with open(file_path) as fh:
            real_content = fh.read()
    except Exception:
        continue
    if snippet in real_content:
        grounded = 1
        break

print(str(grounded))
