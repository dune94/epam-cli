import json, sys, os
prd_path, phase = sys.argv[1], sys.argv[2]
with open(prd_path) as f:
    prd = json.load(f)
changed = False
for s in prd.get('stories', []):
    if s.get('status') != 'pending':
        continue
    if s.get('phase', phase) != phase:
        continue
    if not s.get('model'):
        s['model'] = 'MiniMax-M3'
        changed = True
    if not s.get('aiProvider'):
        s['aiProvider'] = 'minimax'
        changed = True
    if not s.get('reasoningEffort'):
        eff = s.get('effort', 'medium')
        s['reasoningEffort'] = eff if eff in ('low', 'high') else 'medium'
        changed = True
if changed:
    _tmp_prd_path = prd_path + '.tmp'
    with open(_tmp_prd_path, 'w') as f:
        json.dump(prd, f, indent=2)
    os.replace(_tmp_prd_path, prd_path)
