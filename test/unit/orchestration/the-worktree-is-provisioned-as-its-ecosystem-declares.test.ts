/**
 * THE WORKTREE IS PROVISIONED AS ITS ECOSYSTEM DECLARES, AND THE TEST RUNS INSIDE IT.
 *
 * Run 20260915T101555Z, REGI-001-B (Python, requirements.txt): the verification worktree was
 * provisioned by taking the manifest's ADD command (`pip install {package}`), deleting
 * `{package}` and running what was left — `pip install`, which installs nothing — then `pytest`
 * ran bare, outside any interpreter, and exited 2. The failure analyst was asked twice to explain
 * an import error that was a missing environment; HealingBroken; $16 run stalled. The rule
 * "delete the placeholder and you have the provisioning command" is true of exactly one package
 * manager and was written into the engine (claude.sh, 2026-08-11).
 *
 * Now the manifest carries two facts the ecosystem plug-in declares — provisionCommand and
 * runEnvironment — and the engine runs the first verbatim when the vendor directory is absent
 * and the declared test command inside the second. Proven by EXECUTING run_external_verification
 * on a real worktree of each ecosystem, with stand-in tools on PATH that record what ran and
 * where: the environment's own runner must answer, not the host's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const CLAUDE_SH = engineSource(join(SCRIPTS, 'claude.sh'));
const dirs: string[] = [];
afterAll(() => { if (!process.env.KEEP_DIRS) for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fn(name: string): string {
  const lines = CLAUDE_SH.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`unterminated ${name}`);
}

/** A stand-in tool that records its argv and cwd, then behaves as `body` says. */
function tool(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $* @$PWD" >> "$RECORD"\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** The codeline's manifest, as lib/handlers/codeline-manifests.js derives it from its plug-in. */
function writeManifests(codeline: string) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/codeline-manifests.js'), codeline], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout);
  mkdirSync(join(codeline, '.epam'), { recursive: true });
  for (const [f, v] of Object.entries(out)) writeFileSync(join(codeline, '.epam', f), JSON.stringify(v, null, 2));
  return out['dependency-check.json'];
}

function run(codeline: string, hostBin: string, record: string, testCommand: string) {
  const prd = { stories: [{ id: 'S-1', technicalNotes: { files: ['x'], testCommand } }] };
  const prdFile = join(codeline, '..', 'prd.json'); writeFileSync(prdFile, JSON.stringify(prd));
  const harness = [
    '#!/usr/bin/env bash',
    `SCRIPT_DIR="${SCRIPTS}"`, 'AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"', `PROJECT_ROOT="${codeline}"`, `PRD_FILE="${prdFile}"`,
    'log() { echo "LOG: $*" >&2; }', 'warning() { echo "WARN: $*" >&2; }', 'error() { echo "ERROR: $*" >&2; }', 'success() { echo "OK: $*" >&2; }',
    'is_truthy() { case "${1:-}" in 1|true|yes) return 0;; *) return 1;; esac; }',
    'evidence_window() { echo 40; }',
    'run_vendor_integrity_check() { return 0; }', '_vendor_unlock() { :; }', 'run_dynamic_tools_in_unlocked_window() { :; }',
    'run_dependency_check() { :; }', 'run_lockfile_sync_check() { :; }', 'run_relative_import_check() { return 0; }',
    'run_named_import_check() { return 0; }', 'run_anti_pattern_check() { return 0; }', 'run_mock_completeness_check() { return 0; }',
    '_project_repo_has_tests() { echo "true"; }', '_project_test_command() { :; }', '_project_owned_test_files() { :; }',
    '_project_scoped_test_command() { :; }', '_bounded_test_command() { printf "%s" "${1:-}"; }',
    '_orch_env_unset_prefix=""',
    fn('_project_dep_config_value'), fn('_get_vendor_dirs'),
    ...['_project_manifest_file', '_project_install_command', '_project_provision_command', '_project_run_env_prefix']
      .map((n) => { try { return fn(n); } catch { return `${n}() { :; }`; } }),
    fn('run_external_verification'),
    'run_external_verification S-1 /dev/null; echo "RC=$?"',
  ].join('\n');
  const h = join(codeline, '..', 'harness.sh'); writeFileSync(h, harness);
  return spawnSync('bash', [h], { encoding: 'utf8', env: { ...process.env, PATH: `${hostBin}:${process.env.PATH}`, RECORD: record } });
}

describe('the worktree is provisioned as its ecosystem declares, and the test runs inside it', () => {
  it('requirements.txt: the environment is created, the manifest installed, and pytest is the environment\'s own', () => {
    const ws = mkdtempSync(join(tmpdir(), 'prov-py-')); dirs.push(ws);
    const codeline = join(ws, 'wt'); mkdirSync(codeline);
    const record = join(ws, 'record.txt'); writeFileSync(record, '');
    writeFileSync(join(codeline, 'requirements.txt'), 'pytest\n');
    mkdirSync(join(codeline, 'tests')); writeFileSync(join(codeline, 'tests', 'test_x.py'), 'def test_x(): pass\n');
    const manifest = writeManifests(codeline);
    expect(manifest.provisionCommand, 'the plug-in must declare how the environment is provisioned').toBeTruthy();
    expect(manifest.runEnvironment, 'the plug-in must declare where commands run').toBeTruthy();
    // The HOST's python3 stands in: `python3 -m venv .venv` creates the environment with its own
    // pip and its own pytest, each recording that it ran. A host pytest exists too — the wrong one.
    const host = join(ws, 'hostbin');
    tool(host, 'python3', [
      'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin";',
      `  printf '#!/usr/bin/env bash\\necho "venv-pip $* @$PWD" >> "$RECORD"\\n' > "$3/bin/pip"; chmod +x "$3/bin/pip";`,
      `  printf '#!/usr/bin/env bash\\necho "venv-pytest $* @$PWD" >> "$RECORD"\\n' > "$3/bin/pytest"; chmod +x "$3/bin/pytest";`,
      'fi',
    ].join('\n'));
    tool(host, 'pip', 'exit 0');
    tool(host, 'pytest', 'echo "host pytest ran — the wrong one"; exit 2');
    const r = run(codeline, host, record, 'pytest tests/test_x.py');
    const rec = engineSource(record);
    expect(rec, 'the declared provisioning command must run verbatim').toContain('python3 -m venv .venv');
    expect(rec).toContain('venv-pip install -r requirements.txt');
    expect(rec, 'the ADD command with its placeholder deleted must never run as provisioning').not.toMatch(/^pip install\s*@/m);
    expect(rec, 'the test must run with the environment\'s pytest, not the host\'s').toContain('venv-pytest tests/test_x.py');
    expect(rec).not.toContain('host pytest');
    expect(r.stdout + r.stderr).toMatch(/RC=0/);
  });

  it('package.json: the declared install runs verbatim and the vendored runner answers', () => {
    const ws = mkdtempSync(join(tmpdir(), 'prov-node-')); dirs.push(ws);
    const codeline = join(ws, 'wt'); mkdirSync(codeline);
    const record = join(ws, 'record.txt'); writeFileSync(record, '');
    writeFileSync(join(codeline, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
    const manifest = writeManifests(codeline);
    expect(manifest.provisionCommand).toBeTruthy();
    const host = join(ws, 'hostbin');
    tool(host, 'npm', [
      'if [ "$1" = "install" ]; then mkdir -p node_modules/.bin;',
      `  printf '#!/usr/bin/env bash\\necho "vendored-vitest $* @$PWD" >> "$RECORD"\\n' > node_modules/.bin/vitest; chmod +x node_modules/.bin/vitest;`,
      'fi',
      'if [ "$1" = "run" ]; then shift; shift; vitest run "$@"; fi',
    ].join('\n'));
    tool(host, 'vitest', 'echo "host vitest ran — the wrong one"; exit 1');
    const r = run(codeline, host, record, 'npm run test');
    const rec = engineSource(record);
    expect(rec).toMatch(/^npm install --no-audit --no-fund @/m);
    expect(rec).toContain('vendored-vitest run');
    expect(rec).not.toContain('host vitest');
    expect(r.stdout + r.stderr).toMatch(/RC=0/);
  });

  it('a codeline whose manifest declares no provisionCommand is told so and left alone — never guessed at', () => {
    const ws = mkdtempSync(join(tmpdir(), 'prov-none-')); dirs.push(ws);
    const codeline = join(ws, 'wt'); mkdirSync(join(codeline, '.epam'), { recursive: true });
    const record = join(ws, 'record.txt'); writeFileSync(record, '');
    writeFileSync(join(codeline, 'deps.lock'), '');
    writeFileSync(join(codeline, '.epam', 'dependency-check.json'), JSON.stringify({ manifestFile: 'deps.lock', vendorDirs: ['vendor'], installCommand: 'tool add {package}' }));
    const host = join(ws, 'hostbin');
    tool(host, 'tool', 'exit 0'); tool(host, 'check', 'exit 0');
    const r = run(codeline, host, record, 'check');
    expect(engineSource(record), 'nothing derived from the add command may run').not.toMatch(/^tool /m);
    expect(r.stderr).toMatch(/declares no provisionCommand/);
    expect(r.stdout + r.stderr).toMatch(/RC=0/);
  });
});
