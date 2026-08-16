import json, os, re, sys

project_root, config_file = sys.argv[1], sys.argv[2]
with open(config_file) as f:
    cfg = json.load(f)
TEST_FILE_EXTS = tuple(cfg['testFileExtensions'])

def is_test_file(path):
    return bool(re.search(cfg['testFilePattern'], path))

def resolve_import(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return candidate
    for ext in TEST_FILE_EXTS:
        if os.path.isfile(candidate + ext):
            return candidate + ext
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return os.path.join(candidate, 'index' + ext)
    return None

def find_matching_brace(text, open_idx):
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return i
    return -1

def top_level_matches(text, pattern):
    # Live bug (2026-07-06, found via SKY-003's repeated false rejections):
    # a plain regex scan over the WHOLE class body has no notion of brace
    # depth, so control-flow statements nested inside a real method's body
    # (e.g. `if (!key) {`) also match `\w+\s*\(...\)\s*{` and get
    # misidentified as class methods (a phantom method literally named
    # "if"). This falsely rejected a CORRECT, COMPLETE mock for "missing"
    # a method that doesn't exist — burning the entire retry/escalation
    # ladder on a check bug, not a real defect. Same fix already applied
    # to generate_story_contract()'s identical parsing: only count a match
    # as a real method when it's a DIRECT child of the class body (depth 1
    # relative to the body's own opening brace), not nested inside another
    # block.
    depth_at = [0] * (len(text) + 1)
    depth = 0
    for i, c in enumerate(text):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        depth_at[i + 1] = depth
    return [m for m in pattern.finditer(text) if depth_at[m.start()] == 1]

def real_class_methods(source_text, class_name):
    # Config-driven (2026-07-06): find ALL classes via cfg['classPattern'] and
    # match by captured name, instead of substituting class_name into a
    # hand-rolled pattern — this way the class-matching regex itself is
    # entirely config-supplied, same as generate_story_contract() already
    # does, with zero stack-specific syntax hardcoded in this function.
    class_re = re.compile(cfg['classPattern'])
    m = None
    for candidate in class_re.finditer(source_text):
        if candidate.group(1) == class_name:
            m = candidate
            break
    if not m:
        return None
    body_start = m.end() - 1
    body_end = find_matching_brace(source_text, body_start)
    if body_end == -1:
        return None
    body = source_text[body_start:body_end + 1]
    method_re = re.compile(cfg['methodPattern'], re.M)
    methods = set()
    for mm in top_level_matches(body, method_re):
        # cfg['methodPattern']'s group shape is fixed by contract-generation.json:
        # (asyncKeyword, methodName, params, returnType) — same groups()
        # ordering generate_story_contract() already relies on.
        name = mm.group(2)
        if name != 'constructor':
            methods.add(name)
    return methods

MOCK_START_RE = re.compile(cfg['mockFactoryStartPattern'])
CLASS_MOCK_RE = re.compile(cfg['mockClassPattern'])
MOCKED_METHOD_RE = re.compile(cfg['mockedMethodPattern'], re.M)

problems = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if not fname.endswith(TEST_FILE_EXTS) or not is_test_file(fname):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue

        for mock_m in MOCK_START_RE.finditer(content):
            import_path = mock_m.group(1)
            outer_start = mock_m.end() - 1
            outer_end = find_matching_brace(content, outer_start)
            if outer_end == -1:
                continue
            outer_body = content[outer_start:outer_end + 1]

            for class_m in CLASS_MOCK_RE.finditer(outer_body):
                class_name = class_m.group(1)
                inner_start = class_m.end() - 1
                inner_end = find_matching_brace(outer_body, inner_start)
                if inner_end == -1:
                    continue
                inner_body = outer_body[inner_start:inner_end + 1]
                mocked_methods = set(MOCKED_METHOD_RE.findall(inner_body))

                real_path = resolve_import(root, import_path)
                if not real_path:
                    continue  # relative-import-check already flags unresolvable paths
                try:
                    with open(real_path, encoding='utf-8', errors='ignore') as f:
                        source_text = f.read()
                except OSError:
                    continue
                real_methods = real_class_methods(source_text, class_name)
                if real_methods is None:
                    continue  # class not found at that path — not this check's concern
                missing = sorted(real_methods - mocked_methods)
                if missing:
                    rel_test = os.path.relpath(fpath, project_root)
                    rel_real = os.path.relpath(real_path, project_root)
                    problems.append(
                        f"{rel_test}: vi.mock() factory for '{class_name}' (from '{import_path}' -> {rel_real}) "
                        f"is missing method(s): {', '.join(missing)}"
                    )

if problems:
    print("INCOMPLETE")
    for line in problems:
        print(line)
else:
    print("OK")
