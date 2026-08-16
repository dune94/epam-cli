#!/usr/bin/env python3
"""
IS THIS PATH A TEST FILE?

Test-file conventions vary per project — .spec.ts here, .test.ts elsewhere, __tests__/, test_*.py.
Hardcoding one convention made the checks that use this a silent no-op on any codebase using
another, so the rule recognises all of them.

Four handlers asked this question and each carried its own copy of the answer. This is the one
copy. Extracted 2026-08-16.

Handlers are executed by path, so Python puts this directory on sys.path and `from _testfile
import is_test_file` resolves without any packaging.
"""


def is_test_file(path):
    path = path or ''
    base = path.split('/')[-1]
    if '__tests__/' in path or path.startswith('__tests__/'):
        return True
    if base.startswith('test_'):
        return True
    for marker in ('.spec.', '.test.', '_spec.', '_test.'):
        if marker in base:
            return True
    return False
