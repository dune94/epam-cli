/**
 * AN ESCALATION STARTS FROM THE ESCALATING STORY'S TREE, AND BRINGS BACK ONLY THE OWNER'S FIX.
 *
 * Found by the £0 escalation-chain scenario (orchestrations/projects/escalation-chain, 2026-09-24),
 * which reproduces the live regintel chain for nothing:
 *
 *   D1  ESC-003 changes greet.py (uncommitted) and ESC-002's test fails. ESC-002's escalation
 *       worktree was branched from HEAD — WITHOUT ESC-003's change — so its suite was green and it
 *       "converged" having fixed nothing. Live, REGI-007 spent 30 minutes on a tree missing its
 *       parent's fix. The owner must start from the tree that exposed the defect.
 *   D2  "brought 1981 file(s) of ESC-002's converged fix into the codeline": `git add -A` in the
 *       worktree swept in .venv, __pycache__ and the engine's own state, all copied over the
 *       codeline. Only what the OWNER changed crosses back.
 *   D3  the repeat-escalation ledger was written before the escalation ran, so a repeat was always
 *       reported "did not converge" — even of a fix the log had just called resolved.
 *
 * Real functions, real git repositories. Nothing about the naming rule, the engine's directories
 * or the vendor directories is restated here: they come from the engine and the codeline's own
 * dependency-check.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const LADDER = join(LIB, 'model-ladder.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function codeline() {
  const dir = mkdtempSync(join(tmpdir(), 'esc-base-')); dirs.push(dir);
  const repo = join(dir, 'app');
  mkdirSync(join(repo, 'src/esc'), { recursive: true }); mkdirSync(join(repo, 'tests'), { recursive: true });
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam/dependency-check.json'), JSON.stringify({ vendorDirs: ['.venv', '__pycache__'] }));
  writeFileSync(join(repo, 'src/esc/greet.py'), 'def greet(n):\n    return "hello " + n.strip().lower()\n');
  writeFileSync(join(repo, 'src/esc/normalize.py'), 'def normalize(n):\n    return n.strip()\n');
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', 'src'); git('commit', '-qm', 'ESC-001');
  // THE ESCALATING STORY'S UNCOMMITTED WORK, as it stands when its analyst escalates:
  writeFileSync(join(repo, 'src/esc/greet.py'), 'from esc.normalize import normalize\ndef greet(n):\n    return "hello " + normalize(n)\n');
  writeFileSync(join(repo, 'tests/test_greet.py'), 'def test_x():\n    pass\n');
  // ...and what the environment and the engine leave lying around:
  mkdirSync(join(repo, '.venv/lib'), { recursive: true }); writeFileSync(join(repo, '.venv/lib/site.py'), 'x = 1\n');
  mkdirSync(join(repo, 'src/esc/__pycache__'), { recursive: true }); writeFileSync(join(repo, 'src/esc/__pycache__/greet.cpython-312.pyc'), 'bin');
  writeFileSync(join(repo, '.epam/run-state.json'), '{}');
  return { dir, repo, git };
}

const FNS = ['_escalation_vendor_names', '_escalation_owned_paths', '_escalation_base_snapshot', '_escalation_branch', '_escalation_worktree', '_escalation_adopt_work', '_escalation_adopt_owned_status']
  .map((n) => shellFunction(LADDER, n)).join('\n');

function sh(repo: string, script: string) {
  const r = spawnSync('bash', ['-c', `set -u
log(){ printf 'LOG %s\\n' "$*"; }; warning(){ printf 'WARN %s\\n' "$*" >&2; }
. ${JSON.stringify(join(LIB, 'engine-paths.sh'))}
PROJECT_ROOT=${JSON.stringify(repo)}
${FNS}
${script}`], { encoding: 'utf8' });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

describe('D1: the owner starts from the tree that exposed the defect', () => {
  it('the snapshot holds the escalating story\'s uncommitted change and its new file', () => {
    const { repo } = codeline();
    const r = sh(repo, `b=$(_escalation_base_snapshot); echo "BASE=$b"; git -C "$PROJECT_ROOT" show "$b:src/esc/greet.py"; git -C "$PROJECT_ROOT" ls-tree -r --name-only "$b"`);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('return "hello " + normalize(n)');
    expect(r.out).toContain('tests/test_greet.py');
  });

  it('...and none of the environment\'s or the engine\'s files', () => {
    const { repo } = codeline();
    const r = sh(repo, `b=$(_escalation_base_snapshot); git -C "$PROJECT_ROOT" ls-tree -r --name-only "$b"`);
    expect(r.out).not.toMatch(/\.venv\//);
    expect(r.out).not.toMatch(/__pycache__/);
    expect(r.out).not.toMatch(/\.epam\//);
  });

  it('taking the snapshot changes nothing in the escalating story\'s tree — not its index, not its files', () => {
    const { repo, git } = codeline();
    const before = git('status', '--porcelain').stdout;
    const head = git('rev-parse', 'HEAD').stdout;
    sh(repo, '_escalation_base_snapshot >/dev/null');
    expect(git('status', '--porcelain').stdout).toBe(before);
    expect(git('rev-parse', 'HEAD').stdout).toBe(head);
  });

  it('the owner\'s worktree is created AT that snapshot — its greet.py is the escalating story\'s', () => {
    const { repo } = codeline();
    const r = sh(repo, `b=$(_escalation_base_snapshot); wt=$(_escalation_worktree ESC-002 "$b"); cat "$wt/src/esc/greet.py"`);
    expect(r.out, r.err).toContain('normalize(n)');
  });
});

describe('D2: only what the owner changed crosses back', () => {
  // £0 escalation-chain run 6: "brought 126 file(s)" for a one-file fix. A NESTED escalation's tree is
  // the parent's worktree, which carries no .epam/ — so the vendor list read from the tree was empty
  // and .venv crossed back. The project's own declaration is where that file comes from.
  it('a tree with no .epam of its own still excludes the vendor directories the PROJECT declares', () => {
    const { dir, repo } = codeline();
    rmSync(join(repo, '.epam'), { recursive: true, force: true });
    const proj = join(dir, 'project'); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'dependency-check.json'), JSON.stringify({ vendorDirs: ['.venv', '__pycache__'] }));
    const r = sh(repo, `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(proj)}; b=$(_escalation_base_snapshot); git -C "$PROJECT_ROOT" ls-tree -r --name-only "$b"`);
    expect(r.out, r.err).toContain('tests/test_greet.py');
    expect(r.out).not.toMatch(/\.venv\//);
    expect(r.out).not.toMatch(/__pycache__/);
  });

  it('one file changed by the owner is the one file adopted — no .venv, no __pycache__, no engine state', () => {
    const { repo } = codeline();
    const r = sh(repo, `b=$(_escalation_base_snapshot); wt=$(_escalation_worktree ESC-001 "$b")
printf 'def normalize(n):\\n    return n.strip().lower()\\n' > "$wt/src/esc/normalize.py"
mkdir -p "$wt/.venv/lib" "$wt/src/esc/__pycache__" "$wt/.epam"; echo y > "$wt/.venv/lib/other.py"; echo b > "$wt/src/esc/__pycache__/n.pyc"; echo '{}' > "$wt/.epam/x.json"
_escalation_adopt_work ESC-001 "$wt" "$b"`);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/brought 1 file\(s\)/);
    expect(readFileSync(join(repo, 'src/esc/normalize.py'), 'utf8')).toContain('.lower()');
    expect(existsSync(join(repo, '.venv/lib/other.py')), '.venv was copied into the codeline').toBe(false);
  });

  it('the escalating story\'s own uncommitted change is untouched by the adoption', () => {
    const { repo } = codeline();
    sh(repo, `b=$(_escalation_base_snapshot); wt=$(_escalation_worktree ESC-001 "$b")
printf 'def normalize(n):\\n    return n.strip().lower()\\n' > "$wt/src/esc/normalize.py"
_escalation_adopt_work ESC-001 "$wt" "$b"`);
    expect(readFileSync(join(repo, 'src/esc/greet.py'), 'utf8')).toContain('normalize(n)');
    expect(existsSync(join(repo, 'tests/test_greet.py'))).toBe(true);
  });

  it('a file the owner DELETED is deleted in the codeline too', () => {
    const { repo } = codeline();
    const r = sh(repo, `b=$(_escalation_base_snapshot); wt=$(_escalation_worktree ESC-001 "$b")
rm "$wt/tests/test_greet.py"
_escalation_adopt_work ESC-001 "$wt" "$b"`);
    expect(r.status, r.err).toBe(0);
    expect(existsSync(join(repo, 'tests/test_greet.py'))).toBe(false);
  });
});
