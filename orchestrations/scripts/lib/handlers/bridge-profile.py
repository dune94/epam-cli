import sys, json
p = json.load(open(sys.argv[1]))
# argv[2]: whose persona — the seam registry's declaration, passed by the caller (lib/codeline-lanes.sh).
print(p.get(sys.argv[2], '') if len(sys.argv) > 2 and sys.argv[2] else '')

