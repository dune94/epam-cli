#!/usr/bin/env python3
"""
THE PRICE OF ONE MODEL, OUT OF THE PRICING TABLE.

Cost estimates are only as good as this lookup: a model missing from the table estimates as free,
and a run then looks cheaper than it is.

Lifted out of its calling script on 2026-08-16, where it was a quoted heredoc. The program is
byte-for-byte unchanged — it already took its inputs as arguments; it just had no name and no
home of its own. Generic: nothing here is project- or stack-specific.

    argv[1]  model-pricing.json
    argv[2]  the model name
    stdout   the model's price entry
"""
import sys, json
pricing_file, model = sys.argv[1], sys.argv[2]
try:
    with open(pricing_file) as f:
        table = json.load(f)
    prices = table.get(model)
    if not prices:
        ml = model.lower()
        for k, v in table.items():
            kl = k.lower()
            if kl == ml or ml.startswith(kl) or kl.startswith(ml):
                prices = v
                break
    if prices:
        inp = float(prices.get("input", 0))
        out = float(prices.get("output", 0))
        cached = round(inp * 0.10, 6)
        print(f"{inp}|{cached}|{out}")
    else:
        print("")
except Exception:
    print("")
