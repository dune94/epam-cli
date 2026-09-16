/**
 * A PYTHON CODELINE DECLARES HOW IT IS CHECKED AND TESTED — DERIVED, NEVER COPIED.
 *
 * The first Python greenfield project (2026-09-12: requirements.txt, FastAPI, pytest, tests/) was
 * handed .epam/ manifests copied from a TypeScript project — package.json, npm, vitest — and no
 * test command at all, because:
 *
 *   1. the verification plugin detected a suite from package.json scripts and nowhere else, so a
 *      pytest repository had "no test command" for the oracle, external verification and the gates;
 *   2. the requirements.txt ecosystem provider declared no testCommand and no test-file rule;
 *   3. a greenfield launch seeds .epam/ from the project directory before the codeline exists, and
 *      the orchestrator derived manifests only where NONE existed — a seeded declaration the
 *      codeline contradicts was kept.
 *
 * Every case executes the real code over a fixture codeline: the plugin, the provider through the
 * manifest assembler, and the orchestrator's own re-derivation block lifted from the script.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function codeline(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'pycl-')); dirs.push(d);
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), body); }
  return d;
}
const PY = { 'requirements.txt': 'fastapi\npytest>=8\nhttpx\n', 'regintel/store.py': 'x = 1\n', 'tests/test_store.py': 'def test_x(): pass\n' };

describe('the verification plugin asks the ecosystem that recognises the codeline', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require(join(ROOT, 'orchestrations/plugins/verification-plugin.js'));

  it('a requirements.txt codeline that depends on pytest runs pytest, one file at a time too, and knows its test files', () => {
    const t = plugin.detectTests(codeline(PY));
    expect(t?.test?.command).toBe('pytest');
    expect(t?.test?.scopedCommand).toBe('pytest {files}');
    const re = new RegExp(t.test.testFilePattern);
    expect(re.test('tests/test_store.py')).toBe(true);
    expect(re.test('regintel/store.py')).toBe(false);
    expect(t.test.detected).toMatch(/requirements\.txt/);
  });

  it('a Python codeline declares a type check the ecosystem provides, so the writer is not failed for a check nobody could run', () => {
    // "[tsc-verify] the project declares no typecheck command — the check could not run" failed
    // every attempt of the £0 greenfield run (2026-09-13): the plugin detected verification from
    // package.json only. The ecosystem provider declares one for Python; the plugin reads it.
    const d = codeline(PY);
    const v = plugin.detectVerification(d);
    expect(v && v.typecheck && v.typecheck.command, 'no typecheck detected for a Python codeline').toBeTruthy();
    expect(v.typecheck.failurePattern).toBeTruthy();
    // And it RUNS: the command the ecosystem declares exits 0 on this codeline.
    const r = spawnSync('bash', ['-c', v.typecheck.command], { cwd: d, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // And catches a syntax error, by file and line, in the identity the plugin declares.
    writeFileSync(join(d, 'regintel/broken.py'), 'def x(:\n');
    const bad = spawnSync('bash', ['-c', v.typecheck.command], { cwd: d, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(new RegExp(v.typecheck.failurePattern, 'm').test(bad.stdout + bad.stderr), `pattern misses: ${(bad.stdout + bad.stderr).slice(0, 300)}`).toBe(true);
  });

  it('one that does not depend on pytest declares NO suite — cannot prove, never a guess', () => {
    expect(plugin.detectTests(codeline({ 'requirements.txt': 'fastapi\n' }))).toBeNull();
  });

  it('a Node codeline still resolves from package.json first', () => {
    const t = plugin.detectTests(codeline({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'requirements.txt': 'pytest\n' }));
    expect(t?.test?.command).toMatch(/npm run test/);
  });
});

describe('the manifests a Python codeline gets are its own', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { build } = require(join(SCRIPTS, 'lib/handlers/codeline-manifests.js'));

  it('dependency-check names requirements.txt, scans .py, and parses Python imports', () => {
    const m = build(codeline(PY));
    const dc = m['dependency-check.json'];
    expect(dc.manifestFile).toBe('requirements.txt');
    expect(dc.scanFileExtensions).toEqual(['.py']);
    const re = new RegExp(dc.importPattern, 'm');
    expect(re.test('from fastapi import FastAPI')).toBe(true);
    expect(re.test('import sqlite3')).toBe(true);
    expect(re.test('x = "import nothing"')).toBe(false);
  });

  it('contract-generation is Python, with pytest\'s own test-file rule', () => {
    const m = build(codeline(PY));
    const cg = m['contract-generation.json'];
    expect(cg.language).toBe('python');
    expect(cg.sourceExtensions).toEqual(['.py']);
    expect(new RegExp(cg.testFilePattern).test('tests/test_dedup.py')).toBe(true);
    expect(new RegExp(cg.excludePattern).test('tests/test_dedup.py')).toBe(true);
    expect(new RegExp(cg.excludePattern).test('regintel/dedup.py')).toBe(false);
  });
});

describe('the orchestrator re-derives a seeded declaration the codeline contradicts', () => {
  /** The re-derivation block, lifted from the orchestrator by its own heading and executed. */
  function rederive(wt: string) {
    const src = engineSource(join(SCRIPTS, 'run-agent-orchestration.sh')).split('\n');
    const start = src.findIndex((l) => l.includes('A DECLARATION THE CODELINE CONTRADICTS IS RE-DERIVED'));
    expect(start, 'the re-derivation block is gone from the orchestrator').toBeGreaterThan(-1);
    const end = src.findIndex((l, i) => i > start && l.includes('Wrote .epam/ manifests to'));
    const body = src.slice(start, end + 3).join('\n');
    expect(body, 'the lifted block does not end where expected').toMatch(/\n\s*fi\s*\n\s*fi\s*$/);
    const script = `#!/bin/bash
set -uo pipefail
warning(){ echo "WARN: $*"; }; log(){ echo "LOG: $*"; }
NODE_BIN=${JSON.stringify(process.execPath)}; SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
f() { local _wt="$1"
${body}
}
f ${JSON.stringify(wt)}
`;
    const d = mkdtempSync(join(tmpdir(), 'rederive-')); dirs.push(d);
    writeFileSync(join(d, 'run.sh'), script);
    const r = spawnSync('bash', [join(d, 'run.sh')], { encoding: 'utf8', timeout: 60_000 });
    return (r.stdout || '') + (r.stderr || '');
  }
  const seededTs = {
    '.epam/dependency-check.json': JSON.stringify({ manifestFile: 'package.json', installCommand: 'npm install --save-dev {package}', scanFileExtensions: ['.ts'] }),
    '.epam/contract-generation.json': JSON.stringify({ language: 'typescript' }),
    '.epam/known-fixes.json': JSON.stringify([{ id: 'vitest-pass-with-no-tests', targetFile: 'vitest.config.ts' }]),
  };

  it('TypeScript manifests seeded into a pytest codeline are replaced by the codeline\'s own, and the stale sibling is removed', () => {
    const wt = codeline({ ...PY, ...seededTs });
    const out = rederive(wt);
    expect(out).toMatch(/declares manifest 'package.json', which this codeline does not carry/);
    const dc = JSON.parse(engineSource(join(wt, '.epam/dependency-check.json')));
    expect(dc.manifestFile).toBe('requirements.txt');
    expect(dc.scanFileExtensions).toEqual(['.py']);
    expect(JSON.parse(engineSource(join(wt, '.epam/contract-generation.json'))).language).toBe('python');
    expect(existsSync(join(wt, '.epam/known-fixes.json')), 'a known-fixes file about vitest.config.ts survived in a Python codeline').toBe(false);
    expect(out).toMatch(/Removed seeded \.epam\/known-fixes\.json/);
  });

  it('a declaration the codeline agrees with is left exactly as declared', () => {
    const wt = codeline({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }), ...seededTs });
    const before = engineSource(join(wt, '.epam/dependency-check.json'));
    const out = rederive(wt);
    expect(out).not.toMatch(/re-derived/);
    expect(engineSource(join(wt, '.epam/dependency-check.json'))).toBe(before);
    expect(existsSync(join(wt, '.epam/known-fixes.json'))).toBe(true);
  });

  it('an empty codeline (scaffold not yet run) with no declaration gets nothing and says so — never a fabricated stack', () => {
    const wt = codeline({ 'README.md': '# empty\n' });
    const out = rederive(wt);
    expect(existsSync(join(wt, '.epam/dependency-check.json'))).toBe(false);
    expect(out).toMatch(/no provider declares how this codeline is checked/);
  });
});

/**
 * THE MANIFEST IS DETECTED FROM WHAT THE CODELINE HOLDS NOW. A greenfield codeline holds nothing
 * at provisioning, so no verification manifest exists until its first story creates the ecosystem
 * manifest; the type-check gate must detect at that moment. The real writer of the manifest
 * (lib/git-ops.sh) is executed on a codeline that has just acquired requirements.txt.
 */
describe('the verification manifest is detected from what the codeline holds now', () => {
  it('a codeline that just acquired requirements.txt gets typecheck and test sections', () => {
    const d = codeline(PY);
    const script = `set -uo pipefail
AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}
NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}
_epam_write_verification_manifest ${JSON.stringify(d)}
cat ${JSON.stringify(join(d, '.epam/verification.json'))}`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });
    const doc = JSON.parse((r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{') || l.startsWith(' ') || l.startsWith('}')).join('\n') || 'null');
    expect(doc && doc.typecheck && doc.typecheck.command, `no typecheck in the written manifest: ${r.stdout} ${r.stderr}`).toBeTruthy();
    expect(doc.test && doc.test.command, 'no test section in the written manifest').toBeTruthy();
  });
});

/**
 * A CHECK THE ECOSYSTEM DECLARES NO CONVENTION FOR REPORTS OK, NEVER CRASHES. The mock-completeness
 * check reads the mock-factory patterns the node ecosystem declares; on a Python codeline's
 * contract-generation manifest it crashed with KeyError (£0 greenfield harness, 2026-09-13) and the
 * attempt was judged on a traceback. Executed against the real handler with the real manifest.
 */
describe('a check the ecosystem declares no convention for reports OK', () => {
  it('mock-completeness-check on a Python contract-generation manifest', () => {
    const d = codeline(PY);
    const cm = require(join(SCRIPTS, 'lib/handlers/codeline-manifests.js'));
    const built = cm.build(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/contract-generation.json'), JSON.stringify(built['contract-generation.json']));
    const r = spawnSync('python3', [join(SCRIPTS, 'lib/handlers/mock-completeness-check.py'), d, join(d, '.epam/contract-generation.json')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect((r.stdout || '').split('\n')[0]).toBe('OK');
  });
});

describe('the post-story contract generator on a codeline whose ecosystem declares no contract patterns', () => {
  it('says so and exits 0 — a completed story is not failed by a traceback', () => {
    const d = codeline(PY);
    const cm = require(join(SCRIPTS, 'lib/handlers/codeline-manifests.js'));
    const built = cm.build(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/contract-generation.json'), JSON.stringify(built['contract-generation.json']));
    const r = spawnSync('python3', [join(SCRIPTS, 'lib/handlers/contract-from-files.py'), d, join(d, 'contract.json'), JSON.stringify(['regintel/store.py']), 'S-1', join(d, '.epam/contract-generation.json')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Traceback/);
  });
});
