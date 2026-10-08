/**
 * A PROVIDER'S RELEASE LINE IS BUILT AS ITS OWN CHECKOUT IS — ITS DEPENDENCIES INSIDE IT, NOT LINKED FROM ELSEWHERE.
 *
 * Live AMSD-2974 run 3 (2026-10-07, upexpress): the consumer lane builds against cx-shared's 7.x line, checked out in
 * a worktree of its own (cx-shared-line-7.x) whose node_modules was a LINK to cx-shared's. Rollup resolves real paths,
 * so its output took the codelines folder as its root — build/cx-shared-line-7.x/src/... instead of build/src/... —
 * and upexpress's next.config.ts, importing @metrolinx/cx-shared/build/src/utils/..., failed on every one of 12
 * attempts (the analyst called it the environment). The real checkout builds correctly: its node_modules is a real
 * directory. The line worktree gets the same: a hard-linked copy (same disk, nothing fetched, nothing installed).
 *
 * EXECUTED: the real provision_lane_worktree / link_sibling_builds (lib/codeline-lanes.sh), the real handlers, real
 * git and the provider's own declared build run by real npm. The build stands in for rollup only in what matters here:
 * it lays its output out from the REAL path of what it reads.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const work = mkdtempSync(join(tmpdir(), 'line-sibling-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const env0 = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: env0 }).trim();
const pkg = (dir: string, json: object, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
};

// The provider. Its build writes, beside what it ships, where the dependency it read REALLY lives, relative to the
// folder it built in — as rollup lays out its preserved modules.
const lib = join(work, 'codelines', 'lib');
pkg(lib, { name: '@scope/lib', version: '2.0.0', main: 'dist/index.js', scripts: { build: 'node build.js' } }, {
  '.gitignore': 'node_modules\ndist\n',
  'build.js': "const fs=require('fs'),p=require('path');fs.mkdirSync('dist',{recursive:true});"
    + "fs.writeFileSync('dist/where.txt',p.relative(process.cwd(),fs.realpathSync('node_modules/dep/index.js')));"
    + "fs.writeFileSync('dist/index.js',\"module.exports=require('fs').readFileSync(__dirname+'/line.txt','utf8')\");"
    + "fs.writeFileSync('dist/line.txt',fs.readFileSync('line.txt','utf8'))",
  'line.txt': 'OWN-LINE',
});
pkg(join(lib, 'node_modules', 'dep'), { name: 'dep', main: 'index.js' }, { 'index.js': "module.exports='DEP'" });
git(work, 'init', '-q', '-b', 'master', lib); git(lib, 'add', '-A'); git(lib, 'commit', '-q', '-m', 'base');
// The release line's story branch: its own change.
git(lib, 'checkout', '-q', '-b', 'AI-S-1-1.x'); writeFileSync(join(lib, 'line.txt'), 'BACK-PORT'); git(lib, 'commit', '-qam', 'fix on 1.x');
git(lib, 'checkout', '-q', 'master');

// The consumer, on the 1.x line: its installed release and its lane worktree.
const site = join(work, 'codelines', 'site');
pkg(site, { name: 'site', dependencies: { '@scope/lib': '^1.0.0' } }, { '.gitignore': 'node_modules\n' });
pkg(join(site, 'node_modules', '@scope', 'lib'), { name: '@scope/lib', version: '1.0.0', main: 'index.js' }, { 'index.js': "module.exports='RELEASE'" });
git(work, 'init', '-q', '-b', 'develop', site); git(site, 'add', '-A'); git(site, 'commit', '-q', '-m', 'base');
const wt = join(work, 'codelines', 'site-wt-primary');
git(site, 'worktree', 'add', '-q', '-b', 'wt-site', wt, 'HEAD');

const proj = join(work, 'project'); mkdirSync(proj);
writeFileSync(join(proj, 'dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules'] }));
const prd = join(work, 'prd.json');
writeFileSync(prd, JSON.stringify({ project: { outputDirs: [{ codeline: 'lib', path: lib }, { codeline: 'site', path: site }] },
  stories: [{ id: 'S-1', overallPlan: { codelines: [{ codeline: 'lib', part: 'p', order: 1 }, { codeline: 'site', part: 'none', order: 2 }],
    packages: [{ package: '@scope/lib', providedBy: 'lib', releaseLines: [{ line: '2.x', base: 'v2.0.0', version: '2.0.1', onCodelineBase: true }, { line: '1.x', base: 'v1.0.0', version: '1.0.1', onCodelineBase: false }],
      consumers: [{ codeline: 'site', declaredRange: '^1.0.0', receivesVia: '1.0.1', usage: [], change: 'none' }] }] } }] }));

const r = spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}; LOG_DIR=${JSON.stringify(work)}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
provision_lane_worktree ${JSON.stringify(site)} ${JSON.stringify(wt)}`],
{ encoding: 'utf8', env: { ...env0, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: proj, EPAM_BROWNFIELD: '1' } });
const line = join(work, 'codelines', 'lib-line-1.x');
const out = r.stdout + r.stderr;

describe('the release line the consumer receives is built as its own checkout is', () => {
  it('the line has its worktree, and its build ran there', () => {
    expect(existsSync(join(line, 'dist', 'where.txt')), out).toBe(true);
  });
  it('the build read its dependencies inside the line\'s own checkout — its output is laid out as the provider\'s is', () => {
    expect(readFileSync(join(line, 'dist', 'where.txt'), 'utf8')).toBe(join('node_modules', 'dep', 'index.js'));
  });
  it('its dependency directory is a real directory of hard links to the provider\'s install — nothing fetched or copied', () => {
    expect(lstatSync(join(line, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(statSync(join(line, 'node_modules', 'dep', 'index.js')).ino).toBe(statSync(join(lib, 'node_modules', 'dep', 'index.js')).ino);
  });
  it('the consumer worktree builds against the line\'s change; the provider\'s own checkout and install are untouched', () => {
    const got = spawnSync(process.execPath, ['-e', "process.stdout.write(require('@scope/lib'))"], { cwd: wt, encoding: 'utf8' }).stdout;
    expect(got, out).toBe('BACK-PORT');
    expect(git(lib, 'branch', '--show-current')).toBe('master');
    expect(existsSync(join(lib, 'dist')), 'the provider\'s own checkout was built').toBe(false);
    expect(lstatSync(join(lib, 'node_modules')).isSymbolicLink()).toBe(false);
  });
});

// The live estate: cx-shared-line-7.x was made by the earlier code — its node_modules a link, its broken build stamped
// as built for that commit. The next provisioning must make the directory real and build again.
describe('a line worktree an earlier run linked is made real and built again', () => {
  it('link replaced, build re-run, output laid out as the provider\'s', () => {
    rmSync(join(line, 'node_modules'), { recursive: true, force: true });
    execFileSync('ln', ['-s', join(lib, 'node_modules'), join(line, 'node_modules')]);
    writeFileSync(join(line, 'dist', 'where.txt'), '../lib/node_modules/dep/index.js');
    const again = spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}; LOG_DIR=${JSON.stringify(work)}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
provision_lane_worktree ${JSON.stringify(site)} ${JSON.stringify(wt)}`],
    { encoding: 'utf8', env: { ...env0, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: proj, EPAM_BROWNFIELD: '1' } });
    expect(lstatSync(join(line, 'node_modules')).isSymbolicLink(), again.stdout + again.stderr).toBe(false);
    expect(readFileSync(join(line, 'dist', 'where.txt'), 'utf8')).toBe(join('node_modules', 'dep', 'index.js'));
    expect(existsSync(join(lib, 'node_modules', 'dep', 'index.js')), 'the provider\'s own install was touched').toBe(true);
  });
});
