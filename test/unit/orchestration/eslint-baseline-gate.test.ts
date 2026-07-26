/**
 * lib/eslint-baseline-gate.sh — the Step 20 lint gate, scoped to what this run
 * actually produced.
 *
 * Three defects are pinned here, all from the live metrolinx run of
 * 2026-07-25 and the design review that followed it:
 *
 *  1. SCOPE. The gate linted the entire tree and failed on any finding. That
 *     survives only on a codeline with zero lint debt. Anywhere else it fails
 *     on a file no agent touched, the analyst reports "Could not map lint
 *     failure to a story", and the run dies over inherited formatting. The
 *     gate must be handed the WRITERS' OUTPUTS and judge those.
 *
 *  2. BLAME. A writer that edits an already-dirty file must not inherit its
 *     debt. The only way to satisfy such a gate is to reformat code the ticket
 *     never mentioned — which the team-lead reviewer separately vetoes as
 *     over-engineering. The pipeline would be fighting itself.
 *
 *  3. COST. Step 20 runs AFTER the story is committed, and its remediation
 *     path returns exit 2, which tier3-*-run.sh answers by re-running the
 *     whole phase with --reset — the story re-implemented from scratch. Paying
 *     a full story rebuild to fix auto-fixable whitespace is absurd; those get
 *     fixed deterministically, and only real judgement calls reach the loop.
 *
 * Greenfield must keep working throughout: a scaffolded project has no
 * baseline, and there "everything is new" is the correct answer, not a reason
 * to suppress findings.
 *
 * The stub ESLint below derives findings from markers in the file contents, so
 * the baseline is produced by a real `git worktree` checkout of real content
 * rather than by a hand-written fixture of what the baseline "would" say.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const GATE_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/eslint-baseline-gate.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Stub ESLint. A line containing LINT_FIXABLE is an auto-fixable finding; a
 * line containing LINT_HARD is one --fix cannot resolve. `--fix` strips the
 * fixable markers, exactly as the real thing rewrites the file.
 */
function installStubEslint(projectRoot: string) {
  const binDir = join(projectRoot, 'node_modules/.bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'eslint');
  writeFileSync(
    stub,
    `#!/usr/bin/env python3
import sys, os, json, glob

with open(os.path.join(${JSON.stringify(JSON.stringify(projectRoot))}.strip('"'), 'eslint-cwds.log'), 'a') as _f:
    _f.write(os.getcwd() + '\\n')

args = sys.argv[1:]
if '--print-config' in args:
    sys.exit(0)

fmt_json = False
do_fix = False
targets = []
skip_next = False
for i, a in enumerate(args):
    if skip_next:
        skip_next = False
        continue
    if a == '-f':
        fmt_json = args[i + 1] == 'json'
        skip_next = True
    elif a == '--fix':
        do_fix = True
    elif a == '--max-warnings':
        skip_next = True
    elif a.startswith('-'):
        continue
    else:
        targets.append(a)

files = []
for t in targets:
    if os.path.isdir(t):
        files += [f for f in glob.glob(os.path.join(t, '**', '*'), recursive=True) if os.path.isfile(f)]
    elif any(c in t for c in '*?['):
        files += [f for f in glob.glob(t, recursive=True) if os.path.isfile(f)]
    elif os.path.isfile(t):
        files.append(t)
files = [f for f in sorted(set(files)) if 'node_modules' not in f]

if not files:
    print('No files matching the pattern "%s" were found.' % (targets[0] if targets else ''))
    sys.exit(2)

if do_fix:
    for f in files:
        src = open(f).read()
        if 'LINT_FIXABLE' in src:
            open(f, 'w').write(src.replace(' LINT_FIXABLE', '').replace('LINT_FIXABLE', ''))

report = []
total = 0
for f in files:
    msgs = []
    for n, line in enumerate(open(f).read().split('\\n'), 1):
        if 'LINT_FIXABLE' in line:
            msgs.append({'ruleId': 'prettier/prettier', 'message': 'fixable formatting',
                         'line': n, 'column': 1, 'severity': 2})
        if 'LINT_HARD' in line:
            msgs.append({'ruleId': 'sonarjs/no-duplicate-string', 'message': 'define a constant',
                         'line': n, 'column': 1, 'severity': 2})
        if 'LINT_WARN' in line:
            msgs.append({'ruleId': 'sonarjs/cognitive-complexity', 'message': 'too complex',
                         'line': n, 'column': 1, 'severity': 1})
    total += len(msgs)
    report.append({'filePath': os.path.abspath(f), 'messages': msgs,
                   'errorCount': len(msgs), 'warningCount': 0})

if fmt_json:
    print(json.dumps(report))
else:
    for entry in report:
        for m in entry['messages']:
            print('%s:%d  error  %s  %s' % (entry['filePath'], m['line'], m['message'], m['ruleId']))
    print('%d problems' % total)
sys.exit(1 if total else 0)
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

type Fixture = {
  projectRoot: string;
  logDir: string;
  eslintBin: string;
  baselineSha: string;
};

/**
 * Bare origin + clone, seeded with `baselineFiles` on the baseline branch.
 * `brownfield: false` produces a project with no baseline recorded at all —
 * the greenfield shape.
 */
function makeFixture(baselineFiles: Record<string, string>, opts: { brownfield?: boolean } = {}): Fixture {
  const brownfield = opts.brownfield !== false;
  const root = mkdtempSync(join(tmpdir(), 'eslint-gate-'));
  cleanupDirs.push(root);

  const bare = join(root, 'origin.git');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bare });

  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: seed });
  for (const [rel, content] of Object.entries(baselineFiles)) {
    const abs = join(seed, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const projectRoot = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bare, projectRoot]);
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, '.eslintrc.js'), 'module.exports = {};\n');

  const eslintBin = installStubEslint(projectRoot);
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });

  const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  if (brownfield) writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha + '\n');

  return { projectRoot, logDir, eslintBin, baselineSha };
}

/** Apply the "writer's" edits and commit them, as the story loop would. */
function writerProduces(fx: Fixture, files: Record<string, string>, opts: { manifest?: boolean } = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fx.projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: fx.projectRoot });
  execFileSync('git', ['commit', '-m', 'story: writer output', '--quiet'], { cwd: fx.projectRoot });
  if (opts.manifest !== false) {
    writeFileSync(join(fx.logDir, 'story-outputs-core.txt'), Object.keys(files).join('\n') + '\n');
  }
}

function runGate(fx: Fixture, env: Record<string, string> = {}) {
  const lintLog = join(fx.logDir, 'lint-gate-core.log');
  const script = join(fx.logDir, 'drive.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'log()     { echo "LOG: $*"; }',
      'info()    { echo "INFO: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      'error()   { echo "ERROR: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      `. ${JSON.stringify(GATE_LIB)}`,
      `eslint_baseline_gate ${JSON.stringify(fx.projectRoot)} ${JSON.stringify(fx.eslintBin)} ` +
        `${JSON.stringify(fx.logDir)} ${JSON.stringify(lintLog)}`,
      'echo "GATE_RC=$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PHASE: 'core', JIRA_BASELINE_BRANCH: 'develop', ...env },
  });
  const output = (r.stdout || '') + (r.stderr || '');
  const m = output.match(/GATE_RC=(\d+)/);
  const cwdLog = join(fx.projectRoot, 'eslint-cwds.log');
  return {
    rc: m ? parseInt(m[1], 10) : -1,
    output,
    lintLog: existsSync(lintLog) ? readFileSync(lintLog, 'utf8') : '',
    read: (rel: string) => readFileSync(join(fx.projectRoot, rel), 'utf8'),
    /** Working directories ESLint was invoked from, in order. */
    cwds: existsSync(cwdLog) ? readFileSync(cwdLog, 'utf8').split('\n').filter(Boolean) : [],
  };
}

describe('the gate judges the writers output, not the codebase', () => {
  it('passes when inherited debt sits in a file this run never touched', () => {
    const fx = makeFixture({
      'src/legacy.ts': 'const a = 1; // LINT_HARD\n',
      'src/target.ts': 'export const b = 2;\n',
    });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3;\n' });

    const { rc, output } = runGate(fx);
    expect(rc,
      "the gate failed on src/legacy.ts — a file no agent touched. This is the " +
      'shape that kills a run on any codeline with pre-existing lint debt')
      .toBe(0);
    expect(output).not.toMatch(/legacy\.ts/);
  });

  it('does not blame the writer for debt already present in a file it edited', () => {
    const fx = makeFixture({ 'src/target.ts': 'const old = 1; // LINT_HARD\nexport const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'const old = 1; // LINT_HARD\nexport const b = 3;\n' });

    const { rc } = runGate(fx);
    expect(rc,
      'the writer inherited the blame for a pre-existing finding in a file it ' +
      'happened to edit — satisfying that demands reformatting code the ticket never mentioned')
      .toBe(0);
  });

  it('fails on a finding the writer actually introduced, and names it', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3; // LINT_HARD\n' });

    const { rc, output } = runGate(fx);
    expect(rc, 'a finding this run introduced did not fail the gate').toBe(1);
    expect(output, 'the failure is not actionable — it does not say which file').toMatch(/src\/target\.ts/);
  });

  it('counts a second instance of a rule the file already violated', () => {
    const fx = makeFixture({ 'src/target.ts': 'const a = 1; // LINT_HARD\n' });
    writerProduces(fx, { 'src/target.ts': 'const a = 1; // LINT_HARD\nconst b = 2; // LINT_HARD\n' });

    const { rc } = runGate(fx);
    expect(rc, 'adding another instance of an existing violation was invisible').toBe(1);
  });
});

describe('the baseline checkout must not live inside the pipeline repo', () => {
  it('creates the baseline worktree outside the log directory', () => {
    // Live metrolinx 2026-07-26: the worktree was created under
    // orchestrations/logs/, i.e. INSIDE the epam-cli repo. ESLint then walked
    // up from the checkout and found @typescript-eslint twice — once via the
    // client's symlinked node_modules, once via epam-cli's own:
    //
    //   ESLint couldn't determine the plugin "@typescript-eslint" uniquely.
    //
    // It exited 2 and wrote nothing, so the baseline cache was 0 bytes and the
    // whole subtraction silently did not happen — "every finding will be
    // attributed to this run", which is the exact false-blame the gate exists
    // to prevent. lib/tsc-baseline-gate.sh uses mktemp -d for this reason.
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3;\n' });

    const { cwds } = runGate(fx);
    const inLogDir = cwds.filter(c => c.startsWith(fx.logDir));
    expect(inLogDir,
      `ESLint ran from inside the log directory (${JSON.stringify(inLogDir)}) — when that ` +
      `sits inside a repo with its own eslint plugins, the baseline run dies on a ` +
      `duplicate-plugin error and the subtraction is silently skipped`)
      .toEqual([]);
  });

  it('recomputes when a previous run left an EMPTY cache behind', () => {
    // Live metrolinx 2026-07-26, run 3. The worktree relocation fix was correct
    // and never executed: run 2 had written a 0-byte
    // eslint-baseline-<sha>.json (the duplicate-plugin failure), and the
    // production guard was `[ ! -f "$cache" ]` — an existing-but-empty file
    // reads as "already computed, skip". The consumption check right below it
    // used `-s`. One function, two different notions of "usable cache".
    //
    // Same shape as the stale-manifest and stale-.log hazards: a zero-byte
    // failure artefact that looks exactly like a valid result.
    const fx = makeFixture({ 'src/target.ts': 'const legacy = 1; // LINT_HARD\n' });
    writerProduces(fx, { 'src/target.ts': 'const legacy = 1; // LINT_HARD\nexport const b = 3;\n' });

    const sha = readFileSync(join(fx.logDir, 'phase-baseline-sha.txt'), 'utf8').trim();
    writeFileSync(join(fx.logDir, `eslint-baseline-${sha.slice(0, 12)}.json`), '');

    const { rc, output } = runGate(fx);
    expect(output,
      'an empty cache from a previous run permanently disables the subtraction')
      .not.toMatch(/could not compute baseline findings/);
    expect(rc, 'inherited debt was blamed on this run because the cache was never rebuilt').toBe(0);
  });

  it('still produces a usable baseline (the subtraction actually runs)', () => {
    const fx = makeFixture({ 'src/target.ts': 'const legacy = 1; // LINT_HARD\n' });
    writerProduces(fx, { 'src/target.ts': 'const legacy = 1; // LINT_HARD\nexport const b = 3;\n' });

    const { rc, output } = runGate(fx);
    expect(output,
      'the gate fell back to "every finding is new" — the baseline never computed')
      .not.toMatch(/could not compute baseline findings/);
    expect(rc, 'inherited debt was blamed on this run').toBe(0);
  });
});

describe('warnings still fail the gate', () => {
  it('a warning-severity finding this run introduced fails, as --max-warnings 0 did', () => {
    // The old invocation carried `--max-warnings 0`, so a warning failed the
    // gate. That flag is gone — the verdict is now a count over the JSON
    // report — and nothing else pins the behaviour it encoded.
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3; // LINT_WARN\n' });

    const { rc } = runGate(fx);
    expect(rc,
      'a warning passed the gate — dropping --max-warnings 0 quietly loosened the ' +
      'verdict rather than relocating it')
      .toBe(1);
  });
});

describe('auto-fixable findings are fixed, not sent round a story rebuild', () => {
  it('fixes an auto-fixable finding in the writers own new file and passes', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/new.spec.ts': 'describe(); // LINT_FIXABLE\n' });

    const { rc, read, output } = runGate(fx);
    expect(read('src/new.spec.ts'),
      'the auto-fixable finding was left for the remediation loop, which costs a ' +
      'full phase re-run with --reset to fix whitespace')
      .not.toMatch(/LINT_FIXABLE/);
    expect(rc).toBe(0);
    expect(output, 'the auto-fix was silent — the run log must show what was rewritten').toMatch(/fix/i);
  });

  it('does NOT auto-fix a file that was already dirty at baseline', () => {
    // eslint --fix cannot be limited to our lines. Running it on a file with
    // inherited violations reformats code the ticket never mentioned and
    // balloons the client diff.
    const fx = makeFixture({ 'src/target.ts': 'const legacy = 1; // LINT_FIXABLE\n' });
    writerProduces(fx, { 'src/target.ts': 'const legacy = 1; // LINT_FIXABLE\nexport const b = 3;\n' });

    const { rc, read } = runGate(fx);
    expect(read('src/target.ts'),
      "the gate reformatted a pre-existing line — that is unrequested scope inside a client repo")
      .toMatch(/LINT_FIXABLE/);
    expect(rc, 'the inherited finding it refused to fix was then held against the writer').toBe(0);
  });

  it('still fails when the writer introduces something --fix cannot resolve', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3; // LINT_FIXABLE LINT_HARD\n' });

    const { rc, output } = runGate(fx);
    expect(rc).toBe(1);
    expect(output, 'the remaining hard finding was not reported').toMatch(/sonarjs|define a constant/i);
  });
});

describe('scope resolution is explicit and never silent', () => {
  it('uses the writer-output manifest when the story loop wrote one', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3;\n' });

    const { output } = runGate(fx);
    expect(output, 'nothing in the log says where the lint scope came from').toMatch(/writer output/i);
  });

  it('falls back to the baseline diff — loudly — when no manifest exists', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3; // LINT_HARD\n' }, { manifest: false });

    const { rc, output } = runGate(fx);
    expect(output,
      'the manifest was missing and the gate silently changed how it computes scope')
      .toMatch(/manifest|fall(ing)? back/i);
    expect(rc, 'the fallback scope failed to catch a finding the writer introduced').toBe(1);
  });

  it('skips when the writer produced nothing lintable', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'docs/notes.md': '# notes\n' });

    const { rc, output } = runGate(fx);
    expect(rc, 'a run that produced only documentation was failed by the lint gate').toBe(0);
    expect(output, 'the skip is unexplained').toMatch(/skip/i);
  });

  it('ignores incidental pipeline paths in the scope', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { '.epam/dependency-check.json': '{}\n', 'src/target.ts': 'export const b = 3;\n' });

    const { rc, output } = runGate(fx);
    expect(rc).toBe(0);
    expect(output).not.toMatch(/dependency-check/);
  });
});

describe('greenfield keeps working', () => {
  it('lints the whole tree when there is no baseline to compare against', () => {
    const fx = makeFixture({ 'src/app.ts': 'export const a = 1;\n' }, { brownfield: false });
    // No manifest, no baseline SHA: the scaffolded-project shape.
    writeFileSync(join(fx.projectRoot, 'src/app.ts'), 'export const a = 1; // LINT_HARD\n');

    const { rc, output } = runGate(fx);
    expect(rc,
      'greenfield findings were suppressed as "pre-existing" — the gate is now ' +
      'disabled on exactly the code the pipeline wrote from scratch')
      .toBe(1);
    expect(output).toMatch(/src\/app\.ts/);
  });

  it('passes a clean greenfield tree', () => {
    const fx = makeFixture({ 'src/app.ts': 'export const a = 1;\n' }, { brownfield: false });
    expect(runGate(fx).rc).toBe(0);
  });

  it('auto-fixes greenfield code, where nothing can be inherited', () => {
    const fx = makeFixture({ 'src/app.ts': 'export const a = 1;\n' }, { brownfield: false });
    writeFileSync(join(fx.projectRoot, 'src/app.ts'), 'export const a = 1; // LINT_FIXABLE\n');

    const { rc, read } = runGate(fx);
    expect(read('src/app.ts')).not.toMatch(/LINT_FIXABLE/);
    expect(rc).toBe(0);
  });
});

describe('the gate reports what the remediation analyst has to read', () => {
  it('writes the new findings into the lint log', () => {
    const fx = makeFixture({ 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3; // LINT_HARD\n' });

    const { lintLog } = runGate(fx);
    expect(lintLog,
      'the analyst prompt is built from this log — without the finding it can only ' +
      'answer "could not map lint failure to a story"')
      .toMatch(/src\/target\.ts/);
  });

  it('records that inherited findings were excluded, so the exclusion is auditable', () => {
    const fx = makeFixture({ 'src/legacy.ts': 'const a = 1; // LINT_HARD\n', 'src/target.ts': 'export const b = 2;\n' });
    writerProduces(fx, { 'src/target.ts': 'export const b = 3;\n' });

    const { output, lintLog } = runGate(fx);
    expect(output + lintLog,
      'findings were dropped with no trace — a gate that silently narrows its own ' +
      'scope is indistinguishable from one that is broken')
      .toMatch(/pre-existing|baseline|excluded/i);
  });
});
