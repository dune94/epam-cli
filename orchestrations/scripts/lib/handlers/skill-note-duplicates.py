import json, re, sys, os

path = sys.argv[1]
with open(path) as f:
    profiles = json.load(f)

duplicates_removed = 0
contradictions = []

for role, text in profiles.items():
    if not isinstance(text, str) or '[Self-Heal]' not in text:
        continue
    paragraphs = text.split('\n\n')
    seen = set()
    deduped = []
    for para in paragraphs:
        key = para.strip()
        if key.startswith('[Self-Heal]'):
            if key in seen:
                duplicates_removed += 1
                continue
            seen.add(key)
        deduped.append(para)
    new_text = '\n\n'.join(deduped)
    if new_text != text:
        profiles[role] = new_text
        text = new_text

    for para in text.split('\n\n'):
        if not para.strip().startswith('[Self-Heal]'):
            continue
        m = re.search(r"(?:do not|never|avoid)\s+use\s+'([^']+)'", para, re.IGNORECASE)
        if not m:
            continue
        token = re.escape(m.group(1))
        # Does the note ALSO recommend using the same token elsewhere (past
        # the "do not use" clause itself)? The token may reappear as its own
        # quoted string ('as') or embedded as a whole word inside a longer
        # quoted phrase ('value as Type') -- both are the same contradiction.
        rest = para[m.end():]
        if re.search(r"\buse\b[^.]*'[^']*\b" + token + r"\b[^']*'", rest, re.IGNORECASE):
            contradictions.append({'role': role, 'note': para.strip()})

if duplicates_removed > 0:
    _tmp_path = path + '.tmp'
    with open(_tmp_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    os.replace(_tmp_path, path)

print(json.dumps({'duplicates_removed': duplicates_removed, 'contradictions': contradictions}))
