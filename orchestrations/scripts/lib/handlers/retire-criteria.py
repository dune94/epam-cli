# retire-criteria.py <prd> <story_id> <review-feedback.json> — retire the criteria a review named, if the REMEDIATOR added them.
#
# Operator, 2026-10-14: a reviewer may retire a criterion the remediator added when it cannot be met — never one of the
# plan's. An issue carrying "retireCriterion" names it. It is removed from the story only when it was added by
# remediation: {"origin": "remediation"}, or the remediators' earlier shape, exactly {text, status} (nothing else writes
# it; the plan's criteria are strings). The issue is then resolved and dropped from the feedback; an issue naming any
# other criterion stays for its owner. Prints the number retired.
import json, os, sys

prd_path, sid, fb_path = sys.argv[1:4]
fb = json.load(open(fb_path))
issues = fb.get('issues') or []
prd = json.load(open(prd_path))
story = next((s for s in prd.get('stories', []) if s.get('id') == sid), None)

def text(ac):
    return ac.get('text', '') if isinstance(ac, dict) else str(ac)

def by_remediation(ac):
    return isinstance(ac, dict) and (ac.get('origin') == 'remediation' or sorted(ac.keys()) == ['status', 'text'])

retired, kept = 0, []
for issue in issues:
    name = (issue.get('retireCriterion') or '').strip() if isinstance(issue, dict) else ''
    acs = (story or {}).get('acceptanceCriteria') or []
    hit = next((a for a in acs if name and text(a).strip() == name and by_remediation(a)), None)
    if hit is not None:
        acs.remove(hit)
        retired += 1
        continue
    kept.append(issue)

if retired:
    tmp = prd_path + '.tmp'; json.dump(prd, open(tmp, 'w'), indent=2); os.replace(tmp, prd_path)
    fb['issues'] = kept
    tmp = fb_path + '.tmp'; json.dump(fb, open(tmp, 'w')); os.replace(tmp, fb_path)
print(retired)
