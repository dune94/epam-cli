# retire-criteria.py <prd> <story_id> <review-feedback.json> — retire the criteria a review named, if the REMEDIATOR added them.
#
# Operator, 2026-10-14: a reviewer may retire a criterion the remediator added when it cannot be met — never one of the
# plan's. An issue carrying "retireCriterion" names it. It is removed from the story only when it was added by
# remediation: {"origin": "remediation"}, or the remediators' earlier shape, exactly {text, status} (nothing else writes
# it; the plan's criteria are strings). The issue is then resolved and dropped from the feedback; an issue naming any
# other criterion stays for its owner. Prints the number retired.
import json, os, sys

prd_path, sid, fb_path = sys.argv[1:4]
# The marker the reviewer was shown beside a remediation criterion (lib/story-acs-block.sh): a name copied with it matches.
mark = sys.argv[4] if len(sys.argv) > 4 else ''

def named(issue):
    n = (issue.get('retireCriterion') or '').strip()
    if mark and n.endswith(mark):
        n = n[:-len(mark)].strip()
    return n
fb = json.load(open(fb_path))
issues = fb.get('issues') or []
prd = json.load(open(prd_path))
story = next((s for s in prd.get('stories', []) if s.get('id') == sid), None)

def text(ac):
    return ac.get('text', '') if isinstance(ac, dict) else str(ac)

# WHAT THE PLAN IS: the plan of record (argv[5], lib/plan-of-record.sh) — never a criterion's shape. A criterion it does
# not list was added after pause 2; one the remediator stamped is a remediation. With no plan of record, only the stamp.
plan_path = sys.argv[5] if len(sys.argv) > 5 else ''
plan_texts = None
if plan_path and os.path.isfile(plan_path):
    _ps = next((s for s in json.load(open(plan_path)).get('stories', []) if s.get('id') == sid), {})
    plan_texts = [text(a).strip() for a in (_ps.get('acceptanceCriteria') or [])]

def by_remediation(ac):
    if isinstance(ac, dict) and ac.get('origin') == 'remediation':
        return True
    return plan_texts is not None and text(ac).strip() not in plan_texts

# THE CRITERIA AS THE REVIEWER WAS SHOWN THEM (argv[6], the criteria block): one line per criterion, "<label>: <text>",
# in the order of the story's non-empty criteria. A criterion named by its label, or by its whole line, is that one.
shown_labels = []
if len(sys.argv) > 6 and os.path.isfile(sys.argv[6]):
    for line in open(sys.argv[6]).read().splitlines()[1:]:
        if ': ' in line:
            shown_labels.append(line.split(': ', 1)[0].strip())

def resolve(name, acs):
    shown = [a for a in acs if a not in (None, '')]
    for i, label in enumerate(shown_labels):
        if i < len(shown) and (name == label or name.startswith(label + ': ')):
            return shown[i]
    return next((a for a in acs if text(a).strip() == name), None)

retired, kept = 0, []
for issue in issues:
    name = named(issue) if isinstance(issue, dict) else ''
    acs = (story or {}).get('acceptanceCriteria') or []
    found = resolve(name, acs) if name else None
    hit = found if found is not None and by_remediation(found) else None
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
