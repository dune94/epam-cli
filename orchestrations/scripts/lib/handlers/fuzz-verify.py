import json, sys, os, re, subprocess, shutil

log_file, project_root, node_bin = sys.argv[1], sys.argv[2], sys.argv[3]

# Extract JSON from the log (agent may emit preamble text)
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"fuzz-weaver".*\}', content, re.DOTALL)
if not json_match:
    print("0")
    sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0")
    sys.exit(0)

verify_dir = os.path.join(project_root, ".fuzz-verify")
os.makedirs(verify_dir, exist_ok=True)
vitest_bin = os.path.join(project_root, "node_modules", ".bin", "vitest")
can_run = bool(node_bin) and os.path.exists(vitest_bin)

confirmed = 0
for i, case in enumerate(data.get("cases", [])):
    if case.get("status") != "vulnerability":
        continue
    f = case.get("file", "")
    candidates = [
        f,
        os.path.join(project_root, f),
        os.path.join(project_root, "src", os.path.basename(f)),
    ]
    if not any(os.path.exists(p) for p in candidates):
        continue  # unverifiable file reference — likely hallucinated, skip

    test_src = case.get("executableTest", "")
    if not test_src or not can_run:
        continue  # no executable evidence supplied — do not block on an unverified claim

    # One file at a time in verify_dir: vitest's path argument is a filter,
    # not a hard restriction, so a leftover file from a PREVIOUS case would
    # get swept into THIS case's run and could contaminate the result.
    test_path = os.path.join(verify_dir, f"case-{i}.test.ts")
    try:
        with open(test_path, "w") as tf:
            tf.write(test_src)
        result = subprocess.run(
            [node_bin, vitest_bin, "run", test_path, "--reporter=json"],
            cwd=project_root, capture_output=True, text=True, timeout=60,
        )
        # A nonzero exit code alone doesn't distinguish "assertion genuinely
        # failed" from "syntax/transform error, zero tests ever ran" — both
        # exit nonzero. Only a REAL assertion failure (numFailedTests > 0,
        # meaning at least one test actually executed and failed) counts as
        # confirmation; a test that never ran proves nothing about the code.
        try:
            report = json.loads(result.stdout)
            if report.get("numFailedTests", 0) > 0:
                confirmed += 1
        except Exception:
            pass  # no parseable report — unverified, don't block
    except Exception:
        continue  # test didn't even run (timeout, etc.) — unverified, don't block
    finally:
        try:
            os.remove(test_path)
        except OSError:
            pass

shutil.rmtree(verify_dir, ignore_errors=True)
print(str(confirmed))
