import sys, json
for line in sys.stdin:
    try:
        e = json.loads(line)
        status = e.get('review_status','?')
        issues = e.get('issues_found', 0)
        ts = e.get('timestamp','?')
        print(f'- {ts}: {status} ({issues} issues)')
    except Exception:
        pass

