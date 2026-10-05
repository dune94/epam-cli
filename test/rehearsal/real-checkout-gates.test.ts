/**
 * ON A COPY OF THE REAL ESTATE: THE PIPELINE'S CHECKOUT COMMITS AND STEPS 19/20'S TYPE CHECK.
 *
 * Live AMSD-2974, 2026-10-05: next.gotransit.com's pre-commit hook type-checks the whole project, which
 * fails on the untouched checkout with 6 errors (the team's node_modules is older than its develop
 * branch expects). It refused the reproducing test's commit; Steps 19/20 ran the same whole-project
 * check raw and would have failed every story on errors none of them made.
 *
 * REAL (REHEARSAL_ROOT from real-estate-setup.sh): the client's own hooks, tsc and git; nothing stubbed.
 *   commits  RED   a plain commit in the checkout is refused by the client's hook.
 *            GREEN the pipeline's commit (pipeline_commit_flags) lands.
 *   tsc      the raw declared check fails on the untouched checkout (the red Steps 19/20 hit);
 *            pre_review_typecheck passes it (every error already at the baseline);
 *            a type error the phase introduces still fails it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const R = process.env.REHEARSAL_ROOT || '';
const SITE = process.env.REHEARSAL_SITE || 'next.gotransit.com';
const PROJECT = process.env.REHEARSAL_PROJECT || '';
const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
const root = join(R, 'codelines', SITE);
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const logDir = join(R, 'gates-test-logs');
const env = () => ({ ...process.env, SCRIPT_DIR: SCRIPTS, AUTOMATION_DIR: join(SCRIPTS, '..'), NODE_BIN: process.execPath, EPAM_PROJECT_CONFIG_DIR: join(R, 'install/orchestrations/projects', PROJECT), EPAM_BROWNFIELD: '1', LOG_DIR: logDir });
const sh = (body: string) => spawnSync('bash', ['-c', `log(){ echo "$*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }; info(){ :; }; success(){ echo "OK $*"; }\n${body}`], { encoding: 'utf8', env: env(), timeout: 30 * 60_000 });

describe.runIf(R && PROJECT)('the real site checkout: pipeline commits and the Step 19/20 type check', () => {
  it('a plain commit is refused by the client hook; the pipeline commit lands', () => {
    const f = git('ls-files', 'src').split('\n').find((x) => /\.ts$/.test(x) && !/\.(spec|test)\./.test(x))!;
    const orig = readFileSync(join(root, f), 'utf8');
    try {
      writeFileSync(join(root, f), `${orig}\n// rehearsal: pipeline commit\n`);
      git('add', f);
      const before = git('rev-parse', 'HEAD');
      const plain = spawnSync('git', ['commit', '-m', 'AMSD-2974: plain commit'], { cwd: root, encoding: 'utf8', timeout: 15 * 60_000 });
      expect(plain.status, 'the client hook accepted a plain commit — no red').not.toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(before);
      const piped = sh(`cd ${JSON.stringify(root)} && . ${JSON.stringify(join(SCRIPTS, 'lib/pipeline-commit.sh'))} && git commit $(pipeline_commit_flags) -m 'AMSD-2974: pipeline commit'`);
      expect(piped.status, `the pipeline commit was refused:\n${piped.stdout}${piped.stderr}`).toBe(0);
      expect(git('log', '-1', '--format=%s')).toBe('AMSD-2974: pipeline commit');
      git('reset', '-q', '--hard', before);
    } finally { writeFileSync(join(root, f), orig); spawnSync('git', ['checkout', '--', f], { cwd: root }); }
  }, 30 * 60_000);

  it('Step 19/20: the raw check fails untouched; judged against the baseline it passes; a new error still fails', () => {
    rmSync(logDir, { recursive: true, force: true }); mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), `${git('rev-parse', 'HEAD')}\n`);
    const libs = `. ${JSON.stringify(join(SCRIPTS, 'lib/pre-review-gate.sh'))}`;
    const raw = sh(`${libs} >/dev/null 2>&1; _run_project_verification ${JSON.stringify(root)}`);
    expect(raw.status, 'the raw check passed on the untouched checkout — no red to subtract').not.toBe(0);
    expect(raw.stdout).toMatch(/error TS\d+/);

    const judged = sh(`${libs} >/dev/null 2>&1; pre_review_typecheck ${JSON.stringify(root)} ${JSON.stringify(logDir)} ${JSON.stringify(join(logDir, 'gate.log'))}`);
    expect(judged.status, `pre-existing errors were charged to the phase:\n${judged.stdout.slice(-2500)}`).toBe(0);
    expect(judged.stdout).toMatch(/already present at the baseline/);

    const f = git('ls-files', 'src').split('\n').find((x) => /\.ts$/.test(x) && !/\.(spec|test|d)\./.test(x))!;
    const orig = readFileSync(join(root, f), 'utf8');
    try {
      writeFileSync(join(root, f), `${orig}\nexport const rehearsalTypeError: number = 'not a number';\n`);
      const broken = sh(`${libs} >/dev/null 2>&1; pre_review_typecheck ${JSON.stringify(root)} ${JSON.stringify(logDir)} ${JSON.stringify(join(logDir, 'gate2.log'))}`);
      expect(broken.status, 'a type error the phase introduced was not caught').not.toBe(0);
      expect(broken.stdout).toMatch(/errors this phase introduced/);
    } finally { writeFileSync(join(root, f), orig); }
  }, 60 * 60_000);
});
