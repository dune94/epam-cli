/**
 * RG-DELTA (backlog item, user requirement 2026-07-30): the regression guard
 * must tolerate PRE-EXISTING test failures on a brownfield codeline but still
 * block on any NEW one. That needs real test IDENTITY, not just a count — a
 * `testFailurePattern` regex, declared per-project in dependency-check.json
 * (same shape as the existing `importPattern`), capturing a failing test's
 * identity from that project's own runner output (e.g. Jest's
 * "FAIL <path>" summary line). Optional: a project that never declares it
 * gets today's all-or-nothing regression guard, unchanged.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PY = join(REPO_ROOT, 'orchestrations/scripts/.venv/bin/python');
const SCHEMA_PY = join(REPO_ROOT, 'orchestrations/scripts/lib/manifest_schema.py');

function py(args: string[], stdin?: string) {
  const r = spawnSync(PY, [SCHEMA_PY, ...args], { encoding: 'utf8', input: stdin, timeout: 60000 });
  return { rc: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function schema(): Record<string, unknown> {
  const r = py(['--print-schema']);
  expect(r.rc, `--print-schema failed:\n${r.err}`).toBe(0);
  return JSON.parse(r.out);
}

function review(manifest: unknown, repo: string) {
  const r = py(['--validate', '--repo', repo], JSON.stringify(manifest));
  const parsed = r.out ? JSON.parse(r.out) : { verdict: 'fail', issues: ['no output'] };
  return { rc: r.rc, ...parsed } as { rc: number; verdict: string; issues: string[] };
}

const GOOD = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  installCommand: 'npm install --no-save {package}',
  vendorDirs: ['node_modules'],
};

describe('testFailurePattern — optional field, RG-DELTA is inert without it', () => {
  it('is NOT in the schema\'s required list (backward-compatible with every existing manifest)', () => {
    const inner = (schema().schema as Record<string, unknown>);
    const required = inner.required as string[];
    expect(required, 'testFailurePattern must stay optional').not.toContain('testFailurePattern');
  });

  it('accepts a manifest with no testFailurePattern at all — validate() still passes', () => {
    const repo = REPO_ROOT; // any real repo with a package.json works for this check
    const v = review(GOOD, repo);
    expect(v.verdict, JSON.stringify(v.issues)).toBe('pass');
  });

  it('accepts a manifest that declares a valid testFailurePattern', () => {
    const repo = REPO_ROOT;
    const v = review({ ...GOOD, testFailurePattern: '^FAIL\\s+(\\S+)' }, repo);
    expect(v.verdict, JSON.stringify(v.issues)).toBe('pass');
  });

  it('rejects a testFailurePattern that does not compile as a regex', () => {
    const repo = REPO_ROOT;
    const v = review({ ...GOOD, testFailurePattern: '([unclosed' }, repo);
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/testFailurePattern/i);
  });
});
