import json, sys

ALLOWED_FIELDS = {'model', 'aiProvider', 'reasoningEffort'}

# A MODEL THAT IS NOT A RUNG CANNOT ESCALATE, AND THIS REVIEWER NEVER ASKED.
#
# It checked STRUCTURE only — which fields moved, whether stories appeared or vanished —
# so any string was an acceptable model. Live, run 20260814T224748Z: `gpt-5-codex` was
# assigned here, is on no ladder this project declares, and the successor lookup returns
# EMPTY for it — the same value it returns at the top rung. The story would have burned
# every attempt on one model while the log read like a legitimate ceiling.
#
# The rungs come from the project's own llm-settings.json. No model name lives here, and
# an unreadable declaration is UNKNOWN — never an approval.
def _declared_rungs(path):
    try:
        with open(path) as f:
            ladders = (json.load(f) or {}).get('ladders') or {}
    except Exception:
        return None
    rungs = set()
    for tier in ladders.values():
        for hop in (tier or {}).get('modelLadder') or []:
            for end in ('from', 'to'):
                v = hop.get(end)
                if isinstance(v, str) and v:
                    rungs.add(v)
        start = (tier or {}).get('startModel')
        if isinstance(start, str) and start:
            rungs.add(start)
    return rungs or None

_settings_path = sys.argv[3] if len(sys.argv) > 3 else ''
RUNGS = _declared_rungs(_settings_path)

before_path, after_path = sys.argv[1], sys.argv[2]
try:
    with open(before_path) as f:
        before = json.load(f)
    with open(after_path) as f:
        after = json.load(f)
except Exception as e:
    print('fail')
    print(f"  [prd-model-coordinator][reviewer] VIOLATION: PRD is not valid JSON after write: {e}", file=sys.stderr)
    sys.exit(0)

before_by_id = {s['id']: s for s in before.get('stories', []) if 'id' in s}
after_by_id = {s['id']: s for s in after.get('stories', []) if 'id' in s}

violations = []

if before_by_id.keys() != after_by_id.keys():
    added = after_by_id.keys() - before_by_id.keys()
    removed = before_by_id.keys() - after_by_id.keys()
    if added:
        violations.append(f"stories added: {sorted(added)}")
    if removed:
        violations.append(f"stories removed: {sorted(removed)}")

if before.get('implementationOrder') != after.get('implementationOrder'):
    violations.append("implementationOrder was modified")

for sid, before_story in before_by_id.items():
    after_story = after_by_id.get(sid)
    if after_story is None:
        continue
    all_keys = set(before_story.keys()) | set(after_story.keys())
    for key in all_keys:
        if key in ALLOWED_FIELDS:
            continue
        if before_story.get(key) != after_story.get(key):
            violations.append(f"{sid}.{key} changed (not an allowed model-assignment field)")

    # Membership, checked on what the agent actually wrote.
    _assigned = after_story.get('model')
    if isinstance(_assigned, str) and _assigned:
        if RUNGS is None:
            violations.append(
                f"cannot read ladder declarations from '{_settings_path}' — "
                f"cannot verify {sid}.model='{_assigned}' can escalate")
        elif _assigned not in RUNGS:
            violations.append(
                f"{sid}.model='{_assigned}' is on no declared ladder — it could never "
                f"escalate; choose one of: {', '.join(sorted(RUNGS))}")

if violations:
    print('fail')
    for v in violations[:20]:
        print(f"  [prd-model-coordinator][reviewer] VIOLATION: {v}", file=sys.stderr)
else:
    print('pass')
