import sys, json, os
prd_path, phase_id, proj = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(prd_path) as f:
        prd = json.load(f)
    phase_ids = set(prd.get('implementationOrder', {}).get(phase_id, []))
    story_map = {s['id']: s for s in prd.get('stories', [])}
    out, total_lines = [], 0
    for sid in prd.get('implementationOrder', {}).get(phase_id, []):
        s = story_map.get(sid, {})
        tn = s.get('technicalNotes')
        files = tn.get('files', []) if isinstance(tn, dict) else []
        for rel in files[:3]:
            full = os.path.join(proj, rel)
            if not os.path.isfile(full):
                continue
            try:
                lines = open(full).readlines()
                excerpt = ''.join(lines[:80])
                out.append(f'\n### {rel} (first {min(80,len(lines))} lines)\n{excerpt}')
                total_lines += min(80, len(lines))
                if total_lines > 600:
                    out.append('\n(file evidence truncated — limit reached)')
                    break
            except Exception:
                pass
        if total_lines > 600:
            break
    print(''.join(out) if out else '(no expected files found in technicalNotes)')
except Exception as e:
    print(f'(file oracle error: {e})')
