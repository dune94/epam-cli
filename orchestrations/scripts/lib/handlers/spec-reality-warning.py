import json, os, re, sys

description, acs, dep_files_json = sys.argv[1], sys.argv[2], sys.argv[3]
dep_files = json.loads(dep_files_json)

# Same token-overlap heuristic already proven in the relative-import-check's
# suggestion logic — a basename EQUALITY check is too strict for the actual
# live bug shape (`skyscanner-client.ts` vs the real `client.ts` under
# `skyscanner/` — different basenames, same underlying identifier).
def tokenize(name):
    return set(re.split(r'[^a-zA-Z0-9]+', name.lower())) - {''}

def is_test_file(path):
    return bool(re.search(r'\.(test|spec)\.[a-zA-Z0-9]+$', path))

dep_impl_files = [f for f in dep_files if not is_test_file(f)]

# Backtick-quoted, path-like strings only (contains a slash, ends in a
# common source extension) — plain identifiers/method names in backticks
# are not file-path claims and shouldn't be checked here.
PATH_RE = re.compile(r'`([\w./-]+/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`')

mismatches = []
seen = set()
for text in (description, acs):
    for m in PATH_RE.finditer(text):
        claimed = m.group(1)
        if claimed in seen:
            continue
        seen.add(claimed)
        if any(claimed == f or f.endswith('/' + claimed) for f in dep_files):
            continue  # exact match against a real dependency file — no mismatch
        claimed_tokens = tokenize(os.path.splitext(os.path.basename(claimed))[0])
        if not claimed_tokens:
            continue
        best_real, best_overlap = None, 0
        for real in dep_impl_files:
            real_tokens = tokenize(os.path.splitext(os.path.basename(real))[0])
            if not real_tokens:
                continue
            overlap = claimed_tokens & real_tokens
            ratio = len(overlap) / min(len(claimed_tokens), len(real_tokens))
            if ratio >= 0.5 and len(overlap) > best_overlap:
                best_real, best_overlap = real, len(overlap)
        if best_real:
            mismatches.append((claimed, best_real))

if mismatches:
    lines = [
        "## SPEC-REALITY MISMATCH (auto-detected — the description/ACs above contain a WRONG file path)",
        "The following path(s) in this story's own description/ACs do NOT match the real file a dependency actually built. TRUST THE CONTRACT SECTION BELOW, NOT THE WRONG PATH ABOVE:",
    ]
    for claimed, real in mismatches:
        lines.append(f"- Description/ACs say `{claimed}` — the REAL file is at `{real}`. Use the real path.")
    print('\n'.join(lines))
