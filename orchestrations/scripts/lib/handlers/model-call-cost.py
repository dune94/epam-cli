import sys, json
pricing_file, model, tin, tout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(pricing_file) as f:
        table = json.load(f)
    prices = table.get(model)
    if not prices:
        for k, v in table.items():
            if model.startswith(k) or k.startswith(model):
                prices = v
                break
    if prices:
        print("{:.6f}".format((tin * prices["input"] + tout * prices["output"]) / 1_000_000))
    else:
        print("0")
except Exception:
    print("0")
