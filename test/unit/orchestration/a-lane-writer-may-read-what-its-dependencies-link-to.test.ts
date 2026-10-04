/**
 * A LANE WRITER MAY READ WHAT ITS DEPENDENCIES LINK TO.
 *
 * AMSD-2974 live, 2026-10-04, gotransit lane: the worktree's dependency directory links into the
 * codeline's own install, and its sibling package (cx-shared) into that codeline's checkout — both
 * outside the worktree. The Copilot CLI grants reads only under its working directory and the
 * --add-dir roots (EPAM_READ_ROOTS); neither link target was granted, so the writer "crashed trying
 * to read symlinked node_modules/@metrolinx/cx-shared (outside project root)" on attempt after attempt.
 *
 * _declared_read_roots now also grants, for a codeline the agent works in, the checkout its worktree
 * belongs to and every sibling provider's checkout — from git and the story's own data
 * (sibling-providers.js), as the dependency facts are derived. EXECUTED: the real function.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const fn = (() => {
  const s = readFileSync(join(ORCH, 'scripts/lib/story-attempt.sh'), 'utf8').split('\n');
  const a = s.findIndex((l) => /^_declared_read_roots\(\) \{/.test(l));
  const b = s.findIndex((l, i) => i > a && l === '}');
  return s.slice(a, b + 1).join('\n');
})();

function estate() {
  const base = mkdtempSync(join(tmpdir(), 'read-roots-')); dirs.push(base);
  const lib = join(base, 'lib-codeline'); const site = join(base, 'site-codeline');
  for (const [d, pkg] of [[lib, { name: '@est/lib-pkg' }], [site, { name: 'site', dependencies: { '@est/lib-pkg': '^1' } }]] as const) {
    mkdirSync(d); git(base, ['init', '-q', '-b', 'develop', d]);
    git(d, ['config', 'user.email', 't@t']); git(d, ['config', 'user.name', 't']);
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkg)); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'b']);
  }
  const wt = join(base, 'site-codeline-lane'); git(site, ['worktree', 'add', '-q', '-b', 'lane', wt]);
  const prd = join(base, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { outputDirs: [{ codeline: 'libline', path: lib }, { codeline: 'siteline', path: site }] }, stories: [] }));
  return { base, lib, site, wt, prd };
}

const roots = (prd: string, projectRoot: string) => spawnSync('bash', ['-c', `${fn}\n_declared_read_roots ${JSON.stringify(prd)}`],
  { encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: projectRoot, SCRIPT_DIR: join(ORCH, 'scripts'), NODE_BIN: process.execPath } })
  .stdout.split('\n').filter(Boolean);

describe('a lane writer may read what its dependencies link to', () => {
  it('in a site lane worktree: its own checkout and the sibling provider\'s checkout are granted', () => {
    const { lib, site, wt, prd } = estate();
    const r = roots(prd, wt);
    expect(r, r.join('\n')).toContain(site);
    expect(r).toContain(lib);
    expect(r, 'the working directory itself needs no grant').not.toContain(wt);
  });

  it('in a codeline with no sibling package and no worktree: nothing extra', () => {
    const { lib, prd } = estate();
    expect(roots(prd, lib)).toEqual([]);
  });
});
