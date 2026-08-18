import os, re, sys, json

project_root = sys.argv[1]
auto_fix = sys.argv[2] == 'true'
owned_files = set(os.path.normpath(os.path.join(project_root, f) if not os.path.isabs(f) else f)
                   for f in json.loads(sys.argv[3]))
has_story_context = sys.argv[4] == 'true'
SOURCE_EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')

IMPORT_RE = re.compile(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['\"](\.[^'\"]*)['\"]")
EXPORT_DECL_RE = re.compile(
    r"export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)"
)
EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}(?!\s*from)")

def resolves(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return candidate
    for ext in SOURCE_EXTS:
        if os.path.isfile(candidate + ext):
            return candidate + ext
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return os.path.join(candidate, 'index' + ext)
    return None

_export_cache = {}
def get_exports(fpath):
    if fpath in _export_cache:
        return _export_cache[fpath]
    try:
        with open(fpath, encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except OSError:
        _export_cache[fpath] = set()
        return set()
    names = set(EXPORT_DECL_RE.findall(content))
    for group in EXPORT_LIST_RE.findall(content):
        for item in group.split(','):
            item = item.strip()
            if not item:
                continue
            # `export { A as B }` — B is the externally-visible name
            parts = re.split(r'\s+as\s+', item)
            names.add(parts[-1].strip())
    _export_cache[fpath] = names
    return names

broken = []
out_of_scope = []
auto_fixed = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if not fname.endswith(SOURCE_EXTS):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue
        fixed_content = content
        file_changed = False
        for m in IMPORT_RE.finditer(content):
            names_raw, spec = m.group(1), m.group(2)
            target = resolves(root, spec)
            if not target:
                continue  # a broken PATH is run_relative_import_check's job, not this one
            exports = get_exports(target)
            rel_fpath = os.path.relpath(fpath, project_root)
            for raw_name in names_raw.split(','):
                raw_name = raw_name.strip()
                if not raw_name:
                    continue
                # `import { A as B }` — A is the identifier that must exist in the target
                imported_name = re.split(r'\s+as\s+', raw_name)[0].strip()
                if imported_name in exports:
                    continue
                case_matches = [e for e in exports if e.lower() == imported_name.lower() and e != imported_name]
                if len(case_matches) == 1:
                    suggestion = f" Did you mean '{case_matches[0]}'? (exported from {os.path.relpath(target, project_root)})"
                else:
                    suggestion = ""

                can_auto_fix = auto_fix and len(case_matches) == 1 and os.path.normpath(fpath) in owned_files
                if can_auto_fix:
                    # Whole-file word-boundary replace — the wrong identifier is
                    # typically used both in the import AND at call sites (the
                    # exact live bug: `import { SkyScannerClient }` AND
                    # `new SkyScannerClient()` both had the typo). Patching only
                    # the import line would leave usage sites referencing a now-
                    # undefined name — a different but equally broken result.
                    correct_name = case_matches[0]
                    pattern = re.compile(r'\b' + re.escape(imported_name) + r'\b')
                    new_content = pattern.sub(correct_name, fixed_content)
                    if new_content != fixed_content:
                        fixed_content = new_content
                        file_changed = True
                        auto_fixed.append(f"{rel_fpath}: '{imported_name}' -> '{correct_name}'")
                if not can_auto_fix:
                    line = f"{rel_fpath}: imports '{imported_name}' from '{spec}' which is not exported there.{suggestion}"
                    # Root cause this scopes (found live, 2026-07-09/10): a
                    # pre-existing broken import in a file the CURRENT story
                    # doesn't own (has_story_context=true and fpath not in
                    # owned_files) permanently blocked an UNRELATED story that
                    # is structurally incapable of fixing it (scope-guard
                    # prevents it from ever touching that file) — exhausting
                    # all retries on a bug that was never this story's to fix.
                    # Only block the CURRENT story on findings in files it
                    # actually owns; report everything else as non-blocking
                    # visibility so the information isn't silently lost.
                    if has_story_context and os.path.normpath(fpath) not in owned_files:
                        out_of_scope.append(line)
                    else:
                        broken.append(line)

        if file_changed:
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(fixed_content)

for line in out_of_scope:
    print("OUT_OF_SCOPE:" + line)
if broken:
    print("BROKEN")
    for line in broken:
        print(line)
else:
    print("OK")
for line in auto_fixed:
    print("AUTOFIXED:" + line)
