"""spec-unmet-finding.py <spec-validator-log> — the first story with an UNMET criterion, as a gate finding.

A spec-validator log is a criteria report (storyId, criteria[{text,status,evidence,gaps}]), not a list of BLOCKER
findings with files, so gate-finding-analyst grounds nothing in it and the git fallback has no "file" to follow
(AMSD-2974 run 9, resumes 10 and 11: the spec gate failed, remediation was skipped, the lane halted twice). The
validator already named the story and said what is unmet and why; that IS the finding. Prints the finding JSON, or
nothing when no criterion is unmet. Line-level matching, as spec-extractor.py does: the agent's JSON is often not
parseable whole.
"""
import json, re, sys

try:
    text = open(sys.argv[1], errors="ignore").read()
except Exception:
    sys.exit(0)

starts = [m for m in re.finditer(r'"storyId"\s*:\s*"([^"]*)"', text)]
crit = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"status"\s*:\s*"unmet"'
                  r'(?:\s*,\s*"evidence"\s*:\s*"((?:[^"\\]|\\.)*)")?(?:\s*,\s*"gaps"\s*:\s*"((?:[^"\\]|\\.)*)")?')
for i, m in enumerate(starts):
    end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
    unmet = [{"criterion": c.group(1), "evidence": c.group(2) or "", "gaps": c.group(3) or ""}
             for c in crit.finditer(text[m.start():end])]
    if unmet:
        print(json.dumps({
            "gate": "spec-validator",
            "story_id": m.group(1),
            "rule": "acceptance criterion unmet",
            "message": "; ".join(u["criterion"] for u in unmet),
            "unmet_criteria": unmet,
            "suggested_fix": " ".join(u["gaps"] for u in unmet if u["gaps"]),
        }))
        break
