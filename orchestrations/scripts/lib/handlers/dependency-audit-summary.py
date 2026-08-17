#!/usr/bin/env python3
"""
DEPENDENCY-AUDIT EVIDENCE, CLASSIFIED, FOR THE SAST GATE.

The SAST prompt REQUIRES a runtime/dev classification — a runtime high is a major finding, a
dev-only one is minor regardless of CVSS. The evidence never carried it, so the agent could not
comply: live 2026-07-26 it said so and left 70 CVEs unclassified. That is a dictionary lookup, not
a judgement, so the pipeline answers it rather than delegating it.

Moved out of run-agent-orchestration.sh on 2026-08-17. It was a 48-line Python program held in a
shell single-quoted string and piped to `python3 -`, inside a 1590-line function — unrunnable on
its own, untestable, and invisible to every Python tool in the repo.

  argv[1]  the audit JSON
  argv[2]  the manifest, for the runtime/dev classification
  stdout   the summary block injected into the SAST prompt
"""
import sys, json
# Each package is tagged runtime / dev / transitive. The SAST prompt REQUIRES
# that classification (runtime high = major, dev-only = minor regardless of
# CVSS) but the evidence never carried it, so the agent could not comply. Live
# 2026-07-26 it said so and left 70 CVEs unclassified. This is a dictionary
# lookup, not a judgement — the pipeline should answer it, not delegate it.
runtime_deps, dev_deps = set(), set()
if len(sys.argv) > 2:
    try:
        with open(sys.argv[2]) as f:
            pkg = json.load(f)
        runtime_deps = set((pkg.get("dependencies") or {}).keys()) | set((pkg.get("optionalDependencies") or {}).keys())
        dev_deps = set((pkg.get("devDependencies") or {}).keys())
    except Exception:
        pass

def classify(name):
    if name in runtime_deps: return "runtime"
    if name in dev_deps: return "dev"
    if not runtime_deps and not dev_deps: return "unclassified"
    return "transitive"

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    vulns = data.get("vulnerabilities", {})
    meta  = data.get("metadata", {}).get("vulnerabilities", {})
    total      = sum(meta.values()) if meta else len(vulns)
    critical   = meta.get("critical", 0)
    high       = meta.get("high", 0)
    moderate   = meta.get("moderate", 0)
    low        = meta.get("low", 0)
    lines = [f"total={total}  critical={critical}  high={high}  moderate={moderate}  low={low}"]
    if runtime_deps or dev_deps:
        lines.append("  (each package tagged runtime|dev|transitive from package.json — apply the major/minor rule directly)")
    shown = 0
    for name, v in vulns.items():
        if shown >= 15:
            lines.append(f"  ... and {len(vulns)-shown} more packages")
            break
        sev  = v.get("severity", "?")
        via  = ", ".join(str(x.get("title", x) if isinstance(x, dict) else x)
                         for x in (v.get("via") or [])[:2])
        lines.append(f"  [{sev}] ({classify(name)}) {name}: {via[:100]}")
        shown += 1
    print("\n".join(lines))
except Exception as e:
    print(f"(audit parse error: {e})")
