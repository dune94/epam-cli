import sys, json
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    results = data.get("results", [])
    errors_count = len(data.get("errors", []))
    by_sev = {}
    for r in results:
        sev = r.get("extra", {}).get("severity", "INFO").upper()
        by_sev.setdefault(sev, []).append(r)
    lines = [f"totalFindings={len(results)}  scanErrors={errors_count}"]
    for sev in ("ERROR", "WARNING", "INFO"):
        items = by_sev.get(sev, [])
        if not items:
            continue
        lines.append(f"\n{sev} ({len(items)}):")
        for r in items[:10]:
            path = r.get("path", "?")
            line = r.get("start", {}).get("line", 0)
            rule = r.get("check_id", "?").split(".")[-1]
            msg  = r.get("extra", {}).get("message", "")[:120]
            lines.append(f"  [{rule}] {path}:{line} — {msg}")
        if len(items) > 10:
            lines.append(f"  ... and {len(items)-10} more {sev} findings")
    print("\n".join(lines))
except Exception as e:
    print(f"(semgrep parse error: {e})")
