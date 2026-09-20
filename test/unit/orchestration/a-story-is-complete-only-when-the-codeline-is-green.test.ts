/**
 * A STORY IS COMPLETE ONLY WHEN THE CODELINE IS GREEN.
 *
 * regintel 20260919T224649Z resume 7 (2026-09-20 07:50): REGI-005b ran `pytest
 * tests/test_escalation.py` (its own file, scoped as the project declares), passed, and was marked
 * complete — while the sync classify_event it had just landed broke 18 tests in
 * test_classifier.py, test_injection.py and test_costs.py. Every later story inherited the red
 * suite, and because the project's pytest section declared no failurePattern the baseline could
 * not be parsed ("CANNOT BUILD a test baseline") and nothing could be subtracted.
 *
 * Two things, both config/engine and both modes: (1) the requirements.txt ecosystem declares how
 * a pytest failure is recognised, so a baseline exists; (2) after a story's own scoped suite
 * passes, the codeline's WHOLE declared suite runs; a failure the baseline does not hold is the
 * story's to answer — and the failure text names which story declares each failing test file, so
 * the analyst attributes and the writer escalates to the owner rather than re-guessing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const NODE = process.execPath;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PYTEST_OUT = `============================= test session starts ==============================
collected 20 items

tests/test_classifier.py FFF.....                                        [ 40%]
tests/test_escalation.py ........                                        [ 80%]
tests/test_costs.py F...                                                 [100%]

=================================== FAILURES ===================================
____________________________ test_classify_returns_record ______________________
TypeError: classify_event() got an unexpected keyword argument 'client'
=========================== short test summary info ============================
FAILED tests/test_classifier.py::test_classify_returns_record - TypeError: classify_event() got an unexpected keyword argument 'client'
FAILED tests/test_classifier.py::test_classify_persists - TypeError
FAILED tests/test_classifier.py::test_injection_flagged - TypeError
FAILED tests/test_costs.py::test_cost_report_totals - TypeError
========================= 4 failed, 16 passed in 0.99s =========================
`;

describe('(1) a pytest failure is recognisable — the requirements.txt ecosystem declares the pattern', () => {
  function pyProject() {
    const dir = mkdtempSync(join(tmpdir(), 'py-verif-')); dirs.push(dir);
    writeFileSync(join(dir, 'requirements.txt'), 'pytest\nfastapi\n');
    mkdirSync(join(dir, 'tests')); writeFileSync(join(dir, 'tests', 'test_a.py'), 'def test_a():\n    assert True\n');
    return dir;
  }
  it('detectTests carries a failurePattern and failureIdentity for pytest', () => {
    const dir = pyProject();
    const r = spawnSync(NODE, ['-e', `const p=require(${JSON.stringify(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))}); console.log(JSON.stringify(p.detectTests(${JSON.stringify(dir)})))`], { encoding: 'utf8' });
    const t = JSON.parse(r.stdout || 'null');
    expect(t && t.test, r.stderr).toBeTruthy();
    expect(t.test.failurePattern, 'no failurePattern — the baseline can never be parsed').toBeTruthy();
    expect(t.test.failureIdentity).toBeTruthy();
  });
  it('parseFailures names each failing test by file and name from real pytest output', () => {
    const dir = pyProject();
    mkdirSync(join(dir, '.epam'));
    const det = JSON.parse(spawnSync(NODE, ['-e', `const p=require(${JSON.stringify(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))}); console.log(JSON.stringify(p.detectTests(${JSON.stringify(dir)})))`], { encoding: 'utf8' }).stdout);
    writeFileSync(join(dir, '.epam', 'verification.json'), JSON.stringify(det));
    writeFileSync(join(dir, 'out.txt'), PYTEST_OUT);
    const r = spawnSync(NODE, ['-e', `const fs=require('fs');const p=require(${JSON.stringify(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))}); console.log(JSON.stringify(p.parseFailures(${JSON.stringify(dir)}, fs.readFileSync(${JSON.stringify(join(dir, 'out.txt'))},'utf8'), 'test')))`], { encoding: 'utf8' });
    const ids = JSON.parse(r.stdout || 'null');
    expect(ids, r.stderr).not.toBeNull();
    expect(ids).toContain('tests/test_classifier.py::test_classify_returns_record');
    expect(ids).toContain('tests/test_costs.py::test_cost_report_totals');
    expect(ids).toHaveLength(4);
  });
});

describe('(2) after the story\'s own suite passes, the whole codeline suite decides', () => {
  const LIB = join(ROOT, 'orchestrations/scripts/lib/external-verification.sh');
  function run(opts: { wholeExit: number; newFailures: string; scopedUsed: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'codeline-green-')); dirs.push(dir);
    const logs = join(dir, 'logs'); mkdirSync(logs);
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [
      { id: 'REGI-004b', technicalNotes: { files: ['tests/test_classifier.py'] } },
      { id: 'REGI-005b', technicalNotes: { files: ['tests/test_escalation.py'] } },
      { id: 'REGI-009', technicalNotes: { files: ['tests/test_costs.py', 'scripts/report_costs.py'] } },
    ] }));
    writeFileSync(join(dir, 'new.txt'), opts.newFailures);
    writeFileSync(join(dir, 'whole.sh'), `#!/usr/bin/env bash\ncat <<'EOT'\n${PYTEST_OUT}EOT\nexit ${opts.wholeExit}\n`); chmodSync(join(dir, 'whole.sh'), 0o755);
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `source ${JSON.stringify(LIB)} 2>/dev/null || true`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`, `LOG_DIR=${JSON.stringify(logs)}`, `PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}`, `MAIN_PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}`,
      `log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; success() { echo "OK: $*"; }; info() { echo "INFO: $*"; }`,
      `evidence_window() { echo 200; }`, `_bounded_test_command() { echo "$1"; }`, `_project_run_env_prefix() { echo ""; }`,
      `_project_test_command() { echo ${JSON.stringify(join(dir, 'whole.sh'))}; }`,
      `_project_test_file_pattern() { echo '(^|/)(test_[^/]*|[^/]*_test)\\.py$'; }`,
      // The real contract: exit 0 = nothing new; non-zero = the delta on stdout.
      `baseline_new_failures() { cat ${JSON.stringify(join(dir, 'new.txt'))}; [ ! -s ${JSON.stringify(join(dir, 'new.txt'))} ]; }`,
      `verify_codeline_suite REGI-005b ${JSON.stringify(join(dir, 'attempt.log'))} ${opts.scopedUsed ? '"pytest tests/test_escalation.py"' : `${JSON.stringify(join(dir, 'whole.sh'))}`}; echo "EXIT:$?"`,
      `printf '%s' "$VERIFICATION_FAILURE" > ${JSON.stringify(join(dir, 'vf.txt'))}`,
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    let vf = ''; try { vf = readFileSync(join(dir, 'vf.txt'), 'utf8'); } catch { /* none */ }
    return { out: `${r.stdout}${r.stderr}`, vf };
  }

  it('new failures the baseline does not hold fail the story, and each failing test file is attributed to the story that declares it', () => {
    const t = run({ wholeExit: 1, newFailures: 'FAILED tests/test_classifier.py::test_classify_returns_record\nFAILED tests/test_costs.py::test_cost_report_totals', scopedUsed: true });
    expect(t.out, t.out).toMatch(/EXIT:1/);
    expect(t.vf).toMatch(/tests\/test_classifier\.py[^\n]*REGI-004b/);
    expect(t.vf).toMatch(/tests\/test_costs\.py[^\n]*REGI-009/);
    expect(t.vf).toMatch(/whole|codeline/i);
  });
  it('only pre-existing failures → the story passes', () => {
    const t = run({ wholeExit: 1, newFailures: '', scopedUsed: true });
    expect(t.out).toMatch(/EXIT:0/);
  });
  it('a green whole suite → passes', () => {
    const t = run({ wholeExit: 0, newFailures: '', scopedUsed: true });
    expect(t.out).toMatch(/EXIT:0/);
  });
  it('when the story already ran the whole suite (no scoped command) nothing runs twice', () => {
    const t = run({ wholeExit: 1, newFailures: 'x', scopedUsed: false });
    expect(t.out).toMatch(/EXIT:0/);
    expect(t.out).not.toMatch(/Running the codeline/);
  });
  it('run_external_verification calls it after the scoped run passes', () => {
    const src = readFileSync(LIB, 'utf8');
    const iSuccess = src.indexOf('success "External verification passed for $story_id"');
    const iCall = src.lastIndexOf('verify_codeline_suite "$story_id" "$output_file" "$test_cmd"', iSuccess);
    expect(iCall).toBeGreaterThan(0);
    expect(iCall).toBeLessThan(iSuccess);
  });
});
