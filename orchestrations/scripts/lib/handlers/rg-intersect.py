import re, sys, json

pattern, max_attempts, log_base = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    rx = re.compile(pattern, re.MULTILINE)
except re.error:
    print(json.dumps({"stable": False, "failures": []}))
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
        sets.append(None)
        continue
    ids = set()
    for m in rx.finditer(text):
        g = next((x for x in m.groups() if x), None)
        if g:
            ids.add(g)
    sets.append(ids)

# A missing log, or an attempt that parsed NO failing identity despite the
# command's own nonzero exit, means the pattern is not matching this run's
# real output — never silently treat "found nothing" as "an empty stable
# set", which would look identical to a genuinely green baseline.
if any(s is None or len(s) == 0 for s in sets):
    print(json.dumps({"stable": False, "failures": []}))
else:
    # Live AMSD-2041, 2026-07-31 (gotransit): a test surviving every attempt
    # (schedules.spec.tsx) is reproducible per the backlog's own bar — but
    # attempt 3 ALSO had two unrelated tests flake in under parallel-suite
    # interference. Requiring the WHOLE union to match across every attempt
    # (the original version here) let that one-off noise poison an
    # otherwise-clean, genuinely reproducible baseline and blocked a real
    # launch outright. The intersection ALONE is what's trustworthy —
    # tolerate exactly that, and simply drop the one-off extras as the
    # flakiness the 3-attempt retry exists to filter, never adding them to
    # the tolerated set (which would risk masking a real regression there).
    stable = set.intersection(*sets)
    print(json.dumps({"stable": len(stable) > 0, "failures": sorted(stable)}))
