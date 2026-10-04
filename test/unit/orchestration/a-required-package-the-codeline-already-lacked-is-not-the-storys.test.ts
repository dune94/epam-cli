// A REQUIRED PACKAGE THE CODELINE ALREADY LACKED IS NOT THE STORY'S.
//
// AMSD-2974 live, 2026-10-03. metrolinx declares requiredDevDependencies [typescript, @types/node];
// cx-shared's package.json has never declared @types/node. The scan reported it on every attempt,
// failed the attempt, and told the writer "Your change imports package(s) that package.json does not
// declare ... Add each one to package.json with a version" — untrue: the change imported nothing new.
// The writer complied: @types/node ^18.19.130 landed in the client's package.json and lockfile,
// resolved from the registry.
//
// The scan judges the CHANGE, as every baseline comparison in the engine does: a required package
// absent from the manifest before the change is reported, not charged. One the change REMOVES is
// still charged — the check is not weakened, it is aimed.
//
// EXECUTED: the real run_dependency_check with the real scan plugin, on git fixtures.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSourceFile } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = engineSourceFile(join(ROOT, 'orchestrations/scripts/claude.sh'));
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A codeline whose project requires `required`; `before`/`after` are its declared devDependencies. */
function makeRepo(before: Record<string, string>, after: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'req-dep-')); made.push(repo);
  const g = (a: string[]) => spawnSync('git', ['-C', repo, ...a]);
  spawnSync('git', ['init', '-q', repo]); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  const pkg = (dev: Record<string, string>) => JSON.stringify({ name: 'f', dependencies: { react: '^18.0.0' }, devDependencies: dev }, null, 2);
  writeFileSync(join(repo, 'package.json'), pkg(before));
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam/dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json', manifestKeys: ['dependencies', 'devDependencies'],
    scanFileExtensions: ['.ts'], vendorDirs: ['node_modules'], ignorePackages: [],
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
    requiredDevDependencies: ['typescript', '@types/node'],
  }, null, 2));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/toast.ts'), 'export const t = 1;\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  // The story's change: a source edit, and whatever it does to the manifest.
  writeFileSync(join(repo, 'src/toast.ts'), 'export const t = 2;\n');
  writeFileSync(join(repo, 'package.json'), pkg(after));
  return repo;
}

function check(repo: string) {
  const script = `
set +e
error() { echo "ERROR $*" >&2; }
warning() { echo "WARN $*" >&2; }
log() { echo "LOG $*" >&2; }
info() { echo "INFO $*" >&2; }
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"
NODE_CMD="${process.execPath}"
DETERMINISTIC_CHECK_FAILURE=0; VERIFICATION_FAILURE=""; STORY_REJECTION_KEY=""
eval "$(awk '/^_project_dep_config_value\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
eval "$(awk '/^run_dependency_check\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
run_dependency_check "${repo}"
echo "RC=$?"; echo "FLAG=\${DETERMINISTIC_CHECK_FAILURE:-0}"; printf 'VF<<%s>>' "$VERIFICATION_FAILURE"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout || '';
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? -1),
    flag: Number((out.match(/FLAG=(\d+)/) || [])[1] ?? -1),
    vf: (out.match(/VF<<([\s\S]*)>>/) || [])[1] ?? '',
    stderr: r.stderr || '',
  };
}

describe('a required package the codeline already lacked is not the story\'s', () => {
  it('reported, not charged: the attempt passes and the writer is told nothing false', () => {
    const r = check(makeRepo({ typescript: '^5.0.0' }, { typescript: '^5.0.0' }));
    expect(r.stderr, `the scan never saw @types/node — this would prove nothing:\n${r.stderr}`).toMatch(/@types\/node/);
    expect(r.rc, r.stderr).toBe(0);
    expect(r.flag).toBe(0);
    expect(r.vf).not.toMatch(/@types\/node/);
  });

  it('a change that REMOVES a required package is still charged', () => {
    const r = check(makeRepo({ typescript: '^5.0.0', '@types/node': '^18.0.0' }, { typescript: '^5.0.0' }));
    expect(r.rc, r.stderr).toBe(1);
    expect(r.flag).toBe(1);
    expect(r.vf).toMatch(/@types\/node/);
  });
});
