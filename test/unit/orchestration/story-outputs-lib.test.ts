/**
 * lib/story-outputs.sh — one answer to "what did this run produce?", shared by
 * every gate that needs it.
 *
 * Step 20's lint gate was fixed by handing it the writers' output instead of
 * letting it rediscover scope by linting the whole tree. The reviewers still
 * infer it, each in their own slightly different way:
 *
 *   team-lead-review.sh:257   git diff --name-only $BASELINE_SHA HEAD
 *   review-ranger             git diff --name-only <baseline>..HEAD
 *   mutant-hunter             git diff --name-only <baseline>..HEAD -- '*.ts'
 *
 * Three copies of one idea is how they drift. They already have, in two ways
 * that matter:
 *
 *   1. `<baseline>..HEAD` is commit-to-commit, so writer output that is not
 *      committed yet is invisible to review.
 *   2. Every one of them falls back to `HEAD~1` when the baseline SHA file is
 *      missing — silently. That is the exact shape of the review-oracle bug
 *      where the diff ran against an empty range and the reviewers examined
 *      zero files while reporting success.
 *
 * And mutant-hunter finds its test files with `find -name "*.test.ts"`, which
 * matches nothing on a codeline whose tests are named `.spec.ts` — as the live
 * metrolinx one is. It reported "(no test files found)" while the run had just
 * produced a reproducing spec.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-outputs.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture(opts: { baseline?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'story-outputs-lib-'));
  cleanupDirs.push(root);
  const projectRoot = join(root, 'repo');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, 'src/existing.ts'), 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: projectRoot });

  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  if (opts.baseline !== false) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), sha + '\n');
  }
  return { projectRoot, logDir };
}

function write(projectRoot: string, rel: string, content: string) {
  const abs = join(projectRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function manifest(logDir: string, files: string[]) {
  writeFileSync(join(logDir, 'story-outputs-core.txt'), files.join('\n') + '\n');
}

function call(fx: { projectRoot: string; logDir: string }, fn: string) {
  const r = spawnSync(
    'bash',
    ['-c',
      `warning(){ echo "WARNING: $*" >&2; }; info(){ echo "INFO: $*" >&2; }\n` +
      `. ${JSON.stringify(LIB)}\n` +
      `${fn} ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}\n` +
      `echo "SOURCE=$STORY_OUTPUTS_SOURCE" >&2`],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, PHASE: 'core' } },
  );
  return {
    files: (r.stdout || '').split('\n').filter(Boolean),
    stderr: r.stderr || '',
    source: ((r.stderr || '').match(/SOURCE=(.*)/) || [, ''])[1].trim(),
  };
}

describe('one shared answer to "what did this run produce"', () => {
  it('uses the writer-output manifest when the story loop wrote one', () => {
    const fx = makeFixture();
    manifest(fx.logDir, ['src/a.ts', 'src/b.spec.ts']);
    const { files, source } = call(fx, 'story_outputs_files');

    expect(files).toEqual(['src/a.ts', 'src/b.spec.ts']);
    expect(source).toBe('manifest');
  });

  it('sees writer output that is not committed yet', () => {
    // `<baseline>..HEAD` is commit-to-commit. A reviewer that only reads
    // committed work reviews half the story when the test lands separately.
    const fx = makeFixture();
    write(fx.projectRoot, 'src/uncommitted.ts', 'export const b = 2;\n');
    const { files } = call(fx, 'story_outputs_files');

    expect(files, 'uncommitted writer output is invisible to the gate').toContain('src/uncommitted.ts');
  });

  it('falls back to the baseline diff, and says so', () => {
    const fx = makeFixture();
    write(fx.projectRoot, 'src/existing.ts', 'export const a = 2;\n');
    execFileSync('git', ['commit', '-am', 'change', '--quiet'], { cwd: fx.projectRoot });

    const { files, source, stderr } = call(fx, 'story_outputs_files');
    expect(files).toEqual(['src/existing.ts']);
    expect(source).toBe('baseline diff');
    expect(stderr, 'the scope silently changed how it was computed').toMatch(/manifest|fall(ing)? back/i);
  });

  it('reports "none" rather than inventing a scope when there is no baseline', () => {
    // Every current caller falls back to HEAD~1 here, which reviews an
    // arbitrary previous commit and reports success having examined nothing
    // this run produced.
    const fx = makeFixture({ baseline: false });
    const { files, source } = call(fx, 'story_outputs_files');

    expect(files).toEqual([]);
    expect(source, 'an empty scope was passed off as a real one').toBe('none');
  });

  it('never reports pipeline noise as writer output', () => {
    const fx = makeFixture();
    manifest(fx.logDir, ['.codegraph/db', '.epam/dependency-check.json', 'src/a.ts']);
    expect(call(fx, 'story_outputs_files').files).toEqual(['src/a.ts']);
  });
});

describe('splitting output into code and tests', () => {
  it('recognises .spec.ts as a test — the live codeline names them that way', () => {
    // mutant-hunter used `find -name "*.test.ts"`, which matches nothing on a
    // .spec.ts codebase. It reported "(no test files found)" on a run that had
    // just written a reproducing spec.
    const fx = makeFixture();
    manifest(fx.logDir, ['src/a.ts', 'src/a.spec.ts']);

    expect(call(fx, 'story_outputs_tests').files,
      'a .spec.ts file was not recognised as a test').toEqual(['src/a.spec.ts']);
    expect(call(fx, 'story_outputs_sources').files).toEqual(['src/a.ts']);
  });

  it('recognises the other conventions too', () => {
    const fx = makeFixture();
    manifest(fx.logDir, [
      'src/a.ts',
      'src/b.test.ts',
      'src/__tests__/c.ts',
      'src/d_test.go',
    ]);
    // Output is sorted, not input-ordered.
    expect(call(fx, 'story_outputs_tests').files).toEqual([
      'src/__tests__/c.ts', 'src/b.test.ts', 'src/d_test.go',
    ]);
    expect(call(fx, 'story_outputs_sources').files).toEqual(['src/a.ts']);
  });

  it('keeps sources and tests disjoint', () => {
    const fx = makeFixture();
    manifest(fx.logDir, ['src/a.ts', 'src/a.spec.ts']);
    const tests = call(fx, 'story_outputs_tests').files;
    const sources = call(fx, 'story_outputs_sources').files;
    expect(tests.filter(f => sources.includes(f))).toEqual([]);
  });
});
