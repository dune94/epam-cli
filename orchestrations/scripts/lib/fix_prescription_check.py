#!/usr/bin/env python3
"""fix_prescription_check.py — is this fix instruction implementable, or a guess?

Live metrolinx 2026-07-26, run 5. The detective's prescription read:

    "Change line 17 from strict equality to a prefix match that accounts for
     the return-trip key suffix appended by getDispatchLineItemKey"

Every word of that is true, and it is still not enough to implement from. It
says "prefix match … suffix" and never says WHAT the suffix is. The implementer
guessed `-`; the repository declares `const DIVIDER = '#'`. The resulting
`startsWith(discount.lineItemId + '-')` can never match, so the bug shipped
unfixed behind a plausible diff, and every gate downstream saw a reasonable
change.

The rule: if a fix turns on a string format, it must quote the literal or name
the constant that owns it — otherwise it is asking the next agent to guess, and
this pipeline has now proved that it will.

Separately, naming the function that CONSTRUCTS a value invites the implementer
to reconstruct the format by hand. If a parser counterpart exists, say so: the
best fix does no string surgery at all, because the helper owns the format.

Deliberately narrow, and fails OPEN on anything it cannot determine. An
over-eager prescription check would stall runs over well-specified fixes.

Usage:  fix_prescription_check.py <repo> <helper> <fix-text>
Exit:   0 implementable · 1 under-specified (reason on stdout)
"""

import os
import re
import sys

# Wording that means "this fix depends on the shape of a string".
_FORMAT_SIGNALS = re.compile(
    r'\b(prefix|suffix|separator|delimiter|starts?with|endswith|split|substring|'
    r'concatenat\w*|append\w*\s+(?:to|by)|trailing|leading)\b', re.I)

# A quoted literal ('#', "#return") or a SCREAMING_CASE constant.
_LITERAL = re.compile(r"""['"`][^'"`]{1,24}['"`]""")
# Any all-caps token could be a constant OR just emphatic prose ("MUST", "JSON").
# Rather than guess from shape, check whether the repo actually declares it —
# a cited constant that does not exist is not a specification either.
_CONSTANT = re.compile(r'\b[A-Z][A-Z0-9_]{3,}\b')

_SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'coverage', '.codegraph', '.epam'}

# Pairs of verbs that indicate a writer and its reader.
_WRITER_HINTS = ('get', 'build', 'make', 'create', 'to', 'format', 'encode', 'serialize')
_READER_HINTS = ('parse', 'read', 'from', 'decode', 'deserialize', 'extract', 'split')


def source_files(repo):
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            if f.endswith(('.ts', '.tsx', '.js', '.jsx', '.mts', '.cts')):
                yield os.path.join(root, f)


def find_parser_counterpart(repo, helper):
    """A function over the same noun that READS rather than WRITES."""
    if not helper:
        return None
    noun = re.sub(r'^(get|build|make|create|to|format|encode|serialize)', '', helper)
    if not noun or noun == helper:
        return None
    try:
        for path in source_files(repo):
            with open(path, errors='replace') as f:
                text = f.read()
            for m in re.finditer(r'\b(?:function|const)\s+([A-Za-z_][A-Za-z0-9_]*)', text):
                name = m.group(1)
                if name == helper:
                    continue
                if noun.lower() in name.lower() and \
                        any(name.lower().startswith(h) for h in _READER_HINTS):
                    return name
    except OSError:
        return None
    return None


def main(argv):
    if len(argv) < 4:
        return 0                                   # fail open on misuse
    repo, helper, fix = argv[1], argv[2], ' '.join(argv[3:])
    if not os.path.isdir(repo) or not fix.strip():
        return 0

    if not _FORMAT_SIGNALS.search(fix):
        return 0                                   # not a format-dependent fix

    # A fix that simply delegates to a parser does no format handling itself.
    if helper and helper.lower().startswith(_READER_HINTS) and helper in fix:
        return 0

    has_literal = bool(_LITERAL.search(fix))
    has_constant = False
    cited = set(_CONSTANT.findall(fix))
    if cited:
        try:
            for path in source_files(repo):
                with open(path, errors='replace') as f:
                    text = f.read()
                if any(re.search(r'\b(?:const|let|var|enum)\s+%s\b' % re.escape(c), text)
                       for c in cited):
                    has_constant = True
                    break
        except OSError:
            has_constant = False
    counterpart = find_parser_counterpart(repo, helper)

    if has_literal or has_constant:
        # Specified well enough to implement. Still surface the parser, because
        # delegating beats hand-written string surgery.
        if counterpart:
            print('prescription is implementable, but %s already reads this format — '
                  'prefer delegating to it over hand-written string handling.' % counterpart)
        return 0

    reason = ('the fix depends on a string format (prefix/suffix/separator) but never states '
              'it — no quoted literal and no named constant. The implementer must therefore '
              'GUESS the separator, and on 2026-07-26 it guessed "-" where the repository '
              'uses "#", shipping a fix that could never match. Quote the exact literal, or '
              'name the constant that defines it')
    if counterpart:
        reason += (', or better: prescribe %s, which already reads this format so the '
                   'separator cannot be got wrong' % counterpart)
    print(reason + '.')
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
