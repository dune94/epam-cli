#!/usr/bin/env python3
"""
HOW OLD AN ISO-8601 TIMESTAMP IS, IN SECONDS.

Preflight uses this to tell a live snapshot watcher from a stale artifact: a build-info file
refreshed seconds ago means something is running; one refreshed hours ago means it is not.

A trailing Z is accepted — datetime.fromisoformat does not take one before Python 3.11, and the
producers write it.

Lifted out of preflight-check.sh on 2026-08-16, where it was a `python3 -c "..."` string with the
timestamp interpolated into its own source, so a malformed value was a syntax error rather than a
parse failure.

Generic: the timestamp is an argument.

    argv[1]  the timestamp
    stdout   whole seconds since it, or 9999 when it cannot be parsed

9999 rather than an error, deliberately: every caller compares it against a freshness threshold,
and an unparseable timestamp is not evidence of freshness.
"""
import datetime
import sys

if len(sys.argv) < 2:
    print(9999)
    sys.exit(0)

try:
    ts = datetime.datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(int((now - ts).total_seconds()))
except Exception:
    print(9999)
