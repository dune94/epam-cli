import json, os, sys
package_dir, exts_json = sys.argv[1:3]
exts = tuple(json.loads(exts_json))
out = []
# Bounded walk: a vendored package can be large, and this is grounding, not a
# full audit — cap what a single contract pass will read.
MAX_FILES = 200
for root, _, files in os.walk(package_dir):
    for f in files:
        if f.endswith(exts):
            out.append(os.path.join(root, f))
        if len(out) >= MAX_FILES:
            break
    if len(out) >= MAX_FILES:
        break
print(json.dumps(out))
