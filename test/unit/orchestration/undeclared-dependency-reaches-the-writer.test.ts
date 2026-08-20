// THE UNDECLARED DEPENDENCY WAS DETECTED SIX TIMES AND THE WRITER WAS NEVER TOLD.
//
// Live metrolinx AMSD-2041, 2026-08-18. The writer imported @contentstack/live-preview-utils in
// src/pages/_app.tsx without adding it to package.json. The package was present in node_modules
// from a previous run, so the import RESOLVED: tsc passed, tests would pass, and the branch would
// be broken for anyone running a clean npm ci. The scan caught it on every one of six attempts:
//
//   [dependency-scan] imported but NOT DECLARED (present in a vendor dir only):
//     @contentstack/live-preview-utils   src/pages/_app.tsx
//
// and package.json was never touched, because run_dependency_check only calls `warning`. It sets
// no DETERMINISTIC_CHECK_FAILURE, no VERIFICATION_FAILURE and no STORY_REJECTION_KEY, and returns
// 0. Per the contract documented at the prescribed-helper check, that means the finding reaches
// the terminal and nothing else — not the retry prompt, and not the ladder's repeat detector.
//
// This is the same defect as repo-lint (fixed 2b4f67e) and the 2026-08-09 incident the code
// already documents. installed_undeclared is deterministic — the specifier is either in the
// manifest or it is not — so it belongs in that class.
//
// These tests run the REAL run_dependency_check with the REAL scan plugin against a repo that
// genuinely has a package installed-but-undeclared and imported by a changed file.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const made: string[] = [];

/** A repo where `pkg` is in node_modules, absent from package.json, and imported by a CHANGED file. */
function makeRepo(opts: { declare: boolean }): string {
  const repo = mkdtempSync(join(tmpdir(), 'dep-scan-'));
  made.push(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);
  const deps: Record<string, string> = { react: '^18.0.0' };
  if (opts.declare) deps['@scope/vendored-only'] = '^1.0.0';
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }, null, 2));
  // Installed in a vendor dir — this is what makes the import resolve and the failure invisible.
  mkdirSync(join(repo, 'node_modules/@scope/vendored-only'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/@scope/vendored-only/package.json'),
    JSON.stringify({ name: '@scope/vendored-only', version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(repo, 'node_modules/@scope/vendored-only/index.js'), 'module.exports = {};\n');
  // The project's own dependency declaration — the scan refuses to run without one, by design
  // ("an absent declaration is not 'no problems found'"). Shape copied from a real codeline.
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam/dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json',
    manifestKeys: ['dependencies', 'devDependencies'],
    scanFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
    vendorDirs: ['node_modules'],
    ignorePackages: ['fs', 'path', 'os'],
  }, null, 2));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.ts'), 'export const a = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  // THIS story's change introduces the import.
  writeFileSync(join(repo, 'src/app.ts'), 'import x from "@scope/vendored-only";\nexport const a = x;\n');
  return repo;
}

/** Execute the REAL run_dependency_check and report the three delivery conditions. */
function runDependencyCheck(repo: string) {
  const script = `
set +e
error() { echo "ERROR $*" >&2; }
warning() { echo "WARN $*" >&2; }
log() { echo "LOG $*" >&2; }
info() { echo "INFO $*" >&2; }
is_truthy() { case "\${1:-}" in 1|true|TRUE|yes) return 0 ;; *) return 1 ;; esac; }
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"
NODE_CMD="${NODE}"
DETERMINISTIC_CHECK_FAILURE=0
VERIFICATION_FAILURE=""
STORY_REJECTION_KEY=""
# The project declares nothing, so no autoInstall path can mask the finding.
_project_dep_config_value() { echo ""; }
_project_install_command() { echo ""; }

eval "$(awk '/^run_dependency_check\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"

run_dependency_check "${repo}"
_rc=$?
echo "RC=$_rc"
echo "FLAG=\${DETERMINISTIC_CHECK_FAILURE:-0}"
echo "KEY=\${STORY_REJECTION_KEY:-}"
echo "VF_LEN=\${#VERIFICATION_FAILURE}"
printf 'VF<<%s>>' "$VERIFICATION_FAILURE"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout || '';
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? -1),
    flag: Number((out.match(/FLAG=(\d+)/) || [])[1] ?? -1),
    key: (out.match(/KEY=(.*)/) || [])[1] ?? '',
    vfLen: Number((out.match(/VF_LEN=(\d+)/) || [])[1] ?? 0),
    vf: (out.match(/VF<<([\s\S]*)>>/) || [])[1] ?? '',
    stderr: r.stderr || '',
  };
}

describe('an installed-but-undeclared import reaches the next attempt', () => {
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

  it('the scan actually detected it — otherwise every assertion below is vacuous', () => {
    const r = runDependencyCheck(makeRepo({ declare: false }));
    expect(r.stderr, `scan did not report the undeclared import; stderr: ${r.stderr}`)
      .toMatch(/NOT DECLARED[\s\S]*@scope\/vendored-only/);
  });

  it('THE DEFECT: it FAILS the attempt instead of only warning', () => {
    const r = runDependencyCheck(makeRepo({ declare: false }));
    expect(r.rc, 'returned 0 — the attempt proceeds and the branch ships undeliverable').toBe(1);
  });

  it('THE DEFECT: it sets DETERMINISTIC_CHECK_FAILURE, so the finding is DELIVERED', () => {
    const r = runDependencyCheck(makeRepo({ declare: false }));
    expect(r.flag, 'finding is assigned and dropped — the writer is never told').toBe(1);
  });

  it('the feedback names the package AND the manifest the writer must edit', () => {
    const r = runDependencyCheck(makeRepo({ declare: false }));
    expect(r.vfLen, 'VERIFICATION_FAILURE is empty').toBeGreaterThan(0);
    expect(r.vf, 'the package to declare is not named').toContain('@scope/vendored-only');
    expect(r.vf, 'the writer is not told WHERE to declare it').toMatch(/package\.json|manifest/i);
  });

  it('sets a rejection key naming the package, so a repeat escalates', () => {
    const r = runDependencyCheck(makeRepo({ declare: false }));
    expect(r.key).toMatch(/^dependency:/);
    expect(r.key, 'key carries no package — every undeclared import would collide')
      .toContain('@scope/vendored-only');
  });

  it('a DECLARED dependency passes — the gate does not fire on correct work', () => {
    const r = runDependencyCheck(makeRepo({ declare: true }));
    expect(r.rc, 'a correctly declared dependency failed the story').toBe(0);
    expect(r.flag, 'a clean scan set the failure flag').toBe(0);
  });
});
