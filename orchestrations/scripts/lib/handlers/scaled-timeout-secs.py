#!/usr/bin/env python3
"""
A TIMEOUT SCALED BY A MULTIPLIER, ROUNDED UP.

Used twice: once to widen a step's timeout for a role that needs longer, and once to widen it again
for a watchdog retry.

    argv[1]  the multiplier
    argv[2]  the base timeout in seconds
    stdout   the scaled timeout, whole seconds, rounded up

BOTH ARE PARSED AS NUMBERS. In the heredoc this was `math.ceil(${timeout_secs} * ${multiplier})`,
where the shell substituted two bare numeric literals. Extracting them turned both into strings,
and `str * str` is a TypeError — under the caller's `2>/dev/null || echo "$timeout_secs"` that
failed silently to the UNSCALED timeout, so neither multiplier did anything at all. It was also
extracted twice, into two byte-identical files; this is the one.

A non-numeric argument is fatal and says so, rather than returning something the caller would use.
"""
import math
import sys

if len(sys.argv) < 3:
    sys.stderr.write("[scaled-timeout-secs] usage: <multiplier> <base-seconds>\n")
    sys.exit(1)

try:
    multiplier = float(sys.argv[1])
    base = float(sys.argv[2])
except ValueError as e:
    sys.stderr.write(f"[scaled-timeout-secs] not a number: {e}\n")
    sys.exit(1)

print(math.ceil(base * multiplier))
