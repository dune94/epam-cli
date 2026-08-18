import json, os, sys
repo, cfg_path = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(cfg_path))
except Exception:
    sys.exit(0)
vendor = set(cfg.get('vendorDirs', []) or [])
exts = cfg.get('scanFileExtensions', []) or []
roots = []
try:
    for e in sorted(os.listdir(repo)):
        if e.startswith('.') or e in vendor:
            continue
        if os.path.isdir(os.path.join(repo, e)):
            roots.append(e)
except OSError:
    sys.exit(0)
if not roots:
    sys.exit(0)
print("## Module resolution in this codeline")
print("A bare import that names a file under any of these directories is INTERNAL "
      "source, not a dependency — never add it to the dependency manifest:")
print("  " + ", ".join(roots))
print("Source extensions here: " + ", ".join(exts) if exts else "")
print("Write imports the way the existing files in this codeline write them; "
      "read a neighbouring file before inventing a path.")
