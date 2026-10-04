/**
 * A BROWNFIELD AGENT IS TOLD HOW ITS DEPENDENCIES RESOLVE — from the story's own data, in its SI.
 *
 * AMSD-2974, 2026-10-03/04: no agent was told that a lane builds against the codeline's existing
 * install (linked, nothing fetched), or that a package another codeline of the story provides
 * already resolves to that codeline's change. The writer added @types/node to a client package.json
 * from the registry; the gotransit detective prescribed "bump to ^8.10.0, then npm install".
 *
 * Operator-approved 2026-10-04: one section at the single SI channel every agent uses
 * (lib/agent-si.js composedSi), brownfield runs only; the sibling line only when the story has sibling
 * packages, generated from the PRD and the codelines' manifests — no codeline or package name in
 * config or code. EXECUTED: the real agent-si.js CLI, as every runner invokes it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const AGENT_SI = join(ORCH, 'scripts/lib/agent-si.js');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A story spanning a shared library and a site that declares it; the site's lane worktree. */
function estate(siteDeclaresLib: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'dep-facts-')); dirs.push(base);
  const lib = join(base, 'lib-codeline'); const site = join(base, 'site-codeline');
  for (const [dir, pkg] of [[lib, { name: '@est/lib-pkg', version: '2.0.0' }],
    [site, { name: 'site', version: '1.0.0', dependencies: siteDeclaresLib ? { '@est/lib-pkg': '^1.0.0' } : { other: '^1' } }]] as const) {
    mkdirSync(dir); git(base, ['init', '-q', '-b', 'develop', dir]);
    git(dir, ['config', 'user.email', 't@t.t']); git(dir, ['config', 'user.name', 't']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg)); git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'base']);
  }
  const wt = join(base, 'site-codeline-lane'); git(site, ['worktree', 'add', '-q', '-b', 'lane', wt]);
  const prd = join(base, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { outputDirs: [{ codeline: 'libline', path: lib }, { codeline: 'siteline', path: site }] }, stories: [] }));
  const cfg = join(base, 'cfg'); mkdirSync(cfg);
  return { wt, prd, cfg, base };
}

function siFor(env: Record<string, string>, cfg: string) {
  const out = join(cfg, 'si.txt');
  const r = spawnSync(process.execPath, [AGENT_SI, 'story-writer', cfg, out], { encoding: 'utf8', env: { ...process.env, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(out, 'utf8');
}

/** Every file under a directory, for the no-literal check. */
const filesUnder = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f); return statSync(p).isDirectory() ? filesUnder(p) : [p];
});

describe('a brownfield agent is told how its dependencies resolve', () => {
  it('in a lane of a story with a sibling package: the dependency facts, and the sibling line from the story\'s data', () => {
    const { wt, prd, cfg } = estate(true);
    const si = siFor({ EPAM_BROWNFIELD: '1', PRD_FILE: prd, PROJECT_ROOT: wt }, cfg);
    expect(si, 'not the writer\'s SI').toMatch(/AGENT BEHAVIORAL CONTRACT/);
    expect(si).toMatch(/existing install/i);
    expect(si).toMatch(/never install, upgrade or add a package/i);
    expect(si).toMatch(/manifest or lockfile change is not part of a fix/i);
    expect(si).toMatch(/`@est\/lib-pkg` — the libline codeline/);
    expect(si).toMatch(/never change their version range or reinstall/i);
    expect(si, 'an absolute path in an SI').not.toContain(wt);
  });

  it('a story with no sibling package gets the dependency facts and no sibling line', () => {
    const { wt, prd, cfg } = estate(false);
    const si = siFor({ EPAM_BROWNFIELD: '1', PRD_FILE: prd, PROJECT_ROOT: wt }, cfg);
    expect(si).toMatch(/existing install/i);
    expect(si).not.toMatch(/already resolve to the change another codeline/i);
    expect(si).not.toContain('{siblingPackages}');
  });

  it('a greenfield run gets none of it', () => {
    const { wt, prd, cfg } = estate(true);
    const si = siFor({ EPAM_BROWNFIELD: '0', PRD_FILE: prd, PROJECT_ROOT: wt }, cfg);
    expect(si).toMatch(/AGENT BEHAVIORAL CONTRACT/);
    expect(si).not.toMatch(/existing install|already resolve to the change another codeline/i);
  });

  it('no codeline or package of any project is named in the engine\'s config or code for this', () => {
    const c = JSON.parse(readFileSync(join(ORCH, 'config/agent-contract.json'), 'utf8'));
    const mine = JSON.stringify([c.brownfieldDependencies, c.brownfieldSiblingPackages]);
    expect(mine, 'the sections are not declared').toMatch(/existing install/);
    for (const lit of ['cx-shared', '@metrolinx', 'gotransit', 'upexpress', 'node_modules', 'npm', 'package.json']) {
      expect(mine, `the dependency sections name ${lit} — a stack or project fact`).not.toContain(lit);
    }
    for (const f of [join(ORCH, 'scripts/lib/agent-contract.js'), join(ORCH, 'scripts/lib/agent-si.js')]) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/cx-shared|@metrolinx|gotransit|upexpress/);
    }
  });
});
