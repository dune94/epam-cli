import json, re, sys, os

project_root, contract_file, files_json, id_label, config_file = sys.argv[1:6]
files = json.loads(files_json)

with open(config_file) as f:
    cfg = json.load(f)

exts = tuple(cfg['sourceExtensions'])
exclude_re = re.compile(cfg['excludePattern'])
src_files = [f for f in files if f.endswith(exts) and not exclude_re.search(f)]
if not src_files:
    sys.exit(0)

interface_re = re.compile(cfg['interfacePattern'], re.S)
class_re = re.compile(cfg['classPattern'])
ctor_re = re.compile(cfg['ctorPattern'])
method_re = re.compile(cfg['methodPattern'], re.M)

# Live bug (2026-07-05, found backfilling SKY-002's contract): methodPattern
# is a plain regex scan over the WHOLE class body — it has no notion of brace
# depth, so control-flow statements nested inside a real method's body (e.g.
# `if (!key) {`, `for (const x of y) {`) also match `\w+\s*\(...\)\s*{` and get
# misidentified as methods, producing duplicate/garbage entries (a mock
# skeleton with duplicate "if" mock-method entries — an invalid object
# literal in the generated skeleton). This is a brace-
# nesting concern, not a stack-specific one — applies to any C-like language a
# future config might target — so it's engine logic, not per-project config.
def top_level_matches(text, pattern):
    depth_at = [0] * (len(text) + 1)
    depth = 0
    for i, c in enumerate(text):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        depth_at[i + 1] = depth
    return [m for m in pattern.finditer(text) if depth_at[m.start()] == 1]

interfaces, classes = [], []
for relpath in src_files:
    full = os.path.join(project_root, relpath)
    if not os.path.isfile(full):
        continue
    with open(full) as f:
        text = f.read()

    for m in interface_re.finditer(text):
        interfaces.append((m.group(1), m.group(2).strip()))

    for m in class_re.finditer(text):
        cname = m.group(1)
        start = m.end() - 1
        depth, end = 0, start
        for i, c in enumerate(text[start:], start):
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        body = text[start:end + 1]
        ctor_m = ctor_re.search(body)
        ctor_params = ctor_m.group(1).strip() if ctor_m else ''
        methods = []
        for mm in top_level_matches(body, method_re):
            is_async, mname, params, ret = mm.groups()
            if mname == 'constructor':
                continue
            methods.append((mname, (params or '').strip(), (ret or '').strip(), bool(is_async)))
        classes.append((cname, ctor_params, methods))

if not interfaces and not classes:
    sys.exit(0)

lines = [
    f"# Contract: {id_label}", "",
    "Auto-generated from actual source (deterministic — not model-transcribed).", "",
]

for name, body in interfaces:
    rendered = cfg['interfaceRenderTemplate'].replace('{{name}}', name).replace('{{body}}', body)
    lines += ["```typescript", rendered, "```", ""]

mock_blocks = []
for cname, ctor, methods in classes:
    sig_lines = []
    for mname, params, ret, is_async in methods:
        async_prefix = cfg['asyncPrefixKeyword'] if is_async else ''
        return_annotation = f"{cfg['returnAnnotationPrefix']}{ret}" if ret else ''
        sig_lines.append(
            cfg['methodSignatureTemplate']
            .replace('{{asyncPrefix}}', async_prefix)
            .replace('{{methodName}}', mname)
            .replace('{{params}}', params)
            .replace('{{returnAnnotation}}', return_annotation)
        )
    class_block = (
        cfg['classDeclarationTemplate']
        .replace('{{className}}', cname)
        .replace('{{ctorParams}}', ctor)
        .replace('{{methodSignatures}}', '\n'.join(sig_lines))
    )
    lines.append("```typescript")
    lines.append(class_block)
    lines.append("```")
    lines.append("")

    mock_methods = []
    for mname, params, ret, is_async in methods:
        template = cfg['mockMethodTemplateAsync'] if (is_async or 'Promise' in ret) else cfg['mockMethodTemplateSync']
        mock_methods.append(template.replace('{{methodName}}', mname))
    factory = (
        cfg['mockFactoryTemplate']
        .replace('{{className}}', cname)
        .replace('{{methodMocks}}', '\n'.join(mock_methods))
    )
    mock_blocks.append(factory.split('\n'))

if mock_blocks:
    lines.append("Mock factory skeleton — every exported method MUST appear here (every method name is real; fill in real return values):")
    lines.append("```typescript")
    for block in mock_blocks:
        lines.extend(block)
    lines.append("```")

with open(contract_file, 'w') as f:
    f.write('\n'.join(lines))
print(f"Contract auto-generated: {len(interfaces)} interface(s), {len(classes)} class(es)")
