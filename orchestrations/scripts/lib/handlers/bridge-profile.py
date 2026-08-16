import sys, json
p = json.load(open(sys.argv[1]))
print(p.get('codeline-bridge-agent', ''))

