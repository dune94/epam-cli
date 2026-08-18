import sys, json
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    num_passed   = data.get("numPassedTests", 0)
    num_failed   = data.get("numFailedTests", 0)
    num_total    = data.get("numTotalTests", 0)
    num_skipped  = data.get("numPendingTests", 0)
    failed_names = []
    for suite in data.get("testResults", []):
        for t in suite.get("testResults", []):
            if t.get("status") == "failed":
                failed_names.append(t.get("fullName", t.get("title", "?")))
    lines = [
        f"numTotal={num_total}  numPassed={num_passed}  numFailed={num_failed}  numSkipped={num_skipped}"
    ]
    if failed_names:
        lines.append("Failed tests:")
        for n in failed_names[:20]:
            lines.append(f"  - {n}")
        if len(failed_names) > 20:
            lines.append(f"  ... and {len(failed_names)-20} more")
    print("\n".join(lines))
except Exception as e:
    print(f"(oracle parse error: {e})")
