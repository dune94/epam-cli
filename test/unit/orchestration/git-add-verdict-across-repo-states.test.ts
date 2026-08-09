/**
 * WHAT git_add_client_outputs DECIDES, ACROSS EVERY STATE A CLIENT REPO IS ACTUALLY IN.
 *
 * Live 2026-08-09, gotransit, third run: `git add failed (exit 1)`, story demoted, phase
 * aborted, HALT. No other diagnosis existed. I built two one-off fixtures for the causes I
 * thought likely, both returned 0, and I relaunched hoping the run would tell me. It was the
 * wrong instinct — the state space here is small and enumerable, and sweeping it found the bug
 * in one pass:
 *
 *     node_modules + .epam, NO client work   ->  rc=1  staged=0  pending=1     <-- the live signature
 *
 * MECHANISM. A gitignored top-level node_modules makes `git add` exit 1 merely for the ignored
 * path being named. Nothing stages, because there is no client work. `_pending` is then measured
 * with a bare `git status --porcelain`, which counts `.epam/` — engine state the staging step
 * DELIBERATELY excludes. So the function concludes "there was work to stage and nothing staged"
 * and reports failure, when the only pending path was one it never intended to stage.
 *
 * The exit-code-vs-index rule was right; its second half asked the wrong question. "Is anything
 * pending?" must mean "is anything pending THAT WE WOULD STAGE" — the same exclusions, or the
 * answer does not match the action.
 *
 * Every case below runs the real function against a real git repository. The table is the point:
 * a verdict function with one true branch and one false branch needs its states enumerated, not
 * sampled.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { chmodSync(join(d, 'src'), 0o755); } catch { /* not every fixture has one */ }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A repo shaped like next.gotransit.com: gitignored node_modules and .next, one tracked source. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitstate-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '/node_modules\n.next\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return dir;
}

const nodeModules = (d: string) => {
  mkdirSync(join(d, 'node_modules', 'p'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'p', 'i.js'), 'module.exports=1\n');
};
const engineArtefacts = (d: string) => {
  mkdirSync(join(d, '.epam'), { recursive: true });
  writeFileSync(join(d, '.epam', 'settings.json'), '{}\n');
  writeFileSync(join(d, '.epam', 'codeline-facts.json'), '{}\n');
};
const clientWork = (d: string) => writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 2;\n');

function addOutputs(dir: string) {
  const res = execFileSync('bash', ['-c',
    `. ${JSON.stringify(LIB)} >/dev/null 2>&1
     git_add_client_outputs ${JSON.stringify(dir)} 2>&1; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  // A deliberately corrupt index makes git itself fail here — that is the fixture working, not
  // a problem to propagate. "Could not be read" is reported as no staged paths.
  let staged: string[] = [];
  try {
    staged = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch { staged = []; }
  return { rc: Number((res.match(/RC=(\d+)/) || [])[1]), out: res, staged };
}

describe('THE DEFECT: the live failure signature', () => {
  it('a gitignored node_modules beside engine artefacts, with no client work, is not a failure', () => {
    // Reproduces gotransit exactly: git add exits 1 for naming the ignored path, nothing stages
    // because there IS no client work, and .epam/ is the only thing "pending".
    const d = repo(); nodeModules(d); engineArtefacts(d);
    const { rc } = addOutputs(d);
    expect(
      rc,
      'the story is demoted as undelivered and the phase HALTs, over a repo that had nothing to commit',
    ).toBe(0);
  });

  it('engine artefacts alone are not "work that failed to stage"', () => {
    const d = repo(); engineArtefacts(d);
    expect(addOutputs(d).rc).toBe(0);
  });

  it('build output alone is not either', () => {
    const d = repo();
    mkdirSync(join(d, '.next'), { recursive: true });
    writeFileSync(join(d, '.next', 'out'), 'x\n');
    nodeModules(d);
    expect(addOutputs(d).rc).toBe(0);
  });

  it('no FAILED line is logged when the call succeeds', () => {
    // A "FAILED ... (exit 0)" line in the run log is its own defect: it sends the next
    // investigation after a failure that did not happen.
    const d = repo(); engineArtefacts(d);
    const { out } = addOutputs(d);
    expect(out, 'a success path logged FAILED').not.toMatch(/FAILED/);
  });
});

describe('real client work is still staged, and still required', () => {
  it('client work stages even with node_modules and engine artefacts present', () => {
    const d = repo(); nodeModules(d); engineArtefacts(d); clientWork(d);
    const { rc, staged } = addOutputs(d);
    expect(rc).toBe(0);
    expect(staged).toEqual(['src/a.ts']);
  });

  it('engine artefacts are never staged', () => {
    const d = repo(); engineArtefacts(d); clientWork(d);
    expect(addOutputs(d).staged.some((p) => p.startsWith('.epam'))).toBe(false);
  });

  it('node_modules is never staged', () => {
    const d = repo(); nodeModules(d); clientWork(d);
    expect(addOutputs(d).staged.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('a repo that genuinely cannot stage still fails', () => {
    // The verdict must not become permissive: real breakage stays a failure.
    const d = repo(); clientWork(d);
    writeFileSync(join(d, '.git', 'index'), 'not an index');
    const { rc, out } = addOutputs(d);
    expect(rc).not.toBe(0);
    expect(out, 'the failure is reported without saying why').toMatch(/index file/i);
  });

  it('a stale index.lock fails and says so', () => {
    const d = repo(); clientWork(d);
    writeFileSync(join(d, '.git', 'index.lock'), '');
    const { rc, out } = addOutputs(d);
    expect(rc).not.toBe(0);
    expect(out).toMatch(/index\.lock|Unable to create/i);
  });
});

describe('the ordinary states all behave', () => {
  const cases: Array<[string, (d: string) => void, number]> = [
    ['clean tree', () => {}, 0],
    ['modified tracked file', (d) => clientWork(d), 1],
    ['new untracked file', (d) => writeFileSync(join(d, 'src', 'n.ts'), 'export const n = 1;\n'), 1],
    ['deleted file', (d) => unlinkSync(join(d, 'src', 'a.ts')), 1],
    ['renamed file', (d) => renameSync(join(d, 'src', 'a.ts'), join(d, 'src', 'b.ts')), 1],
    ['filename with a space', (d) => writeFileSync(join(d, 'src', 'a b.ts'), 'x\n'), 1],
    ['broken symlink', (d) => symlinkSync('/nonexistent', join(d, 'src', 'link')), 1],
    ['read-only file (write perimeter)', (d) => { clientWork(d); chmodSync(join(d, 'src', 'a.ts'), 0o444); }, 1],
    ['already fully staged', (d) => { clientWork(d); execFileSync('git', ['-C', d, 'add', '-A']); }, 1],
  ];

  for (const [name, setup, expectedStaged] of cases) {
    it(`${name}: succeeds, stages ${expectedStaged}`, () => {
      const d = repo(); setup(d);
      const { rc, staged } = addOutputs(d);
      expect(rc, `${name} reported failure`).toBe(0);
      expect(staged.length, `${name} staged the wrong number of paths`).toBe(expectedStaged);
    });
  }

  it('an empty directory is not stageable and not a failure', () => {
    const d = repo();
    mkdirSync(join(d, 'src', 'empty'), { recursive: true });
    expect(addOutputs(d).rc).toBe(0);
  });

  it('a repo with no commits yet still stages', () => {
    const d = mkdtempSync(join(tmpdir(), 'nohead-')); dirs.push(d);
    execFileSync('git', ['-C', d, 'init', '-q']);
    execFileSync('git', ['-C', d, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', d, 'config', 'user.name', 't']);
    writeFileSync(join(d, 'f.ts'), 'export const f = 1;\n');
    const { rc, staged } = addOutputs(d);
    expect(rc).toBe(0);
    expect(staged).toEqual(['f.ts']);
  });
});
