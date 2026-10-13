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

# ONLY CODE THE STORY CHANGED CAN BE THE STORY'S BLOCKER. A blocker in a file the change did not touch is
# pre-existing: AMSD-2974 run 9 (2026-10-13) failed metrolinx — a codeline with NO diff — on existing
# Contentstack live-preview code, and self-heal then asked the story to fix it. The change is the diff against the
# lane's phase baseline (LOG_DIR/phase-baseline-sha.txt); with no baseline it cannot be told apart, so every
# grounded blocker counts, as before.
import subprocess
changed = None
_base_file = os.path.join(os.environ.get("LOG_DIR", ""), "phase-baseline-sha.txt")
try:
    _base = open(_base_file).read().strip()
    if _base:
        _out = subprocess.run(["git", "-C", project_root, "diff", "--name-only", _base], capture_output=True, text=True, timeout=30)
        if _out.returncode == 0:
            changed = set(l.strip() for l in _out.stdout.splitlines() if l.strip())
except Exception:
    changed = None

findings = data.get("findings", [])
grounded = 0
for f in findings:
    if str(f.get("severity", "")).lower() != "blocker":
        continue
    file_rel = f.get("file", "")
    snippet = (f.get("codeSnippet") or "").strip()
    if not file_rel or not snippet:
        continue
    if changed is not None:
        _rel = os.path.relpath(file_rel, project_root) if os.path.isabs(file_rel) else os.path.normpath(file_rel)
        if _rel not in changed:
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
