import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * install.sh --workflows (orchestrations-installer/lib/claude-workflows.sh): the Claude workflows package, unpacked into
 * <root>/claude-workflows/ with install.json naming the install; --check verifies it. Run against the shell library with a
 * real tarball (npm pack's layout: a package/ folder) and, for the pinned version, a stand-in `npm` that packs it — no
 * registry is reached.
 */
const LIB = path.resolve(__dirname, '../../../orchestrations-installer/lib/claude-workflows.sh');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'install-workflows-'));

function tarball(version: string) {
  const d = fs.mkdtempSync(path.join(T, 'pkg-'));
  fs.mkdirSync(path.join(d, 'package', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify({ name: 'amsd-pipeline-workflow', version }));
  fs.writeFileSync(path.join(d, 'package', 'bin', 'amsd-pipeline-workflow.js'), '// PLANTED-WORKFLOW-BIN\n');
  const tgz = path.join(d, `amsd-pipeline-workflow-${version}.tgz`);
  expect(spawnSync('tar', ['-czf', tgz, '-C', d, 'package']).status).toBe(0);
  return tgz;
}

function root(pinned?: { package: string; version: string }) {
  const r = fs.mkdtempSync(path.join(T, 'root-'));
  fs.mkdirSync(path.join(r, 'orchestrations', 'config'), { recursive: true });
  if (pinned) fs.writeFileSync(path.join(r, 'orchestrations', 'config', 'claude-workflows.json'), JSON.stringify(pinned));
  return r;
}

function call(r: string, spec: string, check: '0' | '1', env: Record<string, string> = {}) {
  const res = spawnSync('bash', ['-c', `_ok(){ echo "OK $*"; }; _bad(){ echo "BAD $*" >&2; }; . ${JSON.stringify(LIB)}; install_claude_workflows "$@"`, '--', r, spec, check],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

// a stand-in npm: `npm pack --silent <pkg>@<ver>` writes that version's tarball into the cwd, and records what it was asked
let fakeBin = ''; let asked = '';
beforeAll(() => {
  fakeBin = fs.mkdtempSync(path.join(T, 'bin-')); asked = path.join(fakeBin, 'asked');
  const src = tarball('0.1.0');
  fs.writeFileSync(path.join(fakeBin, 'npm'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(asked)}\n[ "$1" = pack ] || exit 1\ncp ${JSON.stringify(src)} "$PWD/"\n`, { mode: 0o755 });
});

describe('install.sh --workflows', () => {
  it('a local package: unpacked into <root>/claude-workflows, install.json names the install, --check passes', () => {
    const r = root({ package: 'amsd-pipeline-workflow', version: '0.1.0' });
    const res = call(r, tarball('0.2.0-local'), '0');
    expect(res.status, res.err).toBe(0);
    const dir = path.join(r, 'claude-workflows');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0-local');
    expect(fs.readFileSync(path.join(dir, 'bin', 'amsd-pipeline-workflow.js'), 'utf8')).toContain('PLANTED-WORKFLOW-BIN');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')).install).toBe(r);
    expect(call(r, 'local', '1').status).toBe(0);
  });

  it('the pinned version: npm is asked for exactly the declared package@version; a reinstall replaces the folder', () => {
    const r = root({ package: 'amsd-pipeline-workflow', version: '0.1.0' });
    fs.mkdirSync(path.join(r, 'claude-workflows'), { recursive: true });
    fs.writeFileSync(path.join(r, 'claude-workflows', 'STALE'), 'x');
    const res = call(r, 'pinned', '0', { PATH: `${fakeBin}:${process.env.PATH}` });
    expect(res.status, res.err).toBe(0);
    expect(fs.readFileSync(asked, 'utf8')).toContain('pack --silent amsd-pipeline-workflow@0.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(r, 'claude-workflows', 'package.json'), 'utf8')).version).toBe('0.1.0');
    expect(fs.existsSync(path.join(r, 'claude-workflows', 'STALE'))).toBe(false);
    expect(call(r, 'pinned', '1').status).toBe(0);
  });

  it('NEGATIVE: --check fails when the installed version is not the one the release pins, or nothing is installed', () => {
    const r = root({ package: 'amsd-pipeline-workflow', version: '0.1.0' });
    expect(call(r, 'pinned', '1').status).not.toBe(0);
    expect(call(r, tarball('0.0.9'), '0').status).toBe(0);
    const c = call(r, 'pinned', '1');
    expect(c.status).not.toBe(0);
    expect(c.err).toMatch(/0\.0\.9.*0\.1\.0/);
  });

  it('NEGATIVE: no declaration and no local package — refused, nothing written', () => {
    const r = root();
    const res = call(r, 'pinned', '0', { PATH: `${fakeBin}:${process.env.PATH}` });
    expect(res.status).not.toBe(0);
    expect(fs.existsSync(path.join(r, 'claude-workflows'))).toBe(false);
    expect(call(r, path.join(T, 'missing.tgz'), '0').status).not.toBe(0);
    expect(fs.existsSync(path.join(r, 'claude-workflows'))).toBe(false);
  });
});
