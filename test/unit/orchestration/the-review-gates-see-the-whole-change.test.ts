/**
 * THREE QA GATES WERE SHOWN ONLY TYPESCRIPT.
 *
 *   spec-validator   git diff -U2 <ref> -- '*.ts' '*.json'
 *   review-ranger    git diff -U3 <ref> -- '*.ts'
 *   mutant-hunter    ... | grep -E '\.ts$'   (and a fallback re-deriving `.test.ts`)
 *
 * That filter is on the wrong axis. It answers "is this TypeScript" when the question is "is this
 * the change under review". On a Python, Rust, Go, Ruby or plain-JavaScript codeline the reviewer
 * was handed an EMPTY patch and reviewed nothing — while its verdict still counted toward the
 * phase gate. This is the documented "review-ranger returned a 211-byte pass without naming the
 * diff" failure, sitting in the code as a pathspec.
 *
 * The right axis is artefacts: exclude node_modules, target/, .venv, build output — which
 * lib/ecosystem-registry.js and config/repo-artifacts.json already answer for every ecosystem — and show
 * the agent everything else, whatever language the customer writes.
 *
 * Lockfiles are the one asymmetry. They must still be STAGED (a real dependency change belongs in
 * the commit) but must not be REVIEWED: machine-generated, often thousands of lines, and they
 * would consume the reviewer's budget before it reached the code. Staging and reviewing are
 * different questions, so `pathspec` and `diff` are different answers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const EXCL = join(SCRIPTS, 'lib/handlers/repo-exclude-patterns.js');
const NODE = process.execPath;

function gatesFn(): string {
  const src = readFileSync(ORCH, 'utf8');
  const i = src.indexOf('run_testing_gates() {');
  return src.slice(i, src.indexOf('\n}', i));
}
const code = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'gate-diff-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

/** A repo whose change spans several languages, plus artefacts and a lockfile. */
function mixedRepo(): string {
  const dir = join(work, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
  for (const f of ['src/a.py', 'src/b.rs', 'src/c.ts', 'src/d.go']) writeFileSync(join(dir, f), 'x\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'i.js'), 'junk\n');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  for (const f of ['src/a.py', 'src/b.rs', 'src/c.ts', 'src/d.go']) appendFileSync(join(dir, f), 'CHANGED\n');
  appendFileSync(join(dir, 'node_modules', 'dep', 'i.js'), 'junk2\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"x":1}');
  return dir;
}

function excludes(form: 'pathspec' | 'diff'): string[] {
  const r = spawnSync(NODE, [EXCL, form], { encoding: 'utf8' });
  expect(r.status, `the exclusion handler failed: ${r.stderr}`).toBe(0);
  return r.stdout.split('\n').filter(Boolean);
}

/** The file list a gate's diff would actually show. */
function diffFiles(dir: string, form: 'pathspec' | 'diff'): string[] {
  return git(dir, 'diff', '--name-only', 'HEAD', '--', '.', ...excludes(form))
    .stdout.split('\n').filter(Boolean);
}

describe('the review gates see the whole change', () => {
  it('no gate filters the diff by file extension any more', () => {
    const body = code(gatesFn());
    expect(body, "a gate still shows the reviewer only '*.ts'").not.toMatch(/diff [^\n]*-- '\*\.ts'/);
    expect(body, 'the mutant hunter still re-derives a TypeScript-only source rule')
      .not.toMatch(/grep -E '\\\.ts\$'/);
  });

  it('a Python, Rust and Go change all reach the reviewer', () => {
    const files = diffFiles(mixedRepo(), 'diff');
    for (const f of ['src/a.py', 'src/b.rs', 'src/d.go', 'src/c.ts']) {
      expect(files, `${f} changed but the reviewer would not see it`).toContain(f);
    }
  });

  it('the old filter is what would have hidden them', () => {
    // Pins the defect rather than describing it.
    const dir = mixedRepo();
    const old = git(dir, 'diff', '--name-only', 'HEAD', '--', '*.ts').stdout.split('\n').filter(Boolean);
    expect(old, 'the old pathspec no longer reproduces the blind spot').toEqual(['src/c.ts']);
  });

  it('build artefacts still do not reach the reviewer', () => {
    // The fix must widen the diff without flooding it.
    const files = diffFiles(mixedRepo(), 'diff');
    expect(files.filter((f) => f.startsWith('node_modules/')),
      'vendored dependencies are now in the review diff').toEqual([]);
  });

  it('a lockfile is excluded from REVIEW but not from STAGING', () => {
    // The asymmetry: a dependency change must be committed, and must not eat the review budget.
    expect(diffFiles(mixedRepo(), 'diff'), 'a lockfile is in the review diff')
      .not.toContain('package-lock.json');
    expect(diffFiles(mixedRepo(), 'pathspec'), 'a lockfile would no longer be staged')
      .toContain('package-lock.json');
  });

  it('the gates ask for the diff form, not the staging form', () => {
    // _gate_diff_excludes is defined just outside run_testing_gates, so read the helper itself
    // rather than the function that calls it.
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('_gate_diff_excludes() {');
    expect(i, 'the shared exclusion helper is gone').toBeGreaterThan(-1);
    expect(src.slice(i, i + 400), 'the gates resolve the staging list, which keeps lockfiles in')
      .toMatch(/repo-exclude-patterns\.js" diff/);
    expect(code(gatesFn()), 'no gate calls the helper').toMatch(/_gate_diff_excludes/);
  });

  it('mutant-hunter takes its source list from the shared test predicate', () => {
    // story_outputs_sources already excludes tests using the broad convention regex. Re-filtering
    // by extension threw away every source file on any other stack.
    const body = code(gatesFn());
    const i = body.indexOf('story_outputs_sources');
    expect(i, 'the mutant hunter no longer asks for source files').toBeGreaterThan(-1);
    expect(body.slice(i, i + 400), 'it still narrows the result to one language')
      .not.toMatch(/\\\.ts\$/);
  });
});
