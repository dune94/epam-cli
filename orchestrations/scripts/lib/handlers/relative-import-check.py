import os, re, sys, json

project_root = sys.argv[1]
auto_fix = sys.argv[2] == 'true'
owned_files = set(os.path.normpath(os.path.join(project_root, f) if not os.path.isabs(f) else f)
                   for f in json.loads(sys.argv[3]))
has_story_context = sys.argv[4] == 'true'
SOURCE_EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')
IMPORT_RE = re.compile(r"from\s+['\"](\.[^'\"]*)['\"]|require\(\s*['\"](\.[^'\"]*)['\"]\s*\)")

def resolves(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return True
    for ext in SOURCE_EXTS:
        if os.path.isfile(candidate + ext):
            return True
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return True
    # TypeScript ESM: `import './foo.js'` is valid TS and resolves to `foo.ts`
    if spec.endswith('.js'):
        ts_base = os.path.normpath(os.path.join(base_dir, spec[:-3]))
        for ts_ext in ('.ts', '.tsx'):
            if os.path.isfile(ts_base + ts_ext):
                return True
    return False

def tokenize(path):
    return set(re.split(r'[^a-zA-Z0-9]+', path.lower())) - {''}

def is_test_file(path):
    return bool(re.search(r'\.(test|spec)\.[a-zA-Z0-9]+$', path))

# Candidate pool for suggestions EXCLUDES test files. Root cause of a live-run
# defect: an implementation file and its test sibling (client.ts / client.test.ts)
# always tie on token overlap ({"skyscanner","client"} matches both equally) —
# without this exclusion, the suggestion algorithm can non-deterministically
# recommend the TEST file as "the module to import", which is never correct
# for application code and actively misleads the retry.
all_source_files = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if fname.endswith(SOURCE_EXTS) and not is_test_file(fname):
            all_source_files.append(os.path.relpath(os.path.join(root, fname), project_root))

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
            spec = next((g for g in m.groups() if g), None)
            if not spec:
                continue
            if resolves(root, spec):
                continue
            spec_tokens = tokenize(spec)
            best = None
            best_score = 0
            for cand in all_source_files:
                cand_tokens = tokenize(cand)
                score = len(spec_tokens & cand_tokens)
                if score > best_score:
                    best_score = score
                    best = cand
            rel_fpath = os.path.relpath(fpath, project_root)
            if best and best_score > 0:
                best_abs = os.path.join(project_root, best)
                rel_from_importer = os.path.relpath(best_abs, root)
                if not rel_from_importer.startswith('.'):
                    rel_from_importer = './' + rel_from_importer
                # Strip the source extension — TS/JS import specifiers omit it
                for ext in SOURCE_EXTS:
                    if rel_from_importer.endswith(ext):
                        rel_from_importer = rel_from_importer[: -len(ext)]
                        break
                suggestion = f" Did you mean '{rel_from_importer}'? (found at {best})"
            else:
                suggestion = ""
                rel_from_importer = None

            can_auto_fix = (
                auto_fix
                and rel_from_importer
                and best_score >= 2
                and os.path.normpath(fpath) in owned_files
            )
            if can_auto_fix:
                for quote in ("'", '"'):
                    old_spec_quoted = f"{quote}{spec}{quote}"
                    if old_spec_quoted in fixed_content:
                        fixed_content = fixed_content.replace(
                            old_spec_quoted, f"{quote}{rel_from_importer}{quote}"
                        )
                        file_changed = True
                        auto_fixed.append(f"{rel_fpath}: '{spec}' -> '{rel_from_importer}'")
                        break
            if not can_auto_fix:
                line = f"{rel_fpath}: imports '{spec}' which does not exist.{suggestion}"
                # Same scoping fix as run_named_import_check: a broken import
                # in a file this story doesn't own can never be this story's
                # to fix (scope-guard prevents it from ever touching that
                # file) — report it as non-blocking visibility instead of
                # burning the entire retry ladder on an impossible fix.
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
