import re, sys, json

pattern, max_attempts, log_base, baseline_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
try:
    rx = re.compile(pattern, re.MULTILINE)
except re.error:
    print(json.dumps({"verdict": "unknown", "new_failures": []}))
    sys.exit(0)

def attempt_log(i):
    if i == 1:
        return log_base
    if log_base.endswith('.log'):
        return log_base[:-4] + f"-attempt-{i}.log"
    return f"{log_base}-attempt-{i}"

sets = []
for i in range(1, max_attempts + 1):
    try:
        with open(attempt_log(i)) as f:
            text = f.read()
    except OSError:
        sets.append(set())
        continue
    ids = set()
    for m in rx.finditer(text):
        g = next((x for x in m.groups() if x), None)
        if g:
            ids.add(g)
    sets.append(ids)

# Same correction as Step 5's baseline capture (live AMSD-2041, 2026-07-31):
# the intersection ALONE is the reproducible signal. A test failing in every
# after-attempt is a real, confirmed new failure; a one-off flake in a single
# attempt (present in the union but not the intersection) is exactly the
# noise the 3-attempt retry exists to filter, on EITHER side of this
# comparison — it must not block a clean phase, and it must not be silently
# folded into "new failures" either.
stable_after = set.intersection(*sets) if sets else set()

baseline = set()
try:
    with open(baseline_file) as f:
        baseline = set(json.load(f).get('failures', []))
except OSError:
    pass

new_failures = sorted(stable_after - baseline)
print(json.dumps({"verdict": "fail" if new_failures else "pass", "new_failures": new_failures}))
