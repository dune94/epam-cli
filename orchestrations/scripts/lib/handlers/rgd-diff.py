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

# A LOG THAT IS NOT THERE IS NOT A SUITE THAT PASSED.
#
# This appended an EMPTY set for an unreadable attempt — and stable_after is the INTERSECTION of
# every attempt, so a single missing log emptied the intersection, new_failures came out empty,
# and the verdict was "pass". If the suite never ran at all (the command could not start, the
# disk was full, the write failed) every set was empty and this gate reported "no new test
# failures beyond the tolerated baseline" having read nothing.
#
# An attempt that produced no output did not run. That is reportable, and the caller already
# treats "unknown" as blocking — it prints "CANNOT VERIFY ... not a confirmed regression, but it
# cannot be ruled out either", which is the honest answer.
sets = []
missing = []
for i in range(1, max_attempts + 1):
    try:
        with open(attempt_log(i)) as f:
            text = f.read()
    except OSError:
        missing.append(attempt_log(i))
        continue
    if not text.strip():
        missing.append(attempt_log(i))
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
if missing:
    print(json.dumps({
        "verdict": "unknown",
        "new_failures": [],
        "reason": "the test suite produced no output for %d of %d attempt(s) (%s) — it did not run, so nothing can be compared against the baseline"
                  % (len(missing), max_attempts, ", ".join(missing)),
    }))
    sys.exit(0)

stable_after = set.intersection(*sets) if sets else set()

# THE BASELINE'S ABSENCE IS ALSO NOT AN ANSWER. Missing, this silently became the empty set, so
# every pre-existing failure counted as NEW and the phase was blamed for breakage it inherited —
# the exact inverse of the operator policy ("we inherit existing test failures, but we cannot be
# expected to fix them"). It fails closed rather than open, but for the wrong reason and with no
# way to tell from the message.
baseline = set()
try:
    with open(baseline_file) as f:
        baseline = set(json.load(f).get('failures', []))
except OSError:
    print(json.dumps({
        "verdict": "unknown",
        "new_failures": [],
        "reason": "no tolerated baseline at %s — without it every pre-existing failure would be "
                  "reported as newly introduced by this phase" % baseline_file,
    }))
    sys.exit(0)

new_failures = sorted(stable_after - baseline)
print(json.dumps({"verdict": "fail" if new_failures else "pass", "new_failures": new_failures}))
