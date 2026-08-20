/**
 * STEP 4.5 VERIFIES THE STORIES THAT DECLARE unitTests:true. IT PASSED THEM WITHOUT RUNNING
 * ANYTHING, OR FAILED THEM FOR USING THE WRONG RUNNER.
 *
 * Three hardcoded Node facts, each with its own failure:
 *
 *   [ ! -f package.json ] && return 0      — on any non-Node codeline the gate reported SUCCESS
 *                                            for stories that explicitly declare unit tests,
 *                                            having executed nothing at all.
 *   npm install                            — the only way it knew to install dependencies.
 *   [ ! -f node_modules/.bin/vitest ] &&   — a Node project using jest, mocha or `node --test`
 *     return 1                               hard-failed with "vitest may not be in
 *                                            package.json": a message about the engine's
 *                                            expectation, not about the project.
 *
 * So the gate was simultaneously too permissive (silent pass off-stack) and too strict (hard fail
 * on-stack), and neither verdict was about the code under test. All three answers now come from
 * lib/ecosystem-registry.js, which already knew them for six ecosystems.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const ECO = join(SCRIPTS, 'lib/handlers/codeline-ecosystem.js');
const NODE = process.execPath;

function gateFn(): string {
  const src = readFileSync(ORCH, 'utf8');
  const i = src.indexOf('run_unit_tests_gate() {');
  expect(i, 'run_unit_tests_gate is gone').toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n}', i));
}
const code = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'unit-gate-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function facts(files: Record<string, string>): Record<string, string> {
  const dir = join(work, 'repo');
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const r = spawnSync(NODE, [ECO, dir], { encoding: 'utf8' });
  expect(r.status, `the ecosystem handler failed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

describe('the unit test gate runs the project’s tests', () => {
  it('names no runner, installer or manifest of its own', () => {
    const body = code(gateFn());
    for (const lit of ['node_modules/.bin/vitest', 'npm install', 'package.json']) {
      expect(body, `the gate still names ${lit} in its own code`).not.toContain(lit);
    }
  });

  it('a codeline that cannot run tests BLOCKS instead of returning success', () => {
    // The worst of the three: stories declaring unitTests:true were reported verified.
    const body = code(gateFn());
    expect(body, 'the gate still returns 0 when it cannot run the tests')
      .not.toMatch(/No package\.json at PROJECT_ROOT[\s\S]{0,120}return 0/);
    // ASSERT THE BRANCH, NOT ITS NEIGHBOURHOOD. Checking that `return 1` appears somewhere in the
    // following 500 characters survived a mutation that inserted `return 0` ahead of it — the
    // branch returned success and the assertion still passed. Read the block itself.
    const i = body.indexOf('if [ -z "$_ut_test_cmd" ]; then');
    expect(i, 'the test-command check is gone').toBeGreaterThan(-1);
    const branch = body.slice(i, body.indexOf('\n    fi', i));
    expect(branch, 'the no-test-command branch returns success').not.toMatch(/return 0/);
    expect(branch, 'a codeline with no test command is still treated as verified').toMatch(/return 1/);
  });

  it('resolves a runner for a Node project whatever it uses', () => {
    const withVitest = facts({ 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'vitest run' } }) });
    expect(withVitest.testCommand, 'a vitest project resolved no test command').toBeTruthy();

    const withJest = facts({ 'package.json': JSON.stringify({ name: 'b', scripts: { test: 'jest' } }) });
    expect(withJest.testCommand, 'a jest project — which used to hard-fail — resolved nothing')
      .toBeTruthy();
  });

  it('resolves a runner and an installer for ecosystems that used to pass silently', () => {
    const rust = facts({ 'Cargo.toml': '[package]\nname = "r"\n' });
    expect(rust.testCommand).toMatch(/cargo test/);
    expect(rust.installCommand).toMatch(/cargo/);

    const go = facts({ 'go.mod': 'module g\n' });
    expect(go.testCommand).toMatch(/go test/);

    const py = facts({ 'pyproject.toml': '[project]\nname="p"\n[tool.pytest.ini_options]\n' });
    expect(py.testCommand).toMatch(/pytest/);
  });

  it('every ecosystem can say how it installs', () => {
    const r = spawnSync(NODE, ['-e',
      'const {allManifests}=require(process.argv[1]);'
      + 'process.stdout.write(allManifests().filter(e=>typeof e.installCommand!=="function").map(e=>e.file).join(","))',
      join(SCRIPTS, 'lib/ecosystem-registry.js'),
    ], { encoding: 'utf8' });
    expect(r.stdout.trim(), 'an ecosystem cannot install, so its tests can never run').toBe('');
  });

  it('a project that declares nothing resolves nothing — the gate must not invent a command', () => {
    const bare = facts({ 'README.md': '# r\n' });
    expect(bare.testCommand, 'a command was invented for a repo that declares none').toBe('');
  });

  it('the install step only runs for an ecosystem that vendors in-repo', () => {
    // Rust and Go install to a global cache; creating/checking a vendored directory for them
    // would make the gate install on every run forever.
    expect(facts({ 'Cargo.toml': '[package]\nname="r"\n' }).installDir).toBeNull();
    const body = code(gateFn());
    expect(body, 'the install step no longer checks whether this ecosystem vendors anything')
      .toMatch(/-n "\$_ut_install_dir"/);
  });

  it('the failure messages name the command that actually ran', () => {
    const body = code(gateFn());
    expect(body, 'a timeout still blames npm').toMatch(/\$\{_ut_install_cmd\}' TIMED OUT/);
  });
});
