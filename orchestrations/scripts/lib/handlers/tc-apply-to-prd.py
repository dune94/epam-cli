import sys
import os as _os
from _testfile import is_test_file as _is_test_file
def _pair_key(f):
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _manifest_files():
    try:
        with open(_os.environ.get('_TCW_MANIFEST', '')) as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return []
def _files_for(story):
    declared = (story.get('technicalNotes') or {}).get('files') or []
    produced = _manifest_files()
    if not produced:
        return declared
    base = set()
    for _f in declared:
        base.add(_pair_key(_f))
    extra = []
    for _f in produced:
        if _f in declared or _pair_key(_f) in base:
            extra.append(_f)
    return list(dict.fromkeys(declared + extra))
import json, re, sys, os
from datetime import datetime, timezone

prd_file   = sys.argv[3]
tc_file    = sys.argv[1]
phase      = sys.argv[5]
# int(), not the bare string. In the heredoc this was `tc_exit = $TC_EXIT`, an unquoted
# interpolation the shell dropped in as a NUMERIC LITERAL. As an argument it arrives as text, and
# "0" != 0 is True — every successful run would have taken the agent-failed branch and refused to
# apply its own criteria. Caught by diffing the old program against this one.
tc_exit    = int(sys.argv[4])
story_filter = sys.argv[6]

# Check agent exit FIRST — never use a stale tc_file from a previous run when
# the current agent invocation failed. Using old TCs on failure silently applies
# outdated criteria against new implementation code.
if tc_exit != 0:
    if os.path.exists(tc_file):
        print(f"  [tc-writer] ERROR: Agent failed (exit {tc_exit}) — stale TC file exists but will NOT be used (unsafe)", file=sys.stderr)
    else:
        print(f"  [tc-writer] ERROR: Agent failed (exit {tc_exit}) and no TC file written", file=sys.stderr)
    sys.exit(1)

if not os.path.exists(tc_file):
    # A STORY THAT NEEDED TEST CRITERIA AND GOT NONE IS A FAILURE, NOT A NO-OP.
    #
    # This exited 0, and the gate then reported "PASSED — all test stories have verified TCs" over
    # a story with none. Live 2026-08-20: the agent could not write (read-only grant against a
    # "Use WriteFile" instruction), the applier called it a no-op, and the step passed three times.
    #
    # "No-op" is only honest when nothing was ASKED FOR. When a specific story was targeted, its
    # criteria are the reason this step ran, and their absence is the outcome that must be reported.
    _target = story_filter if 'story_filter' in dir() else (sys.argv[6] if len(sys.argv) > 6 else '')
    if _target:
        print("  [tc-writer] ERROR: %s needed test criteria and none were produced — "
              "its verification criteria remain unexecutable" % _target, file=sys.stderr)
        sys.exit(1)
    print("  [tc-writer] no TC file and no story targeted — nothing was asked for")
    sys.exit(0)

with open(tc_file) as f:
    tc_raw = f.read()
try:
    tc_data = json.loads(tc_raw)
except json.JSONDecodeError as e:
    # Root cause this repairs (found live, 2026-07-09, tier3-travel-app run):
    # the TC writer agent is explicitly asked to describe validation regexes
    # verbatim as "facts" (this PRD is full of date/IATA-code regex ACs) —
    # e.g. "regex /^\d{4}-\d{2}-\d{2}$/" — and routinely writes the literal
    # backslash from \d, \s, etc. into the JSON string without escaping it to
    # \\d. \d is not a valid JSON escape sequence, so json.load hard-fails and
    # the whole phase aborted even though every OTHER fact in the file was
    # fine. Since the invalid-escape defect class is narrow and mechanical
    # (a lone backslash not forming one of JSON's actual escape sequences),
    # repair it deterministically — escape any such backslash — and retry
    # once before giving up. A genuinely different JSON syntax error (missing
    # comma, unterminated string, etc.) will still fail after the repair
    # attempt, since this only touches backslash sequences.
    # Built from chr(92) rather than a literal backslash. That was forced while this block
    # lived inside an unquoted heredoc, which collapsed the escapes before Python saw them;
    # as a file it no longer is, and a literal would read better — but the escape handling
    # here is delicate enough that rewriting it is a change of its own, not a tidy-up. A
    # callable repl (not a plain string) sidesteps re.sub's OWN backslash/
    # backreference processing on the replacement text entirely.
    #
    # Root cause of a SECOND live failure (found 2026-07-09, same run):
    # the original repair matched each backslash independently ("a backslash
    # not immediately followed by a valid escape char"), which corrupts an
    # ALREADY-VALID "\\" (escaped-backslash) pair — e.g. a regex fact like
    # "\\s\\-" is valid JSON (two proper \\  pairs), but the old regex saw
    # the SECOND backslash of each pair as "a backslash followed by 's'/'-',
    # neither of which is a valid escape char" and inserted a spurious extra
    # backslash, silently changing \s (whitespace) into \\s (literal
    # backslash-s) in the decoded string. Fixed by matching whole runs of
    # backslashes and only padding a run when its length is ODD (a genuine
    # dangling backslash) AND the character immediately after the run isn't
    # a valid escape completion — even-length runs (already-paired) are left
    # untouched.
    _bs = chr(92)
    _valid_escape_chars = (_bs, '"', '/', 'b', 'f', 'n', 'r', 't', 'u')

    def _repair_backslash_run(m):
        run, nxt = m.group(1), m.group(2)
        if len(run) % 2 == 1 and nxt not in _valid_escape_chars:
            run = run + _bs
        return run + nxt

    _pattern = '(' + (_bs * 2) + '+)(.)'
    repaired = re.sub(_pattern, _repair_backslash_run, tc_raw)
    try:
        tc_data = json.loads(repaired)
        print(f"  [tc-writer] WARNING: TC file had invalid JSON escape sequence(s) ({e}) — auto-repaired by escaping stray backslashes")
    except json.JSONDecodeError:
        print(f"  [tc-writer] ERROR: TC file is not valid JSON (repair attempt also failed): {e}", file=sys.stderr)
        sys.exit(1)

with open(prd_file) as f:
    prd = json.load(f)

phase_ids_list = prd.get('implementationOrder', {}).get(phase, [])
# Same fix as the two queries above — gating on whether a story is "in scope
# to apply a TC to" must always include the target (--story) story, even if
# implementationOrder[phase] transiently lacks it. peer_ids_for() below still
# iterates the ORIGINAL phase_ids_list for peer-file discovery, unaffected.
phase_ids = set(phase_ids_list)
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids | {story_filter}
by_id = {s['id']: s for s in prd['stories']}
applied = []
skipped = []

# Deterministic mockStrategy override (2026-07-05): the LLM-authored mockStrategy
# sentence above is freeform prose and was the root cause of a live vi.requireActual/
# vi.importActual confusion (SKY-003) — the model's own words, not verified against
# real source. generate_story_contract() (claude.sh) already writes an exact,
# regex-derived mock-factory skeleton to .contracts/<dep-id>.md for every completed
# story with exported classes. When a test story's impl dependency has one, splice
# that skeleton in as testCriteria.mockStrategy instead of trusting prose — same
# "engine has no stack-specific knowledge, the .md content decides the syntax" split
# as generate_story_contract() itself: this script doesn't know vi.fn() from
# unittest.mock, it just copies whatever the contract file says.
contracts_dir = os.path.join(sys.argv[2], '.contracts')

FENCE = chr(96) * 3  # was forced while this lived in an unquoted heredoc, where a literal
                     # triple-backtick triggered bash command substitution. Harmless now.

def find_contract_mock_skeleton(peer_ids):
    for pid in peer_ids:
        cpath = os.path.join(contracts_dir, f'{pid}.md')
        if not os.path.isfile(cpath):
            continue
        with open(cpath) as cf:
            text = cf.read()
        marker_idx = text.find('Mock factory skeleton')
        if marker_idx == -1:
            continue
        fence_start = text.find(FENCE, marker_idx)
        if fence_start == -1:
            continue
        fence_end = text.find(FENCE, fence_start + 3)
        if fence_end == -1:
            continue
        return text[fence_start:fence_end + 3].strip()
    return None

def peer_ids_for(sid):
    story = by_id.get(sid, {})
    files = _files_for(story)
    test_files = [f for f in files if _is_test_file(f)]
    test_bases = {_test_base(f) for f in test_files}
    peers = []
    for peer_id in phase_ids_list:
        if peer_id == sid:
            continue
        peer_files = by_id.get(peer_id, {}).get('technicalNotes', {}).get('files', [])
        peer_bases = {_pair_key(f.split('/')[-1]) for f in peer_files if not _is_test_file(f)}
        if test_bases & peer_bases:
            peers.append(peer_id)
    return peers

for story in prd['stories']:
    sid = story['id']
    if sid not in phase_ids:
        continue
    if sid not in tc_data:
        continue
    tc = tc_data[sid]
    # Agent may legitimately write null when it determines a story's source
    # files don't exist yet (e.g. a prior implementation story failed) —
    # treat as skipped, not a crash.
    if tc is None:
        skipped.append(f"{sid}: agent wrote null (source files not found)")
        continue
    # Validate required fields
    if not isinstance(tc.get('facts'), list) or len(tc['facts']) == 0:
        skipped.append(f"{sid}: empty facts array")
        continue
    # Stamp verifiedAt if agent omitted it
    if not tc.get('verifiedAt'):
        tc['verifiedAt'] = datetime.now(timezone.utc).isoformat()
    skeleton = find_contract_mock_skeleton(peer_ids_for(sid) + [sid])
    if skeleton:
        tc['mockStrategy'] = skeleton
    story['testCriteria'] = tc
    applied.append(sid)

_tmp_prd_file = prd_file + '.tmp'
with open(_tmp_prd_file, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_file, prd_file)

print(f"  [tc-writer] Applied TCs to {len(applied)} stories: {applied}")
if skipped:
    print(f"  [tc-writer] WARNING: Skipped {skipped}")

# Verify all needed stories got TCs — scoped to just --story when set, so an
# unrelated test story elsewhere in the phase whose impl hasn't run yet (and
# therefore correctly got a null/"source not found" TC) doesn't fail THIS
# story's gate.
by_id = {s['id']: s for s in prd['stories']}
still_missing = []
check_ids = [story_filter] if story_filter else phase_ids
for sid in check_ids:
    s = by_id.get(sid, {})
    files = _files_for(s)
    if any(_is_test_file(f) for f in files) and not s.get('testCriteria', {}).get('facts'):
        still_missing.append(sid)

if still_missing:
    print(f"  [tc-writer] ERROR: {len(still_missing)} test stories still missing TCs: {still_missing}", file=sys.stderr)
    sys.exit(1)

print(f"  [tc-writer] Gate PASSED — all test stories have verified TCs")
sys.exit(0)
