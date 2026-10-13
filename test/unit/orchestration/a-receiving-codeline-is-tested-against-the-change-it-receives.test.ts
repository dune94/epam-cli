/**
 * A CODELINE THAT RECEIVES ANOTHER CODELINE'S CHANGE IS TESTED AGAINST IT — ITS OWN SUITE, ON THE PROVIDER'S BUILD.
 *
 * AMSD-2974 run 9 (2026-10-13): the three sites' lanes built cx-shared's fix into their worktrees, then Step 19 ran on
 * the codeline root — which keeps its installed release — and with EPAM_WHOLE_SUITE_CHECK=0 not at all. The plan gave
 * the sites no change, so they had no tests of their own: no site was ever tested against the fix. Operator: "the
 * consumers were run for nothing and not tested". The suite of a receiving codeline now runs in a worktree with the
 * provider's build linked in (provision_lane_worktree), judged against the phase baseline on the installed release.
 *
 * EXECUTED: the real pre_review_suite (lib/pre-review-gate.sh) with the real provision_lane_worktree, sibling-providers.js,
 * plan-gives-no-change.js and baseline judging, on real git repositories: a provider whose build is good, and one whose
 * build breaks the site. NEGATIVES: a codeline with its own change keeps the operator's switch; one that receives
 * nothing is untouched by this; the codeline's own checkout keeps its release.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const env0 = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: env0 }).trim();
const pkg = (dir: string, json: object, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
};
// The site's declared suite: which build of the library it loaded, and a jest-shaped failure if that build breaks it.
const SUITE = `node -e "const v=require('@scope/lib');console.log('LIB='+v);if(v==='BROKEN'){console.log('FAIL src/uses-lib.spec.ts');process.exit(1)}"`;

function estate(opts: { build: 'NEW' | 'BROKEN'; siteChange: string; receives: boolean }) {
  const work = mkdtempSync(join(tmpdir(), 'receiving-')); dirs.push(work);
  const lib = join(work, 'codelines', 'lib');
  pkg(lib, { name: '@scope/lib', version: '2.0.0', main: 'dist/index.js', scripts: { build: 'node build.js' } },
    { 'build.js': `require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js',"module.exports='${opts.build}'")` });
  const site = join(work, 'codelines', 'site');
  pkg(site, { name: 'site', dependencies: opts.receives ? { '@scope/lib': '^1.0.0' } : {} }, {
    '.gitignore': 'node_modules\n', '.epam/verification.json': JSON.stringify({ test: { command: SUITE } }) });
  pkg(join(site, 'node_modules', '@scope', 'lib'), { name: '@scope/lib', version: '1.0.0', main: 'index.js' }, { 'index.js': "module.exports='OLD'" });
  git(work, 'init', '-q', '-b', 'develop', site); git(site, 'add', '-A'); git(site, 'commit', '-q', '-m', 'base');
  const logs = join(work, 'logs'); mkdirSync(logs);
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), `${git(site, 'rev-parse', 'HEAD')}\n`);
  const proj = join(work, 'project'); mkdirSync(proj);
  writeFileSync(join(proj, 'dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules'] }));
  const prd = join(work, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { outputDirs: [{ codeline: 'lib', path: lib }, { codeline: 'site', path: site }] },
    stories: [{ id: 'S-1', overallPlan: { packages: [{ package: '@scope/lib', providedBy: 'lib', consumers: [{ codeline: 'site', change: opts.siteChange }] }] } }],
  }));
  const gateLog = join(work, 'gate.log');
  const r = spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; info(){ :; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
source ${JSON.stringify(join(SCRIPTS, 'lib/pre-review-gate.sh'))}
pre_review_suite ${JSON.stringify(site)} ${JSON.stringify(logs)} ${JSON.stringify(gateLog)}; echo "RC=$?"`],
  { encoding: 'utf8', timeout: 120_000, env: { ...env0, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: proj, EPAM_BROWNFIELD: '1', EPAM_CODELINE: 'site',
    EPAM_WHOLE_SUITE_CHECK: '0', NODE_BIN: process.execPath, AUTOMATION_DIR: join(SCRIPTS, '..'), LOG_DIR: logs, PROJECT_ROOT: site } });
  const out = r.stdout + r.stderr;
  const rc = Number((out.match(/^RC=(\d+)$/m) || [])[1]);
  const log = existsSync(gateLog) ? readFileSync(gateLog, 'utf8') : '';
  const rootSees = spawnSync(process.execPath, ['-e', "process.stdout.write(require('@scope/lib'))"], { cwd: site, encoding: 'utf8' }).stdout;
  const worktrees = git(site, 'worktree', 'list').split('\n').length;
  return { out, rc, log, rootSees, worktrees };
}

describe('a codeline that receives another codeline\'s change is tested against it', () => {
  it('the plan gives the site no change: its own suite runs on the provider\'s build — and passes on a good one', () => {
    const e = estate({ build: 'NEW', siteChange: 'none', receives: true });
    expect(e.log, e.out).toContain('LIB=NEW');
    expect(e.rc, e.out).toBe(0);
  });

  it('a provider change that breaks the site fails the site\'s gate — the failure is new against the installed release', () => {
    const e = estate({ build: 'BROKEN', siteChange: 'none', receives: true });
    expect(e.log, e.out).toContain('LIB=BROKEN');
    expect(e.rc, e.out).toBe(1);
  });

  it('NEGATIVE: the codeline\'s own checkout keeps its installed release, and the worktree is gone', () => {
    const e = estate({ build: 'NEW', siteChange: 'none', receives: true });
    expect(e.rootSees).toBe('OLD');
    expect(e.worktrees).toBe(1);
  });

  it('NEGATIVE: a site the plan gives its own change keeps the operator\'s switch — its suite is not run', () => {
    const e = estate({ build: 'BROKEN', siteChange: 'add a prop to the toast call', receives: true });
    expect(e.rc).toBe(0);
    expect(e.log).not.toContain('LIB=');
    expect(e.out).toContain('EPAM_WHOLE_SUITE_CHECK=0');
  });

  it('NEGATIVE: a codeline that receives nothing is not touched by this — the switch holds', () => {
    const e = estate({ build: 'BROKEN', siteChange: 'none', receives: false });
    expect(e.rc).toBe(0);
    expect(e.log).not.toContain('LIB=');
  });
});
