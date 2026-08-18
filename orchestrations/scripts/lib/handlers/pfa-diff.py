import json, sys
with open(sys.argv[1]) as f:
    before = json.load(f)
with open(sys.argv[2]) as f:
    after = json.load(f)
new_keys = [k for k in after if k not in before]
changed_keys = [k for k in after if k in before and after[k] != before[k]]
out = {
    "new_profiles": {k: after[k][:1500] for k in new_keys},
    "changed_profiles": {k: {"before": before[k][-800:], "after": after[k][-800:]} for k in changed_keys}
}
print(json.dumps(out))
