import sys, json
prd = json.load(open(sys.argv[1]))
phases = list(prd.get('implementationOrder', {}).keys())
phases_config = prd.get('phasesConfig', {})
current = sys.argv[2]
try:
    idx = phases.index(current)
except ValueError:
    sys.exit(1)
for candidate in phases[idx+1:]:
    cfg = phases_config.get(candidate, {})
    desc = (cfg.get('description') or '').lower()
    if 'excluded from normal execution paths' in desc:
        continue
    # Skip if all stories already complete
    ids = prd['implementationOrder'].get(candidate, [])
    pending = [s for s in prd.get('stories', []) if s['id'] in ids and not s.get('completed')]
    if not ids or not pending:
        continue
    print(candidate)
    sys.exit(0)
sys.exit(1)

