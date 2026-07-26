#!/usr/bin/env python3
"""eslint_findings_diff.py — separate the lint findings this run introduced
from the ones the codebase already had.

The Step 20 lint gate used to lint the whole tree and fail on any finding at
all. That only survives on a codeline with zero pre-existing lint debt. On any
other, the gate fails on a file no agent touched, the gate-finding-analyst
cannot map the finding to a story ("Could not map lint failure to a story"),
and the run dies over inherited formatting. Worse, the only way a writer could
satisfy such a gate is by reformatting code its ticket never mentioned — which
the team-lead reviewer is separately instructed to veto as over-engineering.

lib/tsc-baseline-gate.sh already solved exactly this shape for tsc: compute the
errors at the phase baseline, report only the excess. This is the
set-subtraction half of the same idea for ESLint.

Keying is (file, ruleId, message) with COUNTS, not (file, line, column). Our
own edit shifts every line below it, so a position-keyed subtraction would
re-report untouched inherited findings as new — the exact false positive this
exists to prevent. Counting preserves the one case that matters: introducing a
SECOND instance of a violation the file already had once.

Usage:
  eslint_findings_diff.py diff        <baseline.json|-> <current.json> <root>
  eslint_findings_diff.py dirty-files <baseline.json|-> <root>
  eslint_findings_diff.py clean-files <baseline.json|-> <root>

Exit status is a contract: `diff` exits 1 when new findings exist, 0 when none.
A baseline that cannot be parsed is reported loudly and treated as ABSENT
(everything is new) — never as "nothing to report", which would silently
disable the gate.
"""

import json
import os
import sys
from collections import Counter


def load_report(path):
    """Returns (entries, ok). ok=False means 'no usable baseline'."""
    if path == '-':
        return [], False
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        print(
            'eslint_findings_diff: baseline %s unusable (%s) — treating every '
            'finding as new rather than suppressing silently' % (path, exc),
            file=sys.stderr,
        )
        return [], False
    if not isinstance(data, list):
        print(
            'eslint_findings_diff: baseline %s is not an ESLint JSON report — '
            'treating every finding as new' % path,
            file=sys.stderr,
        )
        return [], False
    return data, True


def relativize(file_path, root, known=None):
    """Map an ESLint absolute filePath to a repo-relative key.

    Baseline findings are produced inside a temporary git worktree, so their
    absolute prefix differs from the live tree by construction. Strip `root`
    when it applies; otherwise recover the path by matching a known
    repo-relative key as a suffix.
    """
    root = root.rstrip('/')
    if root and file_path.startswith(root + '/'):
        return file_path[len(root) + 1:]
    if known:
        for key in known:
            if file_path.endswith('/' + key):
                return key
    return os.path.basename(file_path)


def index(entries, root, known=None):
    """(file, ruleId, message) -> [message dicts], in file order."""
    grouped = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        rel = relativize(entry.get('filePath', ''), root, known)
        for msg in entry.get('messages') or []:
            key = (rel, msg.get('ruleId') or '', msg.get('message') or '')
            grouped.setdefault(key, []).append((rel, msg))
    return grouped


def relative_files(entries, root):
    return [relativize(e.get('filePath', ''), root) for e in entries if isinstance(e, dict)]


def cmd_diff(baseline_path, current_path, root):
    current, _ = load_report(current_path)
    baseline, have_baseline = load_report(baseline_path)

    current_index = index(current, root)
    known = {key[0] for key in current_index}
    baseline_counts = Counter()
    if have_baseline:
        for key, msgs in index(baseline, root, known).items():
            baseline_counts[key] = len(msgs)

    new = []
    for key, msgs in current_index.items():
        surplus = len(msgs) - baseline_counts.get(key, 0)
        if surplus > 0:
            # Report the trailing occurrences: the pre-existing ones are, by
            # construction, indistinguishable, so blame the excess.
            new.extend(msgs[-surplus:])

    new.sort(key=lambda pair: (pair[0], pair[1].get('line') or 0, pair[1].get('column') or 0))
    for rel, msg in new:
        print('%s:%s:%s  %s  %s' % (
            rel,
            msg.get('line', '?'),
            msg.get('column', '?'),
            msg.get('ruleId') or '(no rule)',
            (msg.get('message') or '').replace('\n', ' '),
        ))

    suppressed = sum(baseline_counts.values())
    if suppressed:
        print('(%d pre-existing finding(s) at baseline not attributed to this run)' % suppressed)
    print('NEW_FINDINGS=%d' % len(new))
    return 1 if new else 0


def cmd_file_list(baseline_path, root, want_dirty):
    baseline, have_baseline = load_report(baseline_path)
    if not have_baseline:
        # Nothing is known-dirty. On greenfield that is literally true; on a
        # broken baseline it is the conservative answer for the caller's use
        # (which files are safe to auto-fix) — see the gate's own guard.
        return 0
    for entry in baseline:
        if not isinstance(entry, dict):
            continue
        has_findings = bool(entry.get('messages'))
        if has_findings == want_dirty:
            print(relativize(entry.get('filePath', ''), root))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    mode = argv[1]
    if mode == 'diff':
        if len(argv) < 5:
            print('usage: diff <baseline|-> <current> <root>', file=sys.stderr)
            return 2
        return cmd_diff(argv[2], argv[3], argv[4])
    if mode in ('dirty-files', 'clean-files'):
        if len(argv) < 4:
            print('usage: %s <baseline|-> <root>' % mode, file=sys.stderr)
            return 2
        return cmd_file_list(argv[2], argv[3], want_dirty=(mode == 'dirty-files'))
    print('eslint_findings_diff: unknown mode %r' % mode, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
