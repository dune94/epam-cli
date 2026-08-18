/**
 * SAST-sentinel is required to classify CVEs it is given no way to classify.
 *
 * Its prompt mandates: runtime dependency CVEs at high severity are `major`,
 * dev-only CVEs are `minor` regardless of CVSS. But the injected evidence is
 * npm audit output alone — which never says whether a package is a runtime or a
 * dev dependency. Live metrolinx 2026-07-26, the agent said so itself:
 *
 *   "The injected evidence lists affected packages but does not include
 *    package.json contents, making it impossible to definitively classify each
 *    package as a runtime dependency versus a dev-only dependency. Per the
 *    mandatory classification rule ... Without package.json access to c..."
 *
 * It handled that honestly instead of guessing, which is right — and it meant
 * 70 vulnerabilities went unclassified.
 *
 * The classification is a lookup, not a judgement, so the pipeline should do it
 * deterministically and hand over the answer rather than the raw material.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/**
 * THE SUMMARISER, WHICH IS NOW A FILE.
 *
 * It used to be a 48-line Python program held in a shell single-quoted string, so this suite had
 * to cut it back out of run-agent-orchestration.sh and pipe it to `python3 -`. Extracting a
 * program to test it is a sign the program is in the wrong place: it could not be run, linted or
 * imported on its own. It is now lib/handlers/dependency-audit-summary.py and is executed the way
 * the pipeline executes it.
 */
const AUDIT_HANDLER = join(REPO_ROOT, 'orchestrations/scripts/lib/handlers/dependency-audit-summary.py');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runSummariser(audit: unknown, pkg: unknown | null) {
  const dir = mkdtempSync(join(tmpdir(), 'sast-audit-'));
  cleanupDirs.push(dir);
  const auditPath = join(dir, 'audit.json');
  writeFileSync(auditPath, JSON.stringify(audit));
  const args = [auditPath];
  if (pkg !== null) {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify(pkg));
    args.push(pkgPath);
  }
  const r = spawnSync('python3', [AUDIT_HANDLER, ...args], { encoding: 'utf8', timeout: 20000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

const AUDIT = {
  metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 0 } },
  vulnerabilities: {
    axios:   { severity: 'high',     via: [{ title: 'SSRF' }] },
    jest:    { severity: 'high',     via: [{ title: 'proto pollution' }] },
    tmp:     { severity: 'moderate', via: [{ title: 'symlink' }] },
  },
};

const PKG = {
  dependencies:    { axios: '^1.6.0' },
  devDependencies: { jest: '^29.0.0' },
};

describe('the pipeline classifies dependencies instead of asking the model to guess', () => {
  it('marks a runtime dependency as runtime', () => {
    const out = runSummariser(AUDIT, PKG);
    const line = out.split('\n').find(l => l.includes('axios')) ?? '';
    expect(line, `axios is in "dependencies" but was not marked runtime — line was: ${line}`)
      .toMatch(/runtime/i);
  });

  it('marks a dev-only dependency as dev', () => {
    const out = runSummariser(AUDIT, PKG);
    const line = out.split('\n').find(l => l.includes('jest')) ?? '';
    expect(line,
      'jest is devDependencies-only; without this the model must treat a dev CVE as ' +
      'possibly-runtime and cannot apply the mandatory major/minor rule')
      .toMatch(/\bdev\b/i);
  });

  it('marks a package that is in neither list as transitive', () => {
    const out = runSummariser(AUDIT, PKG);
    const line = out.split('\n').find(l => l.includes('tmp')) ?? '';
    expect(line, 'a transitive dependency was silently presented like a direct one')
      .toMatch(/transitive/i);
  });

  it('still summarises when package.json is unavailable', () => {
    const out = runSummariser(AUDIT, null);
    expect(out, 'the summariser broke when it could not classify').toMatch(/total=3/);
    expect(out).toMatch(/axios/);
  });

  it('keeps the severity counts it always produced', () => {
    const out = runSummariser(AUDIT, PKG);
    expect(out).toMatch(/total=3/);
    expect(out).toMatch(/high=2/);
  });

  it('does not crash on malformed audit input', () => {
    expect(runSummariser({ nonsense: true }, PKG)).not.toMatch(/Traceback/);
  });
});

describe('the classification is actually passed to the agent', () => {
  it('the oracle hands package.json to the summariser', () => {
    const start = orchSrc.indexOf('npm audit Oracle');
    expect(start, 'npm audit oracle block not found').toBeGreaterThan(-1);
    const end = orchSrc.indexOf('sast_prompt=', start);
    const block = orchSrc.slice(start, end > start ? end : start + 4000);
    expect(block,
      'package.json is never given to the summariser, so nothing can be classified')
      .toMatch(/package\.json"?\s*$|\$PROJECT_ROOT\/package\.json/m);
  });
});
