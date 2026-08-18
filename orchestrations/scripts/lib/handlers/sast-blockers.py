import sys, json, re
try:
    text = open(sys.argv[1]).read()
    parsed = None
    # Try full JSON parse
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            pass
    if parsed is not None:
        # Prefer summary.blockerCount
        summary_count = parsed.get('summary', {}).get('blockerCount', None)
        if summary_count is not None:
            print(summary_count)
        else:
            findings = parsed.get('findings', [])
            print(sum(1 for f in findings if str(f.get('severity','')).lower() == 'blocker'))
    else:
        # Malformed JSON — extract summary block directly (it appears before findings)
        sm = re.search(r'"summary"\s*:\s*\{([^}]*)\}', text, re.DOTALL)
        if sm:
            try:
                summary = json.loads('{' + sm.group(1) + '}')
                bc = summary.get('blockerCount', None)
                if bc is not None:
                    print(bc)
                    sys.exit(0)
            except Exception:
                pass
        # Last resort: count severity:blocker occurrences in raw text
        hits = len(re.findall(r'"severity"\s*:\s*"blocker"', text, re.IGNORECASE))
        print(hits)
except Exception:
    print(-1)

