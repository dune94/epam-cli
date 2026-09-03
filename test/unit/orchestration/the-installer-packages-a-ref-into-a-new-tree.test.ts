import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * install.sh --dest IS WHAT MAKES THIS AN INSTALLER FOR SOMEONE WHO IS NOT THIS CHECKOUT.
 *
 * Without it, install.sh only ever configures a tree that already exists — which presupposes the
 * code arrived by some hand-run means (a manual `git archive`, done by a human or an LLM standing
 * in for one, every single time this session). --dest packages a REF into a fresh tree itself, then
 * runs the rest of the install against it.
 *
 * REAL git repos, not stubs: the actual defect this caught was `git archive` scoping its output to
 * the CURRENT WORKING DIRECTORY'S subtree, not the whole repo — running it via `git -C
 * $INSTALLER_DIR archive` (INSTALLER_DIR being orchestrations-installer/, a SUBDIRECTORY) silently
 * archived only install.sh and lib/, dropping the entire rest of the pipeline. Found by actually
 * running the packaged result and watching the very next step fail, not by reading git-archive's
 * docs and assuming. A fixture with fake docker/podman binaries (the pattern used elsewhere in this
 * file) cannot catch this class of bug — only a real git repo with install.sh in a subdirectory of
 * it, exactly as this codebase is laid out, can.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER_REL = 'orchestrations-installer/install.sh';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A real, minimal git repo laid out the SAME way as this one: install.sh in a subdirectory, real
 * pipeline files at the repo root. */
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-pkg-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);

  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });

  const installerSrc = fs.readFileSync(path.join(REPO, INSTALLER_REL), 'utf8');
  fs.writeFileSync(path.join(dir, INSTALLER_REL), installerSrc);
  fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
  for (const f of ['container-runtime.sh', 'wait-for-health.sh', 'isolated-compose-identity.sh', 'generate-env-example.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json', 'env-vars.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'GITHUB_PERSONAL_ACCESS_TOKEN=\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  // A REAL pipeline file at the ROOT, sibling to (not inside) orchestrations-installer/ — this is
  // exactly what the subdirectory-scoping bug silently dropped.
  fs.writeFileSync(path.join(dir, 'a-real-pipeline-file.txt'), 'this must survive packaging\n');

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  git(dir, ['tag', 'v1.0-test']);

  return dir;
}

function run(repoDir: string, args: string[]) {
  return execFileSync('bash', [path.join(repoDir, INSTALLER_REL), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(repoDir, 'bin-shim') },
  });
}

describe('install.sh --dest packages a ref into a NEW tree', () => {
  it('the packaged tree contains the WHOLE repo, not just orchestrations-installer/', () => {
    // THE ACTUAL REGRESSION: this must include a-real-pipeline-file.txt, which lives OUTSIDE
    // orchestrations-installer/ — the exact content the subdirectory-scoping bug dropped.
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    let out = '';
    try {
      out = run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    } catch (e: any) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(fs.existsSync(path.join(dest, 'a-real-pipeline-file.txt')),
      `packaging dropped root-level content:\n${out.slice(-800)}`).toBe(true);
    expect(fs.existsSync(path.join(dest, 'orchestrations/config/provider-sets.json')),
      `packaging dropped orchestrations/:\n${out.slice(-800)}`).toBe(true);
  });

  it('installs INTO the packaged tree, not the original checkout', () => {
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    expect(fs.existsSync(path.join(dest, '.env')), 'the install ran against the wrong tree').toBe(true);
    expect(fs.existsSync(path.join(repo, '.env')), 'the ORIGINAL checkout was modified — it must not be').toBe(false);
  });

  it('a ref that does not exist fails loudly, never silently packaging HEAD instead', () => {
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    expect(() => run(repo, ['--dest', dest, '--ref', 'no-such-ref-exists', '--no-docker'])).toThrow();
    expect(fs.existsSync(path.join(dest, 'package.json')),
      'packaged something despite the ref not existing').toBe(false);
  });

  it('refuses --dest when not run from inside a git checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-nogit-'));
    fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO, INSTALLER_REL), path.join(dir, INSTALLER_REL));
    fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    expect(() => run(dir, ['--dest', dest, '--no-docker'])).toThrow();
  });

  it('with no --dest, behaves exactly as before — configures the tree it is sitting in', () => {
    const repo = fixtureRepo();
    const out = run(repo, ['--no-docker']);
    expect(fs.existsSync(path.join(repo, '.env')), `no --dest must install in place:\n${out.slice(-800)}`).toBe(true);
  });
});
