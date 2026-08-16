import json, sys, re, os

log_file, project_root = sys.argv[1], sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"perf-sentinel".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

findings = data.get("findings", [])
grounded = 0
for f in findings:
    if str(f.get("severity", "")).lower() != "blocker":
        continue
    file_rel = f.get("file", "")
    snippet = (f.get("codeSnippet") or "").strip()
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
