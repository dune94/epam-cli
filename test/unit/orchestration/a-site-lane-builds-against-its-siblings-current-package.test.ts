/**
 * A SITE LANE BUILDS AGAINST ITS SIBLING'S CURRENT PACKAGE — PACKED LOCALLY, NEVER SAVED, NO REGISTRY.
 *
 * 2026-10-02, AMSD-2974 (cx-shared changed, three sites consume it): the existing 2026-07-31
 * mechanism (_apply_local_dependency_overrides: `npm pack` the local source, `npm install <tgz>
 * --no-save`) ran once, at pre-flight — before cx-shared's writer had changed anything — and was
 * declared for one site. It now also runs at the start of each brownfield lane, so a site lane
 * installs the provider codeline's CURRENT checkout (its lane already merged); a relative
 * localSourcePath resolves against the folder the codelines live in.
 *
 * EXECUTED: the real function (lib/local-dependency-overrides.sh) and the real lane-start block of
 * run-agent-orchestration.sh, with a stand-in `npm` on PATH that records what it was asked.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const work = mkdtempSync(join(tmpdir(), 'local-override-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const codelines = join(work, 'codelines');
const provider = join(codelines, 'lib-repo'); mkdirSync(provider, { recursive: true });
writeFileSync(join(provider, 'package.json'), JSON.stringify({ name: '@scope/lib', version: '8.1.0' }));
const site = join(codelines, 'site.example'); mkdirSync(site, { recursive: true });
writeFileSync(join(site, 'package.json'), JSON.stringify({ name: 'site', dependencies: { '@scope/lib': '^7.0.0' } }));
const proj = join(work, 'project'); mkdirSync(proj);
writeFileSync(join(proj, 'dependency-check.json'), JSON.stringify({ localDependencyOverrides: [{ codeline: 'site.example', package: '@scope/lib', localSourcePath: 'lib-repo' }] }));

const calls = join(work, 'npm-calls.txt');
const bin = join(work, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'npm'), `#!/bin/bash
echo "$PWD :: $*" >> ${JSON.stringify(calls)}
if [ "$1" = "pack" ]; then d=""; for a in "$@"; do [ "$prev" = "--pack-destination" ] && d="$a"; prev="$a"; done; touch "$d/scope-lib-8.1.0.tgz"; fi
exit 0
`);
chmodSync(join(bin, 'npm'), 0o755);

const lane = (() => {
  const lines = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8').split('\n');
  const s = lines.findIndex((l) => l.includes('# THE LANE BUILDS AGAINST ITS SIBLINGS'));
  const e = lines.findIndex((l, i) => i > s && l.includes('# END THE LANE BUILDS AGAINST ITS SIBLINGS'));
  expect(s, 'lane-start block not found').toBeGreaterThan(-1);
  return lines.slice(s, e).join('\n');
})();

function runLane(extra: Record<string, string>) {
  rmSync(calls, { force: true });
  return spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ :; }; success(){ :; }
source ${JSON.stringify(join(SCRIPTS, 'lib/local-dependency-overrides.sh'))}
${lane}`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EPAM_PROJECT_CONFIG_DIR: proj, PROJECT_ROOT: site, JIRA_CODELINE_RUN: '1', EPAM_BROWNFIELD: '1', ...extra } });
}

describe('a site lane builds against its sibling\'s current package', () => {
  it('packs the provider codeline (relative path resolved beside the site) and installs it without saving', () => {
    const r = runLane({});
    expect(existsSync(calls), r.stderr).toBe(true);
    const c = readFileSync(calls, 'utf8');
    expect(c).toContain(`${provider} :: pack`);
    expect(c).toMatch(new RegExp(`${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} :: install .*@scope/lib@file:.*scope-lib-8.1.0.tgz.*--no-save`));
    expect(JSON.parse(readFileSync(join(site, 'package.json'), 'utf8')).dependencies['@scope/lib']).toBe('^7.0.0');
  });

  it('a lane whose codeline declares nothing is untouched', () => {
    const r = runLane({ PROJECT_ROOT: provider });
    expect(existsSync(calls), r.stderr).toBe(false);
  });

  it('greenfield: never', () => {
    runLane({ EPAM_BROWNFIELD: '0' });
    expect(existsSync(calls)).toBe(false);
  });
});
