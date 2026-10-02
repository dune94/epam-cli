/**
 * A BROWNFIELD LANE WORKTREE IS PROVISIONED FROM ITS CODELINE — NEVER BY INSTALLING FROM A REGISTRY.
 *
 * 2026-10-02, AMSD-2974: `git worktree add` checks out tracked files only. The lane worktree had no
 * .epam/ (the pipeline's provisioned, untracked declaration), no provisioned env file and no vendor
 * directory, so verification would have run the declared install — against a client's private
 * registry (not permitted, and 401 here). The baseline gates already solve this for their own
 * worktrees (lib/tsc-baseline-gate.sh): copy .epam/, link the vendor directory. The lane does the same,
 * linking only the vendor directory provisioning populates (vendorDirs[0]) so build output stays in
 * the worktree.
 *
 * EXECUTED: the real provision_lane_worktree (lib/codeline-lanes.sh) on a real git worktree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const work = mkdtempSync(join(tmpdir(), 'lane-wt-prov-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();

const root = join(work, 'site');
execFileSync('git', ['init', '-q', '-b', 'develop', root], { env });
writeFileSync(join(root, '.gitignore'), 'node_modules\nbuild\n.env.local\n');
writeFileSync(join(root, '.env.local.sample'), 'A=1\n');
git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base');
mkdirSync(join(root, '.epam'));
writeFileSync(join(root, '.epam', 'dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules', 'build'], provisionCommand: 'install-from-registry' }));
mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true });
mkdirSync(join(root, 'build'));
const wt = join(work, 'site-wt-primary');
git(root, 'worktree', 'add', '-q', '-b', 'wt-primary', wt, 'HEAD');

const r = spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }
source ${JSON.stringify(join(SCRIPTS, 'lib/tsc-baseline-gate.sh'))} 2>/dev/null
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
provision_lane_worktree ${JSON.stringify(root)} ${JSON.stringify(wt)}`], { encoding: 'utf8', env: { ...env, EPAM_PROJECT_CONFIG_DIR: '' } });

describe('a brownfield lane worktree is provisioned from its codeline', () => {
  it('ran', () => { expect(r.status, r.stderr).toBe(0); });
  it('carries the pipeline\'s declaration (.epam/)', () => {
    expect(JSON.parse(readFileSync(join(wt, '.epam', 'dependency-check.json'), 'utf8')).provisionCommand).toBe('install-from-registry');
  });
  it('has the provisioning vendor directory, linked to the codeline\'s — so nothing installs', () => {
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(wt, 'node_modules'))).toBe(realpathSync(join(root, 'node_modules')));
  });
  it('does NOT link build output — a build in the worktree stays in the worktree', () => {
    expect(existsSync(join(wt, 'build'))).toBe(false);
  });
  it('has its env file, provisioned from its own sample', () => {
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toMatch(/^A=/m);
  });
  it('leaves nothing in the worktree the checkout does not also carry untracked (.epam/ only)', () => {
    expect(git(wt, 'status', '--porcelain').split('\n').filter(Boolean)).toEqual(['?? .epam/']);
  });
});
