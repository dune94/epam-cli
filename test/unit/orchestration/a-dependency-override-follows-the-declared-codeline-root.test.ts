/**
 * A LOCAL DEPENDENCY OVERRIDE FOLLOWS THE CODELINE ROOT THIS INSTALL DECLARES.
 *
 * Found 2026-09-05 on a fresh TEST install (pipeline-tests-26), while answering "does anything
 * still point at the real codelines?":
 *
 *     orchestrations/projects/metrolinx/dependency-check.json
 *       "localSourcePath": "/home/bradleyjerome/projects/metrolinx/cx-shared"
 *
 * The install's own JIRA_CODELINE_ROOT is /home/bradleyjerome/projects/tests/codelines. So a test
 * install carried an absolute path into the REAL working copies, and `npm install` would have
 * linked a dependency straight out of them.
 *
 * IT VALIDATED CLEANLY, WHICH IS THE WHOLE PROBLEM. The check is `os.path.exists`, and that path
 * does exist — both roots hold a cx-shared. A gate that asks "is this path real?" cannot notice
 * that it is real *in the wrong tree*. The failure is silent by construction, and it survived an
 * operator rule stating the test project must never address the real codelines.
 *
 * WHY NOT JUST RETYPE THE PATH. Editing it to the test root fixes this install and re-arms the
 * same trap for the next one: the value is absolute, so it is wrong everywhere except the machine
 * it was typed on, and nothing detects it. The root is already declared once, per install, in the
 * project's config.env. This makes the override read from that single declaration instead of
 * restating it — see the single-point-of-maintenance rule.
 *
 * BOTH ENDS, and the third case is the one that matters most:
 *   - a RELATIVE path resolves against JIRA_CODELINE_ROOT, so it follows whatever this install
 *     declares
 *   - an ABSOLUTE path still works untouched, because other projects may legitimately point
 *     outside the codeline root and this must not break them
 *   - a relative path with NO root declared FAILS LOUDLY, rather than silently resolving against
 *     the process's cwd — which would reintroduce exactly the "real path, wrong tree" defect
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PY = join(REPO_ROOT, 'orchestrations/scripts/.venv/bin/python');
const SCHEMA_PY = join(REPO_ROOT, 'orchestrations/scripts/lib/manifest_schema.py');

const BASE = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies'],
  scanFileExtensions: ['.ts'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  installCommand: 'npm install --no-save {package}',
  vendorDirs: ['node_modules'],
};

function validate(manifest: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(PY, [SCHEMA_PY, '--validate', '--repo', REPO_ROOT], {
    encoding: 'utf8',
    input: JSON.stringify(manifest),
    timeout: 60_000,
    env: { ...process.env, JIRA_CODELINE_ROOT: '', ...env },
  });
  const out = (r.stdout || '').trim();
  const parsed = out ? JSON.parse(out) : { verdict: 'fail', issues: [`no output: ${r.stderr}`] };
  return parsed as { verdict: string; issues: string[] };
}

/** A codeline root with one repo in it, exactly as an install's root is shaped. */
function rootWith(dirName: string) {
  const root = mkdtempSync(join(tmpdir(), 'codelines-'));
  mkdirSync(join(root, dirName), { recursive: true });
  return root;
}

const withOverride = (localSourcePath: string) => ({
  ...BASE,
  localDependencyOverrides: [
    { codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath },
  ],
});

describe('localSourcePath and the declared codeline root', () => {
  it('the validator is present — otherwise every case here is vacuous', () => {
    expect(existsSync(PY), 'the project venv is missing; these cases would all report "no output"')
      .toBe(true);
    expect(existsSync(SCHEMA_PY)).toBe(true);
    expect(validate(BASE).verdict, 'a manifest with no overrides at all should pass').toBe('pass');
  });

  it('END ONE — a RELATIVE path resolves against the declared root', () => {
    const root = rootWith('cx-shared');
    try {
      const v = validate(withOverride('cx-shared'), { JIRA_CODELINE_ROOT: root });
      expect(v.verdict, [
        `'cx-shared' was not resolved against JIRA_CODELINE_ROOT (${root}), so a project cannot`,
        'express its override relative to the root and is forced back to an absolute path that is',
        'wrong on every other install.',
        `issues: ${JSON.stringify(v.issues)}`,
      ].join('\n')).toBe('pass');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a relative path that does not exist UNDER THE ROOT still fails', () => {
    // Resolution must not become a way to pass without the directory being there.
    const root = rootWith('cx-shared');
    try {
      const v = validate(withOverride('not-here'), { JIRA_CODELINE_ROOT: root });
      expect(v.verdict, 'a missing directory passed once resolution was added').toBe('fail');
      expect(v.issues.join(' ')).toMatch(/localSourcePath|does not exist/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('END TWO — an ABSOLUTE path still works, untouched', () => {
    // Other projects may legitimately point outside the codeline root. Backward compatibility is
    // not optional here: this field already ships with absolute values in the wild.
    const v = validate(withOverride(REPO_ROOT), { JIRA_CODELINE_ROOT: '/nonexistent/root' });
    expect(v.verdict, [
      'an absolute localSourcePath stopped validating once relative resolution was added — the',
      'root must only be consulted for paths that are not already absolute.',
      `issues: ${JSON.stringify(v.issues)}`,
    ].join('\n')).toBe('pass');
  });

  it('an absolute path that does not exist still fails', () => {
    const v = validate(withOverride('/does/not/exist/anywhere'));
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/does not exist/i);
  });

  it('THE SILENT CASE — a relative path with NO root declared fails loudly', () => {
    /**
     * Never resolve against the process cwd. That is how "a real path in the wrong tree" happens:
     * it would pass on whichever machine ran it from the right directory and point somewhere else
     * everywhere else, which is the defect this whole file exists to close.
     */
    const v = validate(withOverride('cx-shared'), { JIRA_CODELINE_ROOT: '' });
    expect(v.verdict, [
      'a relative override was accepted with no codeline root declared, so it resolved against',
      'whatever directory the validator happened to run in.',
    ].join('\n')).toBe('fail');
    expect(v.issues.join(' '),
      'the failure does not say the root is missing, so an operator cannot act on it')
      .toMatch(/JIRA_CODELINE_ROOT|codeline root/i);
  });
});

describe('the metrolinx project no longer addresses the real codelines', () => {
  it('declares no absolute path into a codeline tree', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dc = require(join(REPO_ROOT, 'orchestrations/projects/metrolinx/dependency-check.json'));
    for (const o of dc.localDependencyOverrides || []) {
      expect(o.localSourcePath.startsWith('/'), [
        `localSourcePath '${o.localSourcePath}' is absolute, so it names one machine's tree. A`,
        'test install then points into the real working copies while validating cleanly, because',
        'both roots contain a directory by that name.',
      ].join('\n')).toBe(false);
    }
  });
});
