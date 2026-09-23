#!/usr/bin/env bash
# THE MODEL'S OUTPUT LIMIT IS A VENDOR FACT, SO IT IS FETCHED — NEVER AUTHORED.
#
# Every output ceiling in this pipeline used to be a number somebody chose, and every one of them
# was eventually a wall: 6144, 8192, 12288, 16384. On 2026-09-23 the run's own traces showed 85 of
# 6,301 model iterations ending EXACTLY at a declared ceiling, while the provider's registry said
# the models could emit 131,072 to 943,718 tokens. The pipeline was capping its models at 1.6-6%
# of their capability and then spending retries on the truncation.
#
# This writes `maxOutputTokens` into each model's override in the ACTIVE SET's settings file, read
# from the provider's own model registry. Re-run it whenever the provider's limits change; nothing
# here decides a number, and a model the registry does not list is left exactly as it was.
#
#   ./refresh-model-limits.sh [settings-file]      default: the active set's file
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="${1:-}"
if [ -z "$SETTINGS" ]; then
  _set="${EPAM_PROVIDER_SET:-$(python3 -c "import json;print(json.load(open('$SCRIPT_DIR/../config/provider-sets.json'))['defaultSet'])")}"
  SETTINGS="$SCRIPT_DIR/../config/$(python3 -c "import json;print(json.load(open('$SCRIPT_DIR/../config/provider-sets.json'))['sets']['$_set']['settingsFile'])")"
fi
[ -f "$SETTINGS" ] || { echo "no settings file at $SETTINGS" >&2; exit 1; }

REGISTRY="${EPAM_MODEL_REGISTRY_URL:-https://openrouter.ai/api/v1/models}"
_tmp="$(mktemp)"
curl -sS -m 30 "$REGISTRY" > "$_tmp" || { echo "could not read the model registry at $REGISTRY" >&2; exit 1; }

python3 - "$SETTINGS" "$_tmp" <<'PY'
import json, sys, collections
settings_path, registry_path = sys.argv[1], sys.argv[2]
reg = json.load(open(registry_path)).get('data', [])
limits = {}
for m in reg:
    tp = m.get('top_provider') or {}
    n = tp.get('max_completion_tokens')
    if n: limits[m['id'].lower()] = int(n)

d = json.load(open(settings_path), object_pairs_hook=collections.OrderedDict)
mo = d.get('modelOverrides') or {}
# every model this set's ladders actually name, as the provider spells it
ladder_ids = set()
for tier in (d.get('ladders') or {}).values():
    if not isinstance(tier, dict): continue
    if tier.get('startModel'): ladder_ids.add(str(tier['startModel']).lower())
    for step in (tier.get('modelLadder') or []):
        for k in ('from', 'to'):
            if step.get(k): ladder_ids.add(str(step[k]).lower())
if (d.get('finalFallback') or {}).get('model'):
    ladder_ids.add(str(d['finalFallback']['model']).lower())
# A model override is matched by substring (matchSubstring), which is how the engine resolves it.
changed = []
for key, ov in mo.items():
    if not isinstance(ov, dict): continue
    sub = (ov.get('matchSubstring') or key).lower()
    hits = [(mid, n) for mid, n in limits.items() if sub in mid]
    if not hits: continue
    # THE MODEL THIS SET ACTUALLY CALLS, not the biggest number that happens to match. Taking the
    # max over substring hits gave glm-5.3 the limit of glm-5.3-FLASH (943,718 vs 131,072) — a
    # different model, and a cap the real one would reject. The ladders name exact provider ids,
    # so an id they name wins; otherwise the shortest id, which is the least-decorated match.
    exact = [h for h in hits if h[0] in ladder_ids]
    mid, n = (exact or sorted(hits, key=lambda h: len(h[0])))[0]
    if ov.get('maxOutputTokens') != n:
        ov['maxOutputTokens'] = n
        changed.append((key, mid, n))
# A LADDER MODEL WITH NO OVERRIDE HAS NO DECLARED MAXIMUM, so the tier becomes its ceiling again
# and truncation returns for that rung alone. Found by the test the moment this landed: z-ai/glm-5.1
# is a rung on three ladders and had no override at all. An entry is created carrying ONLY the
# provider's number — no sampling, no iterations, nothing this script is not entitled to decide.
for mid in sorted(ladder_ids):
    if any(isinstance(o, dict) and o.get('matchSubstring') and str(o['matchSubstring']).lower() in mid
           for o in mo.values()):
        continue
    n = limits.get(mid)
    if not n:
        print(f"  !! {mid} is on a ladder and the registry does not list it — no maximum can be declared")
        continue
    key = mid.split('/')[-1]
    mo[key] = collections.OrderedDict([
        ('matchOn', 'model'), ('matchSubstring', key), ('maxOutputTokens', n),
        ('_why', "created by refresh-model-limits.sh: a ladder rung with no override is capped by "
                 "its tier, which is how truncation returns for one rung while the others are free."),
    ])
    changed.append((key, mid, n))
d['modelOverrides'] = mo


d['$whyModelOutputLimits'] = (
    "maxOutputTokens on each model override is the PROVIDER'S declared max_completion_tokens, "
    "written by scripts/refresh-model-limits.sh and never by hand. A cap below the model's own "
    "maximum has exactly one effect — truncation — because spend is bounded by "
    "costControls.storyBudgetHardLimitUsd, not by output length. Re-run the script when the "
    "provider's limits change."
)
json.dump(d, open(settings_path, 'w'), indent=2)
open(settings_path, 'a').write("\n")
for c in changed: print(f"  {c[0]:22} -> {c[2]:>8}  (from {c[1]})")
print(f"{len(changed)} model override(s) updated in {settings_path}")
PY
rm -f "$_tmp"
