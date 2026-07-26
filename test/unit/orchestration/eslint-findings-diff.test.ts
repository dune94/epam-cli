/**
 * eslint_findings_diff.py — "which of these lint findings are OURS?"
 *
 * The Step 20 lint gate used to lint the whole tree and fail on any finding.
 * That is only survivable on a codeline with zero pre-existing lint debt
 * (metrolinx happened to be one: 939 files, 2 with problems, both written by
 * our own agents this run). On any codeline with inherited debt the gate fails
 * on a file no agent touched, the gate-finding-analyst cannot map it to a
 * story, and the run dies over someone else's formatting.
 *
 * The fix mirrors lib/tsc-baseline-gate.sh, which already solved exactly this
 * for tsc: compute the findings at the phase baseline, and report only the
 * excess. This helper is the set-subtraction half of that.
 *
 * Keying is deliberately (file, ruleId, message) with COUNTS rather than
 * (file, line, column): our own edit shifts every line below it, so a
 * position-keyed subtraction would re-report untouched inherited findings as
 * new. Counting keeps the one case that matters — introducing a SECOND
 * instance of a violation the file already had — from being masked.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

const REPO_ROOT = join(__dirname, '../../../');
const HELPER = join(REPO_ROOT, 'orchestrations/scripts/lib/eslint_findings_diff.py');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Msg = { ruleId: string; message: string; line?: number; column?: number; severity?: number };

/** ESLint's real `-f json` shape. */
function eslintJson(root: string, files: Record<string, Msg[]>): string {
  return JSON.stringify(
    Object.entries(files).map(([rel, messages]) => ({
      filePath: join(root, rel),
      messages: messages.map((m, i) => ({
        ruleId: m.ruleId,
        message: m.message,
        line: m.line ?? i + 1,
        column: m.column ?? 1,
        severity: m.severity ?? 2,
      })),
      errorCount: messages.filter(m => (m.severity ?? 2) === 2).length,
      warningCount: messages.filter(m => (m.severity ?? 2) === 1).length,
    })),
  );
}

function run(mode: string, baseline: string | null, current: string | null, root: string) {
  const dir = mkdtempSync(join(tmpdir(), 'eslint-diff-'));
  cleanupDirs.push(dir);
  const args = [HELPER, mode];
  if (baseline === null) {
    args.push('-');
  } else {
    const p = join(dir, 'baseline.json');
    writeFileSync(p, baseline);
    args.push(p);
  }
  if (current !== null) {
    const p = join(dir, 'current.json');
    writeFileSync(p, current);
    args.push(p);
  }
  args.push(root);
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 20000 });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const ROOT = '/project';

describe('diff: only findings this run introduced are reported', () => {
  it('suppresses a finding that already existed at baseline in an untouched file', () => {
    const legacy: Record<string, Msg[]> = {
      'src/legacy.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `;`' }],
    };
    const { status, stdout } = run('diff', eslintJson(ROOT, legacy), eslintJson(ROOT, legacy), ROOT);

    expect(status, 'inherited lint debt failed the gate — this is the whole defect').toBe(0);
    expect(stdout).toMatch(/NEW_FINDINGS=0/);
  });

  it('suppresses inherited findings in a file we DID change', () => {
    // The file we edit may already be dirty. Blaming us for the rest of it is
    // what would push a writer into reformatting code the ticket never mentioned.
    const baseline = eslintJson(ROOT, {
      'src/touched.ts': [{ ruleId: 'sonarjs/no-duplicate-string', message: 'Define a constant', line: 10 }],
    });
    const current = eslintJson(ROOT, {
      // same finding, moved down by our insertion
      'src/touched.ts': [{ ruleId: 'sonarjs/no-duplicate-string', message: 'Define a constant', line: 34 }],
    });
    const { status, stdout } = run('diff', baseline, current, ROOT);

    expect(status,
      'a pre-existing finding was re-reported as new because our edit shifted its line number')
      .toBe(0);
    expect(stdout).toMatch(/NEW_FINDINGS=0/);
  });

  it('reports a finding we introduced', () => {
    const baseline = eslintJson(ROOT, {});
    const current = eslintJson(ROOT, {
      'src/mine.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `⏎`', line: 122 }],
    });
    const { status, stdout } = run('diff', baseline, current, ROOT);

    expect(status, 'a finding we introduced did not fail the gate').toBe(1);
    expect(stdout).toMatch(/NEW_FINDINGS=1/);
    expect(stdout, 'the finding is not actionable — no file/line/rule').toMatch(/src\/mine\.ts.*122.*prettier\/prettier|prettier\/prettier[\s\S]*src\/mine\.ts/);
  });

  it('reports a SECOND instance of a rule the file already violated once', () => {
    const dup = { ruleId: 'sonarjs/no-duplicate-string', message: 'Define a constant' };
    const baseline = eslintJson(ROOT, { 'src/touched.ts': [{ ...dup, line: 5 }] });
    const current = eslintJson(ROOT, {
      'src/touched.ts': [{ ...dup, line: 5 }, { ...dup, line: 40 }],
    });
    const { status, stdout } = run('diff', baseline, current, ROOT);

    expect(status,
      'counting is not happening — adding another instance of an existing violation is invisible')
      .toBe(1);
    expect(stdout).toMatch(/NEW_FINDINGS=1/);
  });

  it('treats every finding in a brand-new file as ours', () => {
    const { status, stdout } = run(
      'diff',
      eslintJson(ROOT, {}),
      eslintJson(ROOT, { 'src/new.spec.ts': [{ ruleId: 'prettier/prettier', message: 'a' }, { ruleId: 'x/y', message: 'b' }] }),
      ROOT,
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/NEW_FINDINGS=2/);
  });

  it('does not fail when we REMOVED a pre-existing finding', () => {
    const baseline = eslintJson(ROOT, {
      'src/touched.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `;`' }],
    });
    const { status, stdout } = run('diff', baseline, eslintJson(ROOT, {}), ROOT);
    expect(status, 'cleaning up existing debt was punished').toBe(0);
    expect(stdout).toMatch(/NEW_FINDINGS=0/);
  });

  it('greenfield: with no baseline at all, every finding is ours', () => {
    // A scaffolded project has no phase baseline to compare against. Suppressing
    // findings there would silently disable the gate on exactly the codebase the
    // pipeline wrote from scratch.
    const { status, stdout } = run(
      'diff',
      null,
      eslintJson(ROOT, { 'src/app.ts': [{ ruleId: 'prettier/prettier', message: 'a' }] }),
      ROOT,
    );
    expect(status, 'greenfield lint findings were suppressed as "pre-existing"').toBe(1);
    expect(stdout).toMatch(/NEW_FINDINGS=1/);
  });

  it('matches files by repo-relative path, not by absolute path', () => {
    // Baseline findings are produced inside a temporary git worktree, so the
    // absolute prefix differs from the live tree by construction.
    const baseline = eslintJson('/tmp/wt-abc123', {
      'src/touched.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `;`' }],
    });
    const current = eslintJson(ROOT, {
      'src/touched.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `;`' }],
    });
    const { status, stdout } = run('diff', baseline, current, ROOT);

    expect(status,
      'baseline paths from the worktree did not match the live tree — every ' +
      'pre-existing finding would read as new, disabling the whole subtraction')
      .toBe(0);
    expect(stdout).toMatch(/NEW_FINDINGS=0/);
  });

  it('survives an unparseable baseline rather than silently passing everything', () => {
    const { status, stdout } = run(
      'diff',
      'not json at all',
      eslintJson(ROOT, { 'src/a.ts': [{ ruleId: 'r', message: 'm' }] }),
      ROOT,
    );
    expect(status,
      'a corrupt baseline made the gate blind — findings must not be suppressed by a parse failure')
      .toBe(1);
    expect(stdout).toMatch(/NEW_FINDINGS=1/);
  });
});

describe('clean-files: which files may be auto-fixed without touching inherited code', () => {
  it('lists a file that had no findings at baseline', () => {
    const { stdout } = run('clean-files', eslintJson(ROOT, {}), null, ROOT);
    // absent from baseline findings == clean; caller intersects with changed files
    expect(stdout.trim()).toBe('');
  });

  it('names the files that DID have findings, so the caller can exclude them', () => {
    const baseline = eslintJson(ROOT, {
      'src/dirty.ts': [{ ruleId: 'prettier/prettier', message: 'Insert `;`' }],
    });
    const { stdout } = run('dirty-files', baseline, null, ROOT);

    expect(stdout.split('\n').filter(Boolean),
      'the caller cannot tell which files already had debt, so eslint --fix would ' +
      'reformat inherited code and balloon the client diff')
      .toEqual(['src/dirty.ts']);
  });

  it('reports a file with zero messages as clean, not dirty', () => {
    const baseline = JSON.stringify([
      { filePath: join(ROOT, 'src/ok.ts'), messages: [], errorCount: 0, warningCount: 0 },
    ]);
    const { stdout } = run('dirty-files', baseline, null, ROOT);
    expect(stdout.trim()).toBe('');
  });

  it('treats a missing baseline as "nothing is known dirty" (greenfield auto-fix is safe)', () => {
    const { stdout, status } = run('dirty-files', null, null, ROOT);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });
});
