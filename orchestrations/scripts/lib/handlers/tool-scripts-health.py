import glob, json, os, re, sys

tools_dir, log_dir = sys.argv[1], sys.argv[2]
result = {"broken": [], "duplicates": []}

if not os.path.isdir(tools_dir):
    print(json.dumps(result))
    sys.exit(0)

tool_files = sorted(glob.glob(os.path.join(tools_dir, "*.sh")))
reviewed = [t for t in tool_files if os.path.exists(t + ".reviewed")]

# Combined text of this phase's per-story logs, for the failure-count check.
log_text = ""
for log_file in glob.glob(os.path.join(log_dir, "main-*.log")):
    try:
        with open(log_file, errors="ignore") as f:
            log_text += f.read()
    except Exception:
        pass

purposes = {}
for tool_path in reviewed:
    name = os.path.basename(tool_path)[:-3]
    with open(tool_path) as f:
        content = f.read()

    syntax_rc = os.system(f"bash -n {tool_path!r} >/dev/null 2>&1")
    if syntax_rc != 0:
        result["broken"].append({"tool": name, "reason": "syntax"})
        continue

    fail_count = len(re.findall(re.escape(name) + r"\.sh exited non-zero", log_text))
    if fail_count >= 2:
        result["broken"].append({"tool": name, "reason": f"runtime ({fail_count} non-zero exits this phase)"})

    # Purpose is the second line: "# <purpose>" (first line is the shebang).
    lines = content.split("\n")
    purpose = lines[1][2:].strip() if len(lines) > 1 and lines[1].startswith("#") else ""
    purposes[name] = purpose

names = list(purposes.keys())
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = names[i], names[j]
        pa, pb = purposes[a].lower().split(), purposes[b].lower().split()
        if not pa or not pb:
            continue
        overlap = len(set(pa) & set(pb)) / max(len(set(pa) | set(pb)), 1)
        if overlap >= 0.6:
            result["duplicates"].append({"tool_a": a, "tool_b": b})

print(json.dumps(result))
