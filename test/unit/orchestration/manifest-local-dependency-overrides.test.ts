/**
 * Local dependency overrides (2026-07-31): a private-registry auth failure
 * (GitHub Packages 401 for @metrolinx/cx-shared, no GH_TOKEN available) left
 * a codeline's node_modules half-installed and every build/test broken.
 * User directive: route to internal/local, never external — the client
 * already has the real package source cloned locally as its own codeline.
 *
 * "Fix once and commit it" is not available — this session's standing rule
 * is NEVER commit to a client repo, not even locally (see
 * feedback_no_client_repo_writes_or_hardcoding.md). So the fix must be an
 * ENGINE-side re-provisioning step (brownfield-preflight-reset.sh, this
 * manifest field) that re-applies every launch, entirely in untracked
 * node_modules — never touching the client's git index or history.
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

describe('localDependencyOverrides — optional field, backward-compatible', () => {
  it('is NOT in the schema\'s required list', () => {
    const inner = (schema().schema as Record<string, unknown>);
    const required = inner.required as string[];
    expect(required).not.toContain('localDependencyOverrides');
  });

  it('accepts a manifest with no localDependencyOverrides at all', () => {
    const v = review(GOOD, REPO_ROOT);
    expect(v.verdict, JSON.stringify(v.issues)).toBe('pass');
  });

  it('accepts a manifest with a valid override whose localSourcePath exists', () => {
    const v = review({
      ...GOOD,
      localDependencyOverrides: [
        { codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: REPO_ROOT },
      ],
    }, REPO_ROOT);
    expect(v.verdict, JSON.stringify(v.issues)).toBe('pass');
  });

  it('rejects an override whose localSourcePath does not exist on disk', () => {
    const v = review({
      ...GOOD,
      localDependencyOverrides: [
        { codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: '/does/not/exist/anywhere' },
      ],
    }, REPO_ROOT);
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/localSourcePath|does not exist/i);
  });

  it('rejects an override missing a required field (codeline/package/localSourcePath)', () => {
    const v = review({
      ...GOOD,
      localDependencyOverrides: [{ package: '@metrolinx/cx-shared', localSourcePath: REPO_ROOT }],
    }, REPO_ROOT);
    expect(v.verdict).toBe('fail');
  });
});
