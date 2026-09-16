#!/usr/bin/env python3
"""
SPLIT A MAIN SCRIPT INTO MODULES — a MOVE, never an edit.

Every top-level function (column-0 `name() {` … matching `}`) of the given main is lifted, byte
for byte, with the comment block immediately above it, into lib/<module>.sh as the map says. The
main keeps everything that is not a function, and gains one `source` line per module, placed
where that module's FIRST function stood — so definition order relative to the main's top-level
code is exactly what it was (bash defines a function when the definition line executes; a
function called at top level must still be defined before the call).

Proof of identity is the caller's job and is what makes this safe to run at all:
  - `declare -F` before and after are the same set;
  - every function body is byte-identical to the golden it was lifted from (this script emits the
    golden as JSON alongside);
  - `bash -n` on every file; full shellcheck per module; the behavioural suite; the £0 cells.

usage: split-main-into-modules.py <main.sh> <map.json> <lib dir> <golden.json> [--apply]
  map.json: { "<module>": ["fn", ...], ... }   every top-level function must appear exactly once;
            the module "." keeps the function where it is (the entrypoint's own `main`).
  without --apply nothing is written; the plan is printed.
"""
import json
import re
import sys
from pathlib import Path

FN = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{')


def _parses(chunk):
    """bash's own verdict on whether these lines are a complete, valid definition."""
    import subprocess
    r = subprocess.run(['bash', '-n'], input='\n'.join(chunk) + '\n', capture_output=True, text=True)
    return r.returncode == 0


def lift(lines):
    """[(name, comment_start, start, end)] for every column-0 function, end inclusive.

    The end is where the brace count returns to zero AND bash accepts the slice as a complete
    definition — a brace inside a string, a heredoc or a `${x//\{y\}/}` pattern fools the count
    alone (the first version of this lifter cut three functions short that way), and bash is the
    only parser whose verdict matters.
    """
    out = []
    i = 0
    while i < len(lines):
        m = FN.match(lines[i])
        if not m:
            i += 1
            continue
        depth = 0
        j = i
        end = None
        while j < len(lines):
            depth += lines[j].count('{') - lines[j].count('}')
            if depth <= 0 and _parses(lines[i:j + 1]):
                end = j
                break
            j += 1
        if end is None:
            raise SystemExit(f'no parseable end for function {m.group(1)} at line {i + 1}')
        k = i
        while k - 1 >= 0 and lines[k - 1].startswith('#'):
            k -= 1
        out.append((m.group(1), k, i, end))
        i = end + 1
    return out


def main():
    argv = [a for a in sys.argv[1:] if a != '--apply']
    apply = '--apply' in sys.argv
    if len(argv) != 4:
        raise SystemExit(__doc__)
    main_path, map_path, lib_dir, golden_path = map(Path, argv)
    text = main_path.read_text()
    lines = text.split('\n')
    fns = lift(lines)
    names = [f[0] for f in fns]
    if len(set(names)) != len(names):
        dupes = sorted({n for n in names if names.count(n) > 1})
        raise SystemExit(f'duplicate definitions: {dupes}')
    fmap = json.loads(map_path.read_text())
    where = {}
    for mod, fl in fmap.items():
        for n in fl:
            if n in where:
                raise SystemExit(f'{n} mapped twice ({where[n]}, {mod})')
            where[n] = mod
    missing = [n for n in names if n not in where]
    unknown = [n for n in where if n not in names]
    if missing or unknown:
        raise SystemExit(f'map does not cover the file — unmapped: {missing}; not in file: {unknown}')

    # The golden: every function's exact bytes, keyed by name.
    golden = {n: '\n'.join(lines[s:e + 1]) for (n, c, s, e) in fns}
    # THE COMMENT BLOCK ABOVE EACH FUNCTION travels with it and is recorded too, so the original
    # text can be reassembled exactly (test/lib/engine-source.ts): the layout lists, in original
    # order, each kept run of main lines and each moved function.
    comments = {n: '\n'.join(lines[c:s]) for (n, c, s, e) in fns}
    layout = []
    modules = {}          # module -> [chunk text in file order]
    first_line = {}       # module -> line index of its first function's comment block
    keep = []             # the main's remaining lines, with source lines inserted
    cursor = 0
    for (n, c, s, e) in fns:
        mod = where[n]
        if mod == '.':
            continue
        if c > cursor:
            keep.extend(lines[cursor:c])
            layout.append({'keep': c - cursor})
        if mod not in modules:
            modules[mod] = []
            first_line[mod] = c
            keep.append(f'source "$SCRIPT_DIR/lib/{mod}.sh"')
            layout.append({'source': mod})
        modules[mod].append('\n'.join(lines[c:e + 1]))
        layout.append({'fn': n})
        cursor = e + 1
    if cursor < len(lines):
        keep.extend(lines[cursor:])
        layout.append({'keep': len(lines) - cursor})

    print(f'{main_path.name}: {len(fns)} functions → {len(modules)} modules; main keeps {len(keep)} of {len(lines)} lines')
    for mod, chunks in modules.items():
        print(f'  lib/{mod}.sh  {len(chunks)} fns  {sum(ch.count(chr(10)) + 1 for ch in chunks)} lines  (source at former line {first_line[mod] + 1})')
    if not apply:
        return
    lib_dir.mkdir(parents=True, exist_ok=True)
    for mod, chunks in modules.items():
        header = (
            '#!/usr/bin/env bash\n'
            f'# {mod}.sh — moved verbatim out of {main_path.name} by tools/split-main-into-modules.py\n'
            f'# ({len(chunks)} functions). Sourced by {main_path.name}; SCRIPT_DIR and the globals it sets\n'
            '# are in scope exactly as they were. A move, not an edit: every body is byte-identical to\n'
            '# the golden recorded at the move (see the identity test).\n\n'
        )
        (lib_dir / f'{mod}.sh').write_text(header + '\n\n'.join(chunks) + '\n')
    main_path.write_text('\n'.join(keep))
    golden_path.write_text(json.dumps({'source': main_path.name, 'functions': golden, 'comments': comments, 'layout': layout}, indent=1))
    print(f'applied; golden written to {golden_path}')


if __name__ == '__main__':
    main()
