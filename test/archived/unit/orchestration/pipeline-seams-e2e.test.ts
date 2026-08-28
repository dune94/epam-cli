/**
 * HP-1 increment 1 — the seam chain, with real components in real order.
 *
 * Every defect that cost a run on 2026-07-26 was a WIRING defect that passed
 * its own unit tests:
 *
 *   manifest written before the test-writer commits → mutant-hunter scored 0
 *   baseline worktree inside the pipeline repo      → subtraction never ran
 *   empty cache read as "already computed"          → the fix never executed
 *   QA gates able to reach write_file               → perf-sentinel reviewed nothing
 *   `| tee` swallowing an exit status               → a guard enforcing nothing
 *
 * Five for five. Each was tested as an isolated mechanism, with the integration
 * asserted by string match — and a string match cannot see that component A
 * finishes AFTER component B has already read A's output.
 *
 * So this test does not check mechanisms. It runs the real producers and the
 * real consumers, in the real order, over a real git repository with a planted
 * bug, and asserts on what actually crosses each seam. Stub agents only — no
 * LLM calls, deterministic, seconds rather than 47 minutes.
 *
 * The ordering below is the pipeline's true ordering and matters:
 *   Step 8  impl agent commits the fix        → record_story_outputs
 *   Step ~9 repro-test-writer commits a test  → story_outputs_record  (LATER!)
 *   Step 20 lint gate reads the manifest
 *   Step 4.3 reviewers read the manifest
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPTS = join(REPO_ROOT, 'orchestrations/scripts');
const STORY_OUTPUTS_LIB = join(SCRIPTS, 'lib/story-outputs.sh');
const GATE_LIB = join(SCRIPTS, 'lib/eslint-baseline-gate.sh');

let fx: Fixture;

type Fixture = {
  root: string;
  projectRoot: string;
  logDir: string;
  eslintBin: string;
  baselineSha: string;
};

/** Stub ESLint: LINT_FIXABLE = auto-fixable, LINT_HARD = not. */
function installStubEslint(projectRoot: string): string {
  const binDir = join(projectRoot, 'node_modules/.bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'eslint');
  writeFileSync(stub, `#!/usr/bin/env python3
import sys, os, json, glob
args = sys.argv[1:]
if '--print-config' in args: sys.exit(0)
fmt_json = False; do_fix = False; targets = []; skip = False
for i, a in enumerate(args):
    if skip: skip = False; continue
    if a == '-f': fmt_json = args[i+1] == 'json'; skip = True
    elif a == '--fix': do_fix = True
    elif a == '--max-warnings': skip = True
    elif a.startswith('-'): continue
    else: targets.append(a)
files = []
for t in targets:
    if any(c in t for c in '*?['): files += [f for f in glob.glob(t, recursive=True) if os.path.isfile(f)]
    elif os.path.isfile(t): files.append(t)
files = [f for f in sorted(set(files)) if 'node_modules' not in f]
if not files:
    print('No files matching the pattern "%s" were found.' % (targets[0] if targets else '')); sys.exit(2)
if do_fix:
    for f in files:
        src = open(f).read()
        if 'LINT_FIXABLE' in src: open(f, 'w').write(src.replace(' LINT_FIXABLE', ''))
report = []; total = 0
for f in files:
    msgs = []
    for n, line in enumerate(open(f).read().split('\\n'), 1):
        if 'LINT_FIXABLE' in line:
            msgs.append({'ruleId':'prettier/prettier','message':'fixable','line':n,'column':1,'severity':2})
        if 'LINT_HARD' in line:
            msgs.append({'ruleId':'sonarjs/no-duplicate-string','message':'define a constant','line':n,'column':1,'severity':2})
    total += len(msgs)
    report.append({'filePath': os.path.abspath(f), 'messages': msgs, 'errorCount': len(msgs), 'warningCount': 0})
print(json.dumps(report) if fmt_json else '%d problems' % total)
sys.exit(1 if total else 0)
`);
  chmodSync(stub, 0o755);
  return stub;
}

/**
 * A brownfield repo with a planted bug AND planted pre-existing lint debt —
 * the debt is what proves the baseline subtraction really ran.
 */
function makeCodeline(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'seams-e2e-'));
  const bare = join(root, 'origin.git');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bare });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: seed });
  // The planted bug, plus a pre-existing violation on an untouched line.
  writeFileSync(join(seed, 'src/discount.ts'),
    'const legacy = "dup"; // LINT_HARD  (pre-existing debt, NOT this run\'s fault)\n' +
    'export function match(a: string, b: string) {\n' +
    '  return a === b; // planted bug: composite keys never match\n' +
    '}\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const projectRoot = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bare, projectRoot]);
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectRoot });
  // Committed + gitignored exactly as a real codeline has them: the manifest is
  // built from `git diff` plus untracked files, so uncommitted scaffolding would
  // otherwise read as writer output. The real client repo gitignores node_modules;
  // a fixture that does not is testing its own sloppiness, not the pipeline.
  writeFileSync(join(projectRoot, '.eslintrc.js'), 'module.exports = {};\n');
  writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-m', 'chore: lint config', '--quiet'], { cwd: projectRoot });

  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: projectRoot, encoding: 'utf8' }).trim();
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha + '\n');

  return { root, projectRoot, logDir, eslintBin: installStubEslint(projectRoot), baselineSha };
}

/** Run a bash snippet with the pipeline's real libs sourced. */
function sh(body: string, env: Record<string, string> = {}) {
  const script = join(fx.logDir, `drive-${Math.abs(hash(body))}.sh`);
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'log(){ echo "LOG: $*"; }; info(){ echo "INFO: $*"; }; success(){ echo "SUCCESS: $*"; }',
    'error(){ echo "ERROR: $*"; }; warning(){ echo "WARNING: $*"; }',
    `. ${JSON.stringify(STORY_OUTPUTS_LIB)}`,
    `. ${JSON.stringify(GATE_LIB)}`,
    body,
  ].join('\n'));
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, PHASE: 'core', JIRA_BASELINE_BRANCH: 'develop', ...env },
  });
  return (r.stdout || '') + (r.stderr || '');
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function commit(rel: string, content: string, message: string) {
  const abs = join(fx.projectRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  execFileSync('git', ['add', '-A'], { cwd: fx.projectRoot });
  execFileSync('git', ['commit', '-m', message, '--quiet'], { cwd: fx.projectRoot });
}

const manifestPath = () => join(fx.logDir, 'story-outputs-core.txt');
const manifest = () =>
  existsSync(manifestPath())
    ? readFileSync(manifestPath(), 'utf8').split('\n').filter(Boolean)
    : [];

// ── the run, in pipeline order ────────────────────────────────────────────────

describe('pipeline seams — producers and consumers in real order', () => {
  beforeAll(() => { fx = makeCodeline(); });
  afterAll(() => { if (fx?.root) rmSync(fx.root, { recursive: true, force: true }); });

  it('Step 8 · the impl agent commits a fix, and the story loop records it', () => {
    commit('src/discount.ts',
      'const legacy = "dup"; // LINT_HARD  (pre-existing debt, NOT this run\'s fault)\n' +
      'import { parseKey } from "./keys";\n' +
      'export function match(a: string, b: string) {\n' +
      '  return parseKey(a).id === b; // the fix\n' +
      '}\n',
      'BUG-1: story complete (1 file(s))');

    sh(`story_outputs_record ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}`);
    expect(manifest(), 'the impl file never reached the manifest').toEqual(['src/discount.ts']);
  });

  it('Step 9 · the repro-test-writer commits LATER and its test still reaches the manifest', () => {
    // THE 2026-07-26 DEFECT. The story loop has already recorded and moved on;
    // if this producer does not record its own output, the test is invisible to
    // every downstream gate — which is exactly how mutant-hunter scored 0 on a
    // run whose test the repro gate had just proven correct.
    commit('src/discount.spec.ts',
      'describe("match", () => { it("handles composite keys", () => {}); });\n',
      'test: add bug-reproducing test for BUG-1');

    sh(`story_outputs_record ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}`);
    expect(manifest(),
      'the reproducing test is missing — every gate downstream will judge an incomplete change')
      .toEqual(['src/discount.spec.ts', 'src/discount.ts']);
  });

  it('Step 4.3 · mutant-hunter receives the test file, not an empty list', () => {
    // The direct cause of mutationScore: 0. mutant-hunter reads its tests from
    // the manifest; an empty list means every mutant survives and a good run
    // fails its own quality gate.
    const out = sh(`story_outputs_tests ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}`);
    const tests = out.split('\n').filter(l => l.endsWith('.spec.ts') || l.endsWith('.test.ts'));
    expect(tests, 'mutant-hunter would score 0 against no tests').toEqual(['src/discount.spec.ts']);
  });

  it('Step 4.3 · reviewers receive the source file, separated from the test', () => {
    const out = sh(`story_outputs_sources ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}`);
    expect(out.split('\n').filter(l => l.startsWith('src/'))).toEqual(['src/discount.ts']);
  });

  it('Step 20 · the lint gate scopes to the manifest and computes a real baseline', () => {
    const out = sh(
      `eslint_baseline_gate ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.eslintBin)} ` +
      `${JSON.stringify(fx.logDir)} ${JSON.stringify(join(fx.logDir, 'lint.log'))}; echo "RC=$?"`);

    expect(out, 'the gate did not take its scope from the writer-output manifest')
      .toMatch(/scope: 2 file\(s\) from writer output manifest/);
    expect(out,
      'baseline subtraction did not run — inherited debt would be blamed on this run')
      .not.toMatch(/could not compute baseline findings/);
    expect(out).toMatch(/RC=0/);
  });

  it('Step 20 · pre-existing debt in an edited file is NOT blamed on this run', () => {
    // src/discount.ts carried a LINT_HARD violation at baseline and the writer
    // edited that file. Only the subtraction distinguishes "inherited" from
    // "introduced" — and a writer forced to fix inherited debt would be vetoed
    // by the team-lead reviewer for over-engineering.
    const lint = readFileSync(join(fx.logDir, 'lint.log'), 'utf8');
    expect(lint, 'the inherited finding was attributed to this run').toMatch(/NEW_FINDINGS=0/);
    expect(lint).toMatch(/pre-existing finding/);
  });

  it('Step 20 · a finding this run DOES introduce still fails the gate', () => {
    // The converse: scoping and subtraction must not have disabled the gate.
    commit('src/discount.ts',
      readFileSync(join(fx.projectRoot, 'src/discount.ts'), 'utf8') +
      'const another = "dup2"; // LINT_HARD\n',
      'story: introduce a real finding');
    sh(`story_outputs_record ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.logDir)}`);

    const out = sh(
      `eslint_baseline_gate ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.eslintBin)} ` +
      `${JSON.stringify(fx.logDir)} ${JSON.stringify(join(fx.logDir, 'lint2.log'))}; echo "RC=$?"`);

    expect(out, 'a finding introduced by this run passed the gate').toMatch(/RC=1/);
    expect(out).toMatch(/src\/discount\.ts/);
  });
});
