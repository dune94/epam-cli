/**
 * A SITE LANE'S WORKTREE BUILDS AGAINST ITS SIBLING'S CHANGE — NOTHING INSTALLED, PACKED OR FETCHED.
 *
 * Operator, 2026-10-03: no npm install, no registry, nothing published — "shared gets updated then
 * dependent codelines get the branch". A site lane must test against the shared library's change on
 * its story branch, not the release it has installed, without touching the site's own checkout:
 * its baseline keeps the installed release, so a reproducing test still fails on baseline.
 *
 * The worktree gets its OWN vendor directory: a link to every entry of the codeline's, except the
 * sibling's package, which links to the sibling's checkout after the sibling's OWN declared build ran
 * there (its ecosystem's buildCommand — the only npm verb allowed is `run`).
 *
 * EXECUTED: the real provision_lane_worktree (lib/codeline-lanes.sh), the real handlers, real git,
 * real npm for the build only — behind a tripwire that fails on any other npm verb.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const work = mkdtempSync(join(tmpdir(), 'sibling-build-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const env0 = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: env0 }).trim();
const pkg = (dir: string, json: object, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
};

// The shared library, changed on its story branch: its build writes what it ships.
const lib = join(work, 'codelines', 'lib');
pkg(lib, { name: '@scope/lib', version: '2.0.0', main: 'dist/index.js', scripts: { build: 'node build.js' } },
  { 'build.js': "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js',\"module.exports='NEW'\")" });

// A site: declares the library; its installed vendor dir holds the RELEASE and other packages.
function site(name: string, declaresLib: boolean) {
  const root = join(work, 'codelines', name);
  pkg(root, { name, dependencies: declaresLib ? { '@scope/lib': '^1.0.0', other: '^1.0.0' } : { other: '^1.0.0' } }, { '.gitignore': 'node_modules\n' });
  pkg(join(root, 'node_modules', '@scope', 'lib'), { name: '@scope/lib', version: '1.0.0', main: 'index.js' }, { 'index.js': "module.exports='OLD'" });
  pkg(join(root, 'node_modules', '@scope', 'kit'), { name: '@scope/kit', version: '1.0.0', main: 'index.js' }, { 'index.js': "module.exports='KIT'" });
  pkg(join(root, 'node_modules', 'other'), { name: 'other', version: '1.0.0', main: 'index.js' }, { 'index.js': "module.exports='OTHER'" });
  git(work, 'init', '-q', '-b', 'develop', root); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const wt = join(work, 'codelines', `${name}-wt-primary`);
  git(root, 'worktree', 'add', '-q', '-b', `wt-${name}`, wt, 'HEAD');
  return { root, wt };
}

// The npm tripwire: `run` passes through to the real npm; any other verb is recorded and refused.
const bin = join(work, 'bin'); mkdirSync(bin);
const npmLog = join(work, 'npm.log');
const realNpm = spawnSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(npmLog)}\n[ "$1" = run ] || { echo "TRIPWIRE: npm $1 refused" >&2; exit 97; }\nexec ${JSON.stringify(realNpm)} "$@"\n`);
chmodSync(join(bin, 'npm'), 0o755);

const proj = join(work, 'project'); mkdirSync(proj);
writeFileSync(join(proj, 'dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules'] }));

function provision(s: { root: string; wt: string }, prd: string) {
  return spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
provision_lane_worktree ${JSON.stringify(s.root)} ${JSON.stringify(s.wt)}`],
  { encoding: 'utf8', env: { ...env0, PATH: `${bin}:${process.env.PATH}`, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: proj, EPAM_BROWNFIELD: '1' } });
}
const resolveIn = (cwd: string, id: string) => spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(id)})))`], { cwd, encoding: 'utf8' }).stdout;

const consumer = site('site-a', true);
const plain = site('site-b', false);
const prd = join(work, 'prd.json');
writeFileSync(prd, JSON.stringify({ project: { outputDirs: [
  { codeline: 'lib', path: lib }, { codeline: 'sitea', path: consumer.root }, { codeline: 'siteb', path: plain.root }] } }));

describe('a site worktree builds against its sibling\'s change without installing', () => {
  const r = provision(consumer, prd);

  it('the consumer worktree resolves the sibling package to the sibling\'s NEW build', () => {
    expect(resolveIn(consumer.wt, '@scope/lib'), r.stdout + r.stderr).toBe('NEW');
  });
  it('every other package still comes from the codeline\'s own install', () => {
    expect(resolveIn(consumer.wt, '@scope/kit')).toBe('KIT');
    expect(resolveIn(consumer.wt, 'other')).toBe('OTHER');
  });
  it('the codeline\'s own checkout is untouched: its baseline still has the release', () => {
    expect(lstatSync(join(consumer.root, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(resolveIn(consumer.root, '@scope/lib')).toBe('OLD');
    expect(git(consumer.root, 'status', '--porcelain')).toBe('');
  });
  it('npm was only ever asked to run the sibling\'s own build — nothing installed, packed or fetched', () => {
    const calls = existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    expect(calls.length, 'the sibling was never built').toBeGreaterThan(0);
    for (const c of calls) expect(c, `npm ${c}`).toMatch(/^run build\b/);
    expect(r.stderr).not.toContain('TRIPWIRE');
  });
  it('_link_entry replaces only a link it made — a real directory is never removed', () => {
    const at = join(work, 'link-entry'); mkdirSync(join(at, 'real-dir', 'keep'), { recursive: true });
    const r2 = spawnSync('bash', ['-c', `warning(){ echo "WARN $*" >&2; }
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
_link_entry ${JSON.stringify(join(at, 'real-dir'))} ${JSON.stringify(lib)}; echo "rc=$?"
ln -s /nonexistent ${JSON.stringify(join(at, 'a-link'))}
_link_entry ${JSON.stringify(join(at, 'a-link'))} ${JSON.stringify(lib)}; echo "rc=$?"
_link_entry "" ${JSON.stringify(lib)}; echo "rc=$?"`], { encoding: 'utf8' });
    const rcs = r2.stdout.trim().split('\n');
    expect(rcs[0], 'a real directory must be refused').toBe('rc=1');
    expect(existsSync(join(at, 'real-dir', 'keep')), 'the real directory was removed').toBe(true);
    expect(rcs[1]).toBe('rc=0');
    expect(realpathSync(join(at, 'a-link'))).toBe(realpathSync(lib));
    expect(rcs[2], 'an empty path must be refused').toBe('rc=1');
  });

  it('a site that declares no sibling package keeps the plain link to its own vendor dir', () => {
    provision(plain, prd);
    expect(lstatSync(join(plain.wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(plain.wt, 'node_modules'))).toBe(realpathSync(join(plain.root, 'node_modules')));
  });
});
