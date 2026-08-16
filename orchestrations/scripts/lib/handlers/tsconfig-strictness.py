import json, os, re, glob, sys

project_root = sys.argv[1] if len(sys.argv) > 1 else "."
tsconfig_path = os.path.join(project_root, "tsconfig.json")
try:
    with open(tsconfig_path) as f:
        raw = f.read()
    raw_nocomments = re.sub(r'^\s*//.*$', '', raw, flags=re.MULTILINE)
    cfg = json.loads(raw_nocomments)
except Exception:
    print("")
    sys.exit(0)

includes = cfg.get("include") or []
if not includes:
    print("")
    sys.exit(0)

# Already has real inputs somewhere? Nothing to heal.
for pattern in includes:
    matches = [m for m in glob.glob(os.path.join(project_root, pattern), recursive=True) if os.path.isfile(m)]
    if matches:
        print("")
        sys.exit(0)

# Derive a placeholder path from the first include pattern's static (non-glob) prefix.
first_pattern = includes[0]
m = re.match(r'^([^*?{}\[\]]*)', first_pattern)
base = m.group(1) if m else ""
base_dir = os.path.dirname(os.path.join(project_root, base)) or project_root
if not base_dir.startswith(project_root):
    base_dir = project_root

os.makedirs(base_dir, exist_ok=True)
placeholder_path = os.path.join(base_dir, "index.ts")
if not os.path.exists(placeholder_path):
    with open(placeholder_path, "w") as f:
        f.write("export {};\n")
print(os.path.relpath(placeholder_path, project_root))
